// Le bilan de séance du lecteur serveur (`PlayerHost.tsx`) : la ligne `stop` (`stopFields`,
// `reportStop`, une seule par séance), la main rendue au lecteur natif, la copie gardée sur
// l'appareil, `pagehide` et l'arrêt au démontage. Sorti tel quel de l'hôte le 23/10/2026, sur le
// modèle de `useNativeSessionRecord`, en deux hooks appelés chacun à la place de ce qu'ils
// contiennent : entre les deux, l'hôte déclare l'épisode suivant, la fermeture et
// `usePlayerBackClose`, dont les effets restent ainsi entre ceux-ci. Au démontage, React nettoie
// les effets dans l'ordre où ils sont déclarés : le `stop "unmount"` part au même moment qu'avant,
// avant la chronologie (`useServerTimeline`), déclarée juste après.
import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { ServerStartup } from "@/lib/serverStartup";
import { linkVerdictWord, readLink, type LinkMeter } from "@/lib/slowLink";
import type { LighterStep, SlowLog } from "@/lib/slowLinkPolicy";
import { rememberLighter } from "@/lib/playbackQuality";
import { reportPlayback } from "@/lib/reportPlayback";
import { serverStopFields, type ServerPlayerContext, type ServerStartWhy, type ServerStopWhy } from "@/lib/serverPlayerLog";
import { saveUnsentStop, clearUnsentStop } from "@/lib/unsentStop";
import { sleepTimerLogFields, sleepTimerStore } from "@/lib/sleepTimer";
import type { SessionTally, WatchedClock } from "@/lib/playerSessionTally";
import { gaveUpFields } from "@/components/player/session/gaveUp";

