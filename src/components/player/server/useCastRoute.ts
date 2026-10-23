import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { reportPlayback } from "@/lib/reportPlayback";
import { castEndedFields, castEstablishedFields, castResumeFields, type ServerPlayerContext } from "@/lib/serverPlayerLog";
import { castHandBackPosition } from "@/lib/useStableFallback";
import type { CastResume } from "@/lib/castResume";
import { castRouteActive } from "@/lib/castRoute";
import type { WatchedClock } from "@/lib/playerSessionTally";

/**
 * Ce que WebKit ajoute à un élément vidéo et que `lib.dom` ne décrit pas — même raison que le
 * type jumeau de `PlayerControls`, qui n'en connaît que la moitié dont il se sert.
 */
interface CastCapableVideo extends HTMLVideoElement {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
}

/**
 * La diffusion, d'un bout à l'autre : ouvrir le sélecteur, puis guetter sa fin.
 *
 * **L'ouverture.** Les navigateurs n'ouvrent un sélecteur d'appareils que dans la fenêtre
 * d'activation d'un vrai geste — sinon n'importe quel site ferait apparaître « Diffuser vers… »
 * sans qu'on ait rien demandé. Entre l'appui du spectateur et cet instant, il y a eu une bascule
 * de lecteur et un aller-retour avec Jellyfin ; la fenêtre est peut-être fermée. On tente
 * quand même : Chrome accorde quelques secondes et laissera passer, et là où c'est refusé, le
 * bouton reste en évidence pour un second appui — qui, lui, portera sa propre activation.
 *
 * **La fin.** Elle peut venir de trois endroits : cette page, le centre de contrôle du
 * téléphone, ou le téléviseur lui-même. Seul l'événement les couvre tous les trois. WebKit le
 * dit par `webkitcurrentplaybacktargetiswirelesschanged`, l'API standard par les changements
 * d'état de `remote`. On rend alors la main au lecteur natif, à la position atteinte.
 *
 * Non détecté, on **reste** sur ce lecteur : le pire cas est le comportement d'avant, jamais
 * pire. C'est ce qui permet de tenter le retour sans risquer d'y perdre la lecture.
 *
 * Les références et le setter reçus sont ceux de l'hôte, stables : listés dans les dépendances
 * pour la règle, ils ne réarment rien de plus que les six d'origine.
 */
