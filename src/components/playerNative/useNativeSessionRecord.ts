// Le bilan de séance du lecteur natif (`ExperimentalPlayerHost.tsx`) : la ligne `stop`, la copie
// gardée sur l'appareil, `pagehide`/`pageshow`, l'arrêt au démontage, les mesures
// d'approvisionnement et la chronologie. Sorti tel quel de l'hôte le 23/10/2026, appelé à la même
// place : au démontage, React nettoie ces effets dans l'ordre où ils sont déclarés, et cet ordre
// est celui d'avant (voir les commentaires plus bas).
import { useCallback, useEffect, useRef, type RefObject } from "react";
import { reportPlayback } from "@/lib/reportPlayback";
import { trace } from "@/lib/webcodecs/trace";
import {
  diagBegin,
  diagEnd,
  diagRecentMbps,
  diagReserveAheadMB,
  diagSessionFacts,
  diagWaiting,
} from "@/lib/webcodecs/playbackDiagnosis";
import { PlaybackTimeline, TIMELINE_EVERY_MS, bufferedAhead, elementState, registerTimeline } from "@/lib/playbackTimeline";
import type { BackgroundWatch } from "@/lib/backgroundReturn";
import type { SessionTally, WatchedClock } from "@/lib/playerSessionTally";
import { saveUnsentStop, clearUnsentStop, touchUnsentStop } from "@/lib/unsentStop";
import type { FileIdentity } from "@/lib/resumeCache/diskChunks";
import { keepOnStop } from "@/lib/resumeCache/keepOnStop";
import type { PlayerLifecycle } from "@/lib/playerLifecycle";
import { sleepTimerLogFields, sleepTimerStore } from "@/lib/sleepTimer";
import type { RemuxPlayback } from "@/lib/webcodecs/remuxPlayback";
import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";
import { syncFacts } from "@/components/player/nativeHostHelpers";
import { useWatchedClockRun } from "@/components/player/session/useWatchedClockRun";

/**
 * La copie de secours du bilan (`unsentStop`) est réécrite quand la séance a gagné ce temps regardé
 * sans autre événement — ce qu'un plantage en plein écran perdrait au plus de `watched` (13/10/2026).
 */
const UNSENT_STOP_WATCHED_STEP_S = 120;