export function useServerSessionRecord({
  videoRef,
  logContext,
  positionNow,
  watched,
  tallyRef,
  subtitleSwitchesRef,
  restartsRef,
  errorRef,
  sessionPlayedRef,
  sessionStartedAtRef,
  slowLogRef,
  switchGapRef,
  reloadGapRef,
  lighterClearedRef,
  linkMeterRef,
  streamNeedRef,
  startupRef,
  negotiatedStepRef,
  carriedOnlyRef,
  handedOverRef,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  logContext: RefObject<ServerPlayerContext>;
  /** La position du bilan : la cible d'un saut en cours, sinon la position connue (`intendedPosition`). */
  positionNow: () => number;
  watched: WatchedClock;
  tallyRef: RefObject<SessionTally>;
  subtitleSwitchesRef: RefObject<number>;
  restartsRef: RefObject<Partial<Record<ServerStartWhy, number>>>;
  errorRef: RefObject<string | null>;
  sessionPlayedRef: RefObject<boolean>;
  sessionStartedAtRef: RefObject<number>;
  slowLogRef: RefObject<SlowLog>;
  switchGapRef: RefObject<number | null>;
  reloadGapRef: RefObject<number | null>;
  lighterClearedRef: RefObject<boolean>;
  linkMeterRef: RefObject<LinkMeter | null>;
  streamNeedRef: RefObject<number | null>;
  startupRef: RefObject<ServerStartup | null>;
  negotiatedStepRef: RefObject<LighterStep | null>;
  carriedOnlyRef: RefObject<boolean>;
  /** Posé ici par `markHandedOver` ; lu aussi par l'hôte. */
  handedOverRef: RefObject<boolean>;
}) {
  /**
   * Le bilan de la séance à cet instant — la ligne `stop`, et la copie gardée sur l'appareil au cas
   * où elle ne pourrait pas partir (`unsentStop`, `why: "lost"`). `consume` : le temps regardé est
   * pris (il ne comptera pas deux fois) ; la copie gardée le lit seulement.
   */
  const stopFields = useCallback(
    (why: ServerStopWhy, consume: boolean) => {
      const now = Date.now();
      const video = videoRef.current;
      // Le lien de la séance (§77), sous les mêmes noms que le bilan du lecteur natif (`diag.*`) —
      // rien quand hls.js n'a rien compté (Safari, lecture directe).
      const link = readLink(linkMeterRef.current?.measure(), streamNeedRef.current);
      const linkDiag =
        link.recvBps !== null
          ? {
              diag: {
                linkMbps: Math.round((link.recvBps / 1e6) * 10) / 10,
                ...(link.needBps !== null ? { needMbps: Math.round((link.needBps / 1e6) * 10) / 10 } : {}),
                linkVerdict: linkVerdictWord(link),
                linkS: Math.round((linkMeterRef.current?.measure().receivingMs ?? 0) / 100) / 10,
              },
            }
          : {};
      // La reprise (LECTEUR-2) : ce que l'image à la position demandée a coûté, sous `diag` avec le lien.
      const resumeDiag = startupRef.current?.resumeFields() ?? {};
      const diagFields = Object.keys(resumeDiag).length ? { diag: { ...("diag" in linkDiag ? linkDiag.diag : {}), ...resumeDiag } } : linkDiag;
      return { ...diagFields, ...(startupRef.current?.fields(true) ?? {}), ...serverStopFields(logContext.current, why, positionNow(), consume ? watched.take(now) : watched.seconds(now), {
        ...sleepTimerLogFields(sleepTimerStore.get()),
        duration: video?.duration,
        ended: video?.ended ?? false,
        tally: tallyRef.current.summary(now),
        subtitleSwitches: subtitleSwitchesRef.current,
        restarts: restartsRef.current,
        error: errorRef.current,
        ...gaveUpFields(sessionPlayedRef.current, now, sessionStartedAtRef.current),
      }),
      // Ce que la lenteur a fait paraître et les choix faits (§78), et la mémoire allégée effacée.
      ...slowLogRef.current.fields(),
      ...(switchGapRef.current !== null ? { switchGapMs: switchGapRef.current } : {}),
      ...(reloadGapRef.current !== null ? { reloadGapMs: reloadGapRef.current } : {}),
      ...(lighterClearedRef.current ? { lighterCleared: true } : {}) };
    },
    [watched, videoRef, linkMeterRef, streamNeedRef, startupRef, logContext, positionNow, tallyRef, subtitleSwitchesRef, restartsRef, errorRef, sessionPlayedRef, sessionStartedAtRef, slowLogRef, switchGapRef, reloadGapRef, lighterClearedRef]
  );
  /** La main est rendue au lecteur natif (fin de diffusion) : la copie gardée n'a plus lieu d'être. */
  const markHandedOver = useCallback(() => {
    handedOverRef.current = true;
    if (logContext.current.session) clearUnsentStop(logContext.current.session);
  }, [handedOverRef, logContext]);
  /**
   * La séance du journal dont le bilan est déjà parti — un seul `stop` par séance.
   *
   * L'épisode suivant (`handleAdvance`) écrit `stop "next"` sans fermer le lecteur : il compte rester
   * monté pour l'enchaîner. Mais quand l'épisode suivant repart par l'aiguillage ordinaire (le natif
   * d'abord, pour un titre qu'il n'a pas encore passé au serveur), ce lecteur est démonté aussitôt,
   * et son démontage écrivait un second `stop "unmount"` à zéro seconde pour la même séance — celui
   * que la page Activité retient, le dernier (passe de nuit du 15/10/2026, LECTEUR-12). Une séance
   * par épisode : quand le lecteur enchaîne en place, l'épisode suivant ouvre une séance neuve
   * (`logSession`), et la garde se rouvre d'elle-même.
   */
  const stoppedSessionRef = useRef<string | null>(null);
  const stopAlreadySent = useCallback(() => {
    const id = logContext.current.session;
    return !!id && stoppedSessionRef.current === id;
  }, [logContext]);
  /** Envoie le bilan et efface sa copie gardée sur l'appareil — une seule fois par séance. */
  const reportStop = useCallback(
    (why: ServerStopWhy) => {
      if (stopAlreadySent()) return;
      stoppedSessionRef.current = logContext.current.session ?? null;
      // Une séance réellement allégée qui s'arrête est retenue deux minutes (§78) — sauf si le lien a
      // retrouvé de quoi porter la lecture classique pendant qu'elle jouait. Une séance ordinaire du
      // lecteur serveur ne retient rien.
      const step = negotiatedStepRef.current;
      if (step && !carriedOnlyRef.current && !lighterClearedRef.current && !logContext.current.bench) rememberLighter(step);
      reportPlayback("stop", stopFields(why, true));
      if (logContext.current.session) clearUnsentStop(logContext.current.session);
    },
    [stopFields, stopAlreadySent, logContext, negotiatedStepRef, carriedOnlyRef, lighterClearedRef]
  );

  return { stopFields, markHandedOver, stopAlreadySent, reportStop };
}