export function useCastRoute({
  videoRef,
  videoKey,
  castSession,
  castAttempted: castAttemptedRef,
  closingRef,
  castActiveRef,
  setCastActive,
  logContext,
  watched,
  castResume,
  markHandedOver,
  onCastEnded,
  lastKnownTime,
  lastPlaybackOpts,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  videoKey: number;
  castSession: boolean;
  castAttempted: RefObject<boolean>;
  closingRef: RefObject<boolean>;
  castActiveRef: RefObject<boolean>;
  setCastActive: Dispatch<SetStateAction<boolean>>;
  logContext: RefObject<ServerPlayerContext>;
  watched: WatchedClock;
  castResume: CastResume;
  markHandedOver: () => void;
  onCastEnded?: (resumeAt: number, paused?: boolean) => void;
  lastKnownTime: RefObject<number>;
  lastPlaybackOpts: RefObject<{ resumeAt?: number } | undefined>;
}): void {
  useEffect(() => {
    const video = videoRef.current as CastCapableVideo | null;
    // Écouté dans toutes les séances de ce lecteur, pas seulement celles ouvertes pour diffuser
    // (24/09/2026). Le bouton AirPlay des commandes de la vidéo marche partout : un film rouvert
    // sur ce lecteur, puis envoyé à la télé de là, a joué vingt-sept minutes sur un téléviseur —
    // le relais voyait l'appareil AirPlay chercher chaque morceau — pendant que le journal disait
    // « sans diffusion », faute d'écouteur. Hors séance de diffusion, rien d'autre ne change : ni
    // sélecteur ouvert d'office, ni main rendue au lecteur natif à la fin.
    if (!video) return;

    const openPicker = () => {
      if (castAttemptedRef.current) return;
      castAttemptedRef.current = true;
      try {
        if (typeof video.webkitShowPlaybackTargetPicker === "function") video.webkitShowPlaybackTargetPicker();
        else void video.remote?.prompt().catch(() => {});
      } catch {
        // Refusé faute d'activation : le bouton du menu reste, et son appui en portera une.
      }
    };
    // Dès que l'image est là — pas avant : un sélecteur ouvert sur un élément sans source ne
    // propose rien à quoi se connecter.
    if (castSession) {
      if (video.readyState >= 1) openPicker();
      else video.addEventListener("loadedmetadata", openPicker, { once: true });
    }

    /**
     * Rendre la main, en disant d'où vient la décision.
     *
     * Sans cette ligne, une diffusion qui s'arrête ne laisse aucune trace : le journal ne montre
     * que le lecteur natif qui redémarre, sans dire si c'est le téléviseur qui a lâché, le centre
     * de contrôle du téléphone, ou nous. C'est précisément ce qui a coûté une demi-journée à
     * comprendre le 19/09/2026, et la question se reposera.
     */
    const ended = (source: string) => {
      // Provoquée par la croix : la séance est déjà close, et la rendre au téléphone rouvrirait le
      // lecteur natif pendant la fermeture.
      if (closingRef.current) return;
      // Avec la séance et la marque de diffusion : sans elles, la ligne se rangeait dans une séance
      // « reconstituée » et comptait comme un repli raté sur la page Activité (24/09/2026).
      // Avec le temps joué jusque-là, pris et remis à zéro : le lecteur est démonté juste après s'il
      // avait été ouvert pour diffuser, et sinon son `stop` ne comptera que la suite.
      reportPlayback("fallback", castEndedFields(logContext.current, source, video.currentTime || 0, watched.take(Date.now())));
      // En pause : la route est tombée sans que personne ne demande à continuer sur le téléphone.
      if (castSession) {
        markHandedOver();
        onCastEnded?.(castHandBackPosition(video.currentTime, lastKnownTime.current, lastPlaybackOpts.current?.resumeAt), true);
      }
    };
    // La reprise que la route vient peut-être d'emporter à 0, reposée quand la télé joue — voir
    // `CastResume`. Une fois par établissement, et retirée avec les autres écouteurs.
    let resumeOnTv: (() => void) | null = null;
    const armCastResume = () => {
      if (resumeOnTv) video.removeEventListener("playing", resumeOnTv);
      resumeOnTv = () => {
        if (resumeOnTv) video.removeEventListener("playing", resumeOnTv);
        resumeOnTv = null;
        const from = video.currentTime || 0;
        const target = castResume.take(from);
        if (target === null) return;
        reportPlayback("cast", castResumeFields(logContext.current, from, target));
        try {
          video.currentTime = target;
        } catch {
          /* la télé garde sa position ; le spectateur peut encore y aller lui-même */
        }
      };
      video.addEventListener("playing", resumeOnTv);
      // Déjà en train de jouer : la télé a fini de charger avant que la route ne se dise établie.
      if (!video.paused && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) resumeOnTv();
    };
    const setActive = (active: boolean) => {
      // Établie, et pas seulement demandée : sans cette ligne, un téléviseur resté en chargement
      // ne se distinguait pas d'un téléviseur qui jouait (22/09/2026).
      if (active && !castActiveRef.current) {
        reportPlayback("cast", castEstablishedFields(logContext.current, video.currentTime || 0, castResume.pending));
        if (castResume.pending !== null) armCastResume();
      }
      castActiveRef.current = active;
      setCastActive(active);
    };
    const onWirelessChanged = () => {
      const wireless = video.webkitCurrentPlaybackTargetIsWireless === true;
      // Ne rend la main que si quelque chose diffusait : l'événement se déclenche aussi en
      // arrivant, et un « faux » de départ n'est pas une diffusion qui s'arrête.
      const wasActive = castActiveRef.current;
      setActive(wireless);
      if (!wireless && wasActive) ended("route sans fil perdue");
    };
    const onConnect = () => setActive(true);
    const onDisconnect = () => {
      const wasActive = castActiveRef.current;
      setActive(false);
      if (wasActive) ended("appareil distant déconnecté");
    };
    video.addEventListener("webkitcurrentplaybacktargetiswirelesschanged", onWirelessChanged);
    video.remote?.addEventListener?.("connect", onConnect);
    video.remote?.addEventListener?.("disconnect", onDisconnect);
    // Une route déjà établie ne se signale plus : l'écouteur arrive après l'événement quand le
    // lecteur est remonté pendant la diffusion (une relance, l'épisode suivant). Lue une fois ici.
    if (castRouteActive(video)) setActive(true);

    return () => {
      if (resumeOnTv) video.removeEventListener("playing", resumeOnTv);
      video.removeEventListener("loadedmetadata", openPicker);
      video.removeEventListener("webkitcurrentplaybacktargetiswirelesschanged", onWirelessChanged);
      video.remote?.removeEventListener?.("connect", onConnect);
      video.remote?.removeEventListener?.("disconnect", onDisconnect);
    };
    // Les lignes du journal se nomment par `logContext`, lu au moment d'écrire : ni le titre ni
    // l'épisode ne sont des dépendances, et un changement d'épisode ne réarme pas les écouteurs —
    // ce qui perdrait la route en cours.
  }, [castSession, onCastEnded, videoKey, watched, castResume, markHandedOver, videoRef, castAttemptedRef, closingRef, castActiveRef, setCastActive, logContext, lastKnownTime, lastPlaybackOpts]);
}