export function useNativeSessionRecord({
  itemId,
  bench,
  info,
  playing,
  ready,
  ended,
  error,
  currentAudio,
  rebuildCount,
  sessionId,
  lifecycle,
  tally,
  watched,
  background,
  intendedPosition,
  slowFields,
  describeFileRef,
  pathRef,
  remuxRef,
  videoElRef,
  lastVideoElRef,
  positionRef,
  isSceneRef,
  mountedAtRef,
}: {
  itemId: string;
  bench: string | undefined;
  info: DirectPlayInfo | undefined;
  playing: boolean;
  ready: boolean;
  ended: boolean;
  error: string | null;
  currentAudio: number | null;
  rebuildCount: number;
  sessionId: string;
  lifecycle: PlayerLifecycle;
  tally: SessionTally;
  watched: WatchedClock;
  background: BackgroundWatch;
  intendedPosition: () => number;
  slowFields: () => Record<string, string>;
  describeFileRef: RefObject<() => Record<string, unknown>>;
  pathRef: RefObject<"remux" | null>;
  remuxRef: RefObject<RemuxPlayback | null>;
  videoElRef: RefObject<HTMLVideoElement | null>;
  lastVideoElRef: RefObject<HTMLVideoElement | null>;
  positionRef: RefObject<number>;
  isSceneRef: RefObject<() => boolean>;
  /** L'instant du montage, posé ici par le premier effet — lu aussi par la lenteur (§78). */
  mountedAtRef: RefObject<number>;
}) {
  useEffect(() => {
    mountedAtRef.current = Date.now();
  }, [mountedAtRef]);
  useWatchedClockRun(watched, playing);
  /** Le fichier tel que le cache de reprise l'identifie — pour `keepOnStop`, lu à l'arrêt. */
  const keepFileRef = useRef<FileIdentity | null>(null);
  useEffect(() => {
    keepFileRef.current = info?.streamUrl ? { itemId, streamUrl: info.streamUrl, size: info.sizeBytes ?? null, fileVersion: info.fileVersion ?? null } : null;
  }, [info, itemId]);
  const stopFactsRef = useRef({ ready: false, ended: false, error: null as string | null, audio: null as number | null, rebuilds: 0 });
  useEffect(() => {
    stopFactsRef.current = { ready, ended, error, audio: currentAudio, rebuilds: rebuildCount };
  }, [ready, ended, error, currentAudio, rebuildCount]);
  /**
   * Le bilan de la séance à cet instant — ce que dit la ligne `stop`, et ce qui est gardé sur
   * l'appareil au cas où elle ne pourrait pas partir (voir unsentStop.ts).
   */
  const stopFields = useCallback(
    // `exact: false` : la copie de secours gardée en pleine lecture — voir `diagSessionFacts`.
    (why: "close" | "next" | "page" | "unmount" | "lost", options: { exact?: boolean } = {}) => {
      const now = Date.now();
      const facts = stopFactsRef.current;
      return {
        ...describeFileRef.current(),
        path: pathRef.current ?? "non décidé",
        why,
        // Où le spectateur a demandé d'être, pas seulement ce qu'il a vu : fermé pendant un saut
        // encore en chargement, la position d'avant le saut partait au journal et à Jellyfin.
        at: intendedPosition(),
        watched: watched.seconds(now),
        ended: facts.ended,
        rebuild: facts.rebuilds,
        ...(facts.audio !== null ? { audio: facts.audio } : {}),
        // Fermé avant la première image : combien de temps le spectateur a attendu avant de renoncer.
        ...(facts.ready ? {} : { gaveUpAfterMs: now - mountedAtRef.current }),
        ...(facts.error ? { error: facts.error } : {}),
        // Attentes, sauts, changements de piste : le confort de la séance en quelques chiffres.
        ...tally.summary(now),
        ...syncFacts(remuxRef.current, videoElRef.current ?? lastVideoElRef.current),
        // Réseau, calcul, décodeur : ce qui a retenu la chaîne, et chaque attente classée. Aplati en
        // `diag.*`, sous son propre plafond de champs (playerLog.ts).
        diag: diagSessionFacts(options),
        // La minuterie de veille choisie, ou celle qui a arrêté le film (`sleepTimer.ts`).
        ...sleepTimerLogFields(sleepTimerStore.get()),
        // Ce que la lenteur a fait paraître pendant la séance, et les choix faits (§78).
        ...slowFields(),
      };
    },
    [tally, watched, intendedPosition, slowFields, describeFileRef, pathRef, remuxRef, videoElRef, lastVideoElRef, mountedAtRef]
  );
  /**
   * Comment la séance s'est terminée — la ligne `stop` du journal.
   *
   * Le type existait depuis le premier jour et rien ne l'envoyait : sur 503 lignes au 21/09, 444
   * `start` et pas un seul `stop`. Un film vu jusqu'au bout et un film abandonné au bout de trente
   * secondes laissaient donc exactement la même trace — et l'abandon silencieux, celui d'un
   * spectateur qui ferme plutôt que de se plaindre, est précisément la panne qu'aucun autre
   * enregistrement ne montre.
   *
   * Une seule fois par lecteur (il est remonté à chaque titre, voir la `key` de `PlayerHost`),
   * par le premier qui arrive : la croix, l'épisode suivant, la page qui s'en va, et le démontage
   * en dernier filet. Rien après un repli : la ligne `fallback` a déjà tout dit, et le lecteur
   * stable prend la suite de la séance.
   *
   * Tout est lu par des refs : les appelants — un écouteur `pagehide`, un nettoyage d'effet —
   * vivent plus longtemps que le rendu qui les a créés.
   */
  // « La ligne `stop` est partie » vit dans `lifecycle` (`claimStop`, `keepsUnsentStop`).
  const reportStop = useCallback(
    (why: "close" | "next" | "page" | "unmount") => {
      if (!lifecycle.claimStop()) return;
      reportPlayback("stop", stopFields(why));
      clearUnsentStop(sessionId);
      // De quoi reprendre, pris dans ce que le lecteur tient en mémoire — voir `keepOnStop`. Lu ici,
      // avant que le pipeline soit détruit (la croix, puis `stopPlaybackNow` ; au démontage, cet
      // effet-ci est nettoyé avant celui du pipeline). Pas pour un film fini. Gardé à part : une
      // sauvegarde sur le chemin de l'arrêt ne doit jamais empêcher l'arrêt.
      try {
        const kept = keepFileRef.current;
        const remux = remuxRef.current;
        const file = remux?.reserveContext?.()?.file;
        // Ni pour une scène (§91) : ces octets servent une reprise qu'elle n'a pas posée.
        if (kept && !stopFactsRef.current.ended && !bench && !isSceneRef.current()) {
          void keepOnStop(kept, remux?.heldBytes?.() ?? null, file ? { file, seconds: positionRef.current } : null);
        }
      } catch {
        /* la reprise se fera par le réseau */
      }
    },
    [stopFields, sessionId, lifecycle, bench, remuxRef, positionRef, isSceneRef]
  );
  /**
   * Le bilan gardé sur l'appareil, tenu à jour tant que la séance vit.
   *
   * **Exact et entier à chaque passage en arrière-plan et à `pagehide`** — le dernier instant où une
   * page qu'iOS va tuer peut encore écrire quoi que ce soit : c'est cette copie-là qu'un iPhone tué
   * enverra (`why: "lost"`). Jamais une fois l'arrêt parti ou la main passée.
   *
   * Entre deux, toutes les 30 s, **réécrit seulement s'il a changé** (13/10/2026). Il l'était à
   * chaque fois : ~2 Ko dans `localStorage` (une écriture synchrone sur le disque, sous iOS), et
   * `diagSessionFacts` — médiane et 90e centile triés sur jusqu'à 2 000 valeurs, ~1,5 ms au relevé
   * du 13/10 —, pour une copie qui ne sert qu'à une page tuée sans être passée en arrière-plan (un
   * plantage en plein écran). « Changé » : un événement de la séance (attente, saut, piste,
   * reconstruction, erreur, fin, lenteur) ou deux minutes de plus regardées ; la copie est alors
   * écrite avec des centiles approchés (`exact: false`). Sinon, un signe de vie seulement
   * (`touchUnsentStop`, une quinzaine d'octets), pour que la séance ne passe pas pour perdue.
   */
  useEffect(() => {
    /** Ce qui, en changeant, mérite une réécriture — sans rien calculer de coûteux. */
    const signature = () => {
      const now = Date.now();
      const facts = stopFactsRef.current;
      return JSON.stringify([
        pathRef.current,
        facts.ready,
        facts.ended,
        facts.error,
        facts.audio,
        facts.rebuilds,
        tally.summary(now),
        slowFields(),
        Math.floor(watched.seconds(now) / UNSENT_STOP_WATCHED_STEP_S),
      ]);
    };
    let savedSignature: string | null = null;
    const save = (exact: boolean) => {
      if (!lifecycle.keepsUnsentStop()) return;
      saveUnsentStop(sessionId, stopFields("lost", { exact }), Date.now(), { livesHere: true });
      savedSignature = signature();
    };
    const refresh = () => {
      if (!lifecycle.keepsUnsentStop()) return;
      if (signature() !== savedSignature) save(false);
      else touchUnsentStop(sessionId);
    };
    save(true);
    const timer = setInterval(refresh, 30_000);
    /**
     * Écrit dans la trace, et plus seulement compté : l'état de l'élément au départ et au retour.
     * Une panne de décodage juste après un déverrouillage ne se distinguait pas d'une panne en
     * pleine lecture (Red Dragon, 24/09/2026), et qui relance la lecture au retour — WebKit, de
     * lui-même — ne se lisait nulle part.
     */
    const state = () => {
      const element = videoElRef.current;
      return element ? `${element.paused ? "en pause" : "en lecture"} à ${element.currentTime.toFixed(1)} s` : "sans élément";
    };
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const onVisibility = () => {
      if (settleTimer) clearTimeout(settleTimer);
      const element = videoElRef.current;
      if (document.visibilityState === "hidden") {
        tally.hidden(Date.now());
        // L'état au départ, la retenue d'un retour précédent effacée, la pause d'iOS reconnue —
        // voir `BackgroundWatch.hide`.
        background.hide(Date.now(), element);
        trace(`arrière-plan — ${state()}`);
        save(true);
      } else {
        const away = tally.shown(Date.now());
        trace(`retour au premier plan après ${(away / 1000).toFixed(1)} s — ${state()}`);
        // Verrouillé en plein film : la lecture attend au retour, un peu avant — voir
        // `holdPausedOnReturn`. WebKit la relance de lui-même un instant plus tard ; le refus de
        // cette relance-là est plus bas, dans `onPlay`.
        // Une retenue n'existe qu'avec une vidéo (`show` rend `null` sans elle) ; `element` est
        // testé ici pour le typage. Sa position est celle que la reconstruction au retour lira aussi.
        const hold = background.show(Date.now(), away, element);
        if (element && hold) {
          trace(`retour après ${(away / 1000).toFixed(1)} s : lecture laissée en pause, reprise à ${hold.at.toFixed(1)} s`);
          try {
            element.pause();
            element.currentTime = hold.at;
          } catch {
            // Source déjà fermée par iOS : la reconstruction au retour reprendra en pause, à cet endroit.
          }
        }
        // Le navigateur reprend (ou non) la lecture un instant après : c'est ce second relevé qui dit
        // ce qu'il a décidé.
        settleTimer = setTimeout(() => trace(`1,5 s après le retour — ${state()}`), 1500);
      }
    };
    // La relance de WebKit au déverrouillage arrive après notre pause : refusée tant qu'aucun geste
    // du spectateur ne l'a demandée. `play` ne remonte pas : écouté en capture, sur le document.
    const onPlay = (event: Event) => {
      // Une lecture d'autre chose qu'une vidéo ne touche pas à la retenue.
      if (!(event.target instanceof HTMLVideoElement) || !background.refusePlay(Date.now())) return;
      trace("relance du navigateur au retour refusée — la lecture attend le spectateur");
      event.target.pause();
    };
    const onGesture = () => background.noteGesture(Date.now());
    // Le dernier instant d'une page qui s'en va : la copie exacte. Une fermeture ordinaire a déjà
    // envoyé son arrêt (`reportStop("page")`) et `keepsUnsentStop` est alors faux — rien n'est écrit.
    const onPageHide = () => save(true);
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("play", onPlay, true);
    document.addEventListener("pointerdown", onGesture, true);
    document.addEventListener("keydown", onGesture, true);
    return () => {
      clearInterval(timer);
      if (settleTimer) clearTimeout(settleTimer);
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("play", onPlay, true);
      document.removeEventListener("pointerdown", onGesture, true);
      document.removeEventListener("keydown", onGesture, true);
    };
  }, [sessionId, stopFields, tally, lifecycle, background, watched, slowFields, pathRef, videoElRef]);
  useEffect(() => {
    const onPageHide = () => reportStop("page");
    // Une page rendue depuis le cache du navigateur (retour arrière) reprend le film : voir
    // `lifecycle.reopenStop`.
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) lifecycle.reopenStop();
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [reportStop, lifecycle]);
  /**
   * L'arrêt écrit quand le lecteur disparaît — au démontage, et seulement là.
   *
   * Il vivait dans le nettoyage de l'effet ci-dessus, lié à l'identité de `reportStop` : une
   * dépendance ajoutée un jour à `reportStop`, ou à `stopFields`, aurait relancé cet effet en pleine
   * séance, et son nettoyage aurait écrit `stop "unmount"` au milieu du film (point 13,
   * docs/cycle-de-vie-lecteur.md). Un effet sans dépendance, qui lit la dernière version par une
   * référence, ne se nettoie qu'au démontage.
   */
  //
  // Sa place compte : au démontage, React nettoie les effets dans l'ordre où ils sont déclarés.
  // Déclaré ici, l'arrêt est écrit *après* que l'horloge du temps regardé s'est arrêtée (l'effet
  // `[playing, watched]`, plus haut) — sinon il manquerait le dernier morceau —, et *avant* l'arrêt
  // que `usePlaybackSession`, appelé par l'hôte juste après ce hook, envoie à Jellyfin.
  const reportStopRef = useRef(reportStop);
  useEffect(() => {
    reportStopRef.current = reportStop;
  }, [reportStop]);
  useEffect(() => () => reportStopRef.current("unmount"), []);
  // Les mesures d'approvisionnement de cette séance — voir playbackDiagnosis.ts. Les reconstructions
  // restent dans la même séance, donc dans les mêmes totaux. Déclaré *après* l'arrêt ci-dessus, pour
  // la même raison d'ordre : déclaré plus haut, `diagEnd` passait avant, et la ligne `stop` d'une
  // fermeture partait sans son champ `diag` (chasse aux défauts du 28/09).
  useEffect(() => {
    diagBegin(sessionId);
    return () => diagEnd(sessionId);
  }, [sessionId]);
  /**
   * La chronologie des deux dernières minutes (§77) : un échantillon toutes les 5 s, en mémoire,
   * joint par `reportPlayback` aux lignes de panne et au bilan. Déclarée après l'arrêt et la mesure
   * ci-dessus : au démontage, la ligne `stop` part encore avec elle.
   */
  useEffect(() => {
    const timeline = new PlaybackTimeline(() => {
      const video = videoElRef.current;
      return {
        pos: video && Number.isFinite(video.currentTime) && video.currentTime > 0 ? video.currentTime : positionRef.current,
        recvMbps: diagRecentMbps(TIMELINE_EVERY_MS),
        aheadS: bufferedAhead(video),
        reserveMB: diagReserveAheadMB(),
        state: elementState(video, diagWaiting()),
      };
    }).start();
    const unregister = registerTimeline(sessionId, timeline);
    return () => {
      timeline.stop();
      unregister();
    };
  }, [sessionId, positionRef, videoElRef]);
  return { reportStop };
}