export function useServerStopOnLeave({
  bench,
  stopFields,
  stopAlreadySent,
  reportStop,
  logContext,
  closedRef,
  handedOverRef,
  tallyRef,
}: {
  bench: string | undefined;
  stopFields: ReturnType<typeof useServerSessionRecord>["stopFields"];
  stopAlreadySent: () => boolean;
  reportStop: (why: ServerStopWhy) => void;
  logContext: RefObject<ServerPlayerContext>;
  /** La séance fermée, une seule fois — posé ici par `pagehide` et le démontage, et par l'hôte. */
  closedRef: RefObject<boolean>;
  handedOverRef: RefObject<boolean>;
  tallyRef: RefObject<SessionTally>;
}): void {
  /**
   * Le bilan gardé sur l'appareil, réécrit tant que la séance vit — comme le lecteur natif.
   *
   * Toutes les 30 s, et à chaque passage en arrière-plan : le dernier instant où une page qu'iOS va
   * tuer peut encore écrire. Renvoyé au lancement suivant en `why: "lost"` (`flushOrphanStops`).
   * Jamais après l'arrêt, ni une fois la main rendue au lecteur natif. Rien pour un banc d'essai.
   * L'arrière-plan nourrit aussi le décompte (`backgrounds`, `backgroundMs`) : une attente en cours
   * au départ n'en est plus une, c'est l'absence.
   */
  useEffect(() => {
    const save = () => {
      const id = logContext.current.session;
      if (!id || bench || closedRef.current || handedOverRef.current || stopAlreadySent()) return;
      saveUnsentStop(id, stopFields("lost", false), Date.now(), { livesHere: true });
    };
    save();
    const timer = setInterval(save, 30_000);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        tallyRef.current.hidden(Date.now());
        save();
      } else {
        tallyRef.current.shown(Date.now());
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [bench, stopFields, stopAlreadySent, logContext, closedRef, handedOverRef, tallyRef]);

  /**
   * La page qui se ferme, et le lecteur qui disparaît sans avoir été fermé : un bilan quand même.
   *
   * Sans eux, la séance finissait sur son dernier `start` — « commencée, jamais finie » — dès que la
   * page partait (onglet fermé, rechargement) ou qu'un autre écran remplaçait ce lecteur. `pagehide`
   * part avec `keepalive` (`reportPlayback`) ; le démontage seulement s'il n'y a pas eu de fermeture,
   * ni de main rendue au lecteur natif (sa ligne `fallback` raconte déjà la fin).
   */
  const reportStopRef = useRef(reportStop);
  useEffect(() => {
    reportStopRef.current = reportStop;
  }, [reportStop]);
  useEffect(() => {
    const onPageHide = (e: PageTransitionEvent) => {
      // Mise en cache (bfcache) : la page peut revenir, la séance avec. Le bilan gardé suffit.
      if (e.persisted || closedRef.current || handedOverRef.current) return;
      closedRef.current = true;
      reportStopRef.current("page");
    };
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      // La valeur du démontage, voulue : une main rendue en cours de séance retient l'arrêt. Un
      // drapeau, pas un nœud — la règle ne le voit plus depuis que la référence arrive en paramètre.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (closedRef.current || handedOverRef.current) return;
      closedRef.current = true;
      reportStopRef.current("unmount");
    };
  }, [closedRef, handedOverRef]);
}
