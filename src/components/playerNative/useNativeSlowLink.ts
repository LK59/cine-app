// La lenteur du lien dans le lecteur natif (`ExperimentalPlayerHost.tsx`, DECISIONS.md §78) : le
// relais vers la version allégée, l'exécution commune (`SlowLinkRunner`), le renoncement à une
// ouverture sans image, la lecture du lien chaque seconde, « Connexion perdue ou instable… », les
// saccades en pleine lecture et la mesure reprise au retour. Sorti tel quel de l'hôte le
// 23/10/2026 et appelé à la même place, entre le minuteur des avertissements et le rendu.
import { useCallback, useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { reportPlayback } from "@/lib/reportPlayback";
import { trace } from "@/lib/webcodecs/trace";
import { diagLinkMeasure, diagWaiting } from "@/lib/webcodecs/playbackDiagnosis";
import { clearUnsentStop } from "@/lib/unsentStop";
import type { PlayerLifecycle } from "@/lib/playerLifecycle";
import type { SessionTally } from "@/lib/playerSessionTally";
import {
  SLOW_LINK_LIGHTER_REASON,
  SLOW_LINK_REASON,
  SLOW_LINK_STUTTER_REASON,
  slowLinkFields,
  type LinkMeasure,
  type LinkMeter,
  type SlowLink,
} from "@/lib/slowLink";
import type { StableTakeover } from "@/lib/useStableFallback";
import { prewarmFields } from "@/lib/lighterPrewarm";
import type { SlowLinkHost, SlowLinkRunner } from "@/lib/slowLinkRunner";
import {
  PLAYBACK_MEASURE_WINDOW_MS,
  type SlowLog,
  decideOpening,
  decidePlayback,
  type LighterStep,
  mbps,
  measuredBps,
} from "@/lib/slowLinkPolicy";
import { networkUnstable, subscribeNetworkTrouble } from "@/lib/networkTrouble";
import type { PlayerTrack } from "@/lib/webcodecs/playerTrack";
import type { ExternalSubtitleSource } from "@/lib/webcodecs/externalSubtitles";
import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";
import { generationMenu, jellyfinAudioIndex, jellyfinSubtitleIndex } from "@/components/player/nativeHostHelpers";

/**
 * And before waiting stops being worth it at all.
 *
 * A first picture arrives in four seconds on an ordinary file over an ordinary link. Half a
 * minute is not a slow start, it is something that is not going to finish — and it is the one
 * failure a viewer cannot wait out, because nothing on screen ever changes.
 */
const GIVE_UP_AFTER_MS = 35000;

/** L'indice de lenteur tel que l'écran le dit, à l'ouverture comme après un saut. */
type SlowSignal = { at: number; hint: boolean; recvBps: number | null; needBps: number | null };

export function useNativeSlowLink({
  itemId,
  tracks,
  info,
  currentAudio,
  currentSubtitle,
  generationView,
  externals,
  runner,
  slowLog,
  lifecycle,
  fallToStable,
  slowFields,
  sessionId,
  tally,
  runtimeError,
  networkLost,
  error,
  intendedPosition,
  ready,
  openedAt,
  measureEpoch,
  handleClose,
  setSlowLink,
  setRuntimeError,
  setNetworkLost,
  setSeekSignal,
  setSlowSignal,
  setUnstable,
  setStallUnstable,
  setMeasureEpoch,
  everReadyRef,
  takeoverNowRef,
  wantedAudioRef,
  positionRef,
  describeFileRef,
  pathRef,
  autoLighterRef,
  playbackDecisionRef,
  readyRef,
  videoElRef,
  needBpsRef,
  openingMeterRef,
  pictureAtRef,
  stallAtRef,
  mountedAtRef,
  offerStutterRef,
}: {
  itemId: string;
  tracks: { audio: PlayerTrack[]; subtitles: PlayerTrack[] };
  info: DirectPlayInfo | undefined;
  currentAudio: number | null;
  currentSubtitle: number | null;
  generationView: ReturnType<typeof generationMenu>;
  externals: ExternalSubtitleSource[];
  runner: SlowLinkRunner;
  slowLog: SlowLog;
  lifecycle: PlayerLifecycle;
  fallToStable: (reason: string, takeover?: StableTakeover, extra?: Record<string, unknown>) => void;
  slowFields: () => Record<string, string>;
  sessionId: string;
  tally: SessionTally;
  runtimeError: string | null;
  networkLost: { message: string; at: number; audio: number | null } | null;
  error: string | null;
  intendedPosition: () => number;
  ready: boolean;
  openedAt: number;
  measureEpoch: number;
  handleClose: () => void;
  setSlowLink: Dispatch<SetStateAction<SlowLink | null>>;
  setRuntimeError: Dispatch<SetStateAction<string | null>>;
  setNetworkLost: Dispatch<SetStateAction<{ message: string; at: number; audio: number | null } | null>>;
  setSeekSignal: Dispatch<SetStateAction<SlowSignal | null>>;
  setSlowSignal: Dispatch<SetStateAction<SlowSignal>>;
  setUnstable: Dispatch<SetStateAction<boolean>>;
  setStallUnstable: Dispatch<SetStateAction<boolean>>;
  setMeasureEpoch: Dispatch<SetStateAction<number>>;
  everReadyRef: RefObject<boolean>;
  takeoverNowRef: RefObject<() => StableTakeover | undefined>;
  wantedAudioRef: RefObject<number | null>;
  positionRef: RefObject<number>;
  describeFileRef: RefObject<() => Record<string, unknown>>;
  pathRef: RefObject<"remux" | null>;
  autoLighterRef: RefObject<boolean>;
  playbackDecisionRef: RefObject<(triggered?: boolean, early?: boolean) => void>;
  readyRef: RefObject<boolean>;
  videoElRef: RefObject<HTMLVideoElement | null>;
  needBpsRef: RefObject<number | null>;
  openingMeterRef: RefObject<LinkMeter | null>;
  pictureAtRef: RefObject<number>;
  stallAtRef: RefObject<number | null>;
  mountedAtRef: RefObject<number>;
  offerStutterRef: RefObject<(kind: "long" | "repeated") => void>;
}) {
  /**
   * Le relais d'une bascule en version allégée (§78) : une décision du lecteur, pas un échec (`lighter`,
   * hors `handedOver` : la lecture suivante repart sur le natif, sauf la règle des deux minutes), qui
   * porte le palier à demander, garde ce que le spectateur avait choisi — position, piste audio,
   * sous-titre — et dit si une génération de sous-titres était en cours.
   */
  const lighterTakeover = useCallback(
    (resumeAt: number, step: LighterStep): StableTakeover => ({
      ...(everReadyRef.current ? takeoverNowRef.current() ?? { resumeAt } : { resumeAt, audioStreamIndex: jellyfinAudioIndex(tracks.audio, info?.audio, wantedAudioRef.current ?? currentAudio ?? -1) }),
      resumeAt,
      lighter: step,
      switchedAt: Date.now(),
      subtitleStreamIndex: generationView.entries.some((e) => e.track.number === currentSubtitle)
        ? null
        : jellyfinSubtitleIndex(currentSubtitle, tracks.subtitles, info?.embeddedSubtitleIndexes, externals),
      ...(generationView.entries.length > 0 ? { subtitleGenerating: true } : {}),
    }),
    [tracks.audio, tracks.subtitles, info?.audio, info?.embeddedSubtitleIndexes, currentAudio, currentSubtitle, generationView, externals, everReadyRef, takeoverNowRef, wantedAudioRef]
  );

  /**
   * Ce que l'exécution commune des décisions (§78, `SlowLinkRunner`) lit de ce lecteur. Seule la bascule
   * lui est propre : `fallToStable`, avec un relais `lighter` qui porte le palier.
   */
  useEffect(() => {
    runner.attach({
      itemId,
      log: () => slowLog,
      audioStreamIndex: () => jellyfinAudioIndex(tracks.audio, info?.audio, wantedAudioRef.current ?? currentAudio ?? -1),
      over: () => lifecycle.isOver(),
      trace,
      switchTo: (step, resumeAt, cause, held, reading) =>
        fallToStable(cause === "lecture" ? SLOW_LINK_STUTTER_REASON : SLOW_LINK_LIGHTER_REASON, lighterTakeover(resumeAt, step), {
          ...(reading.recvBps !== null && reading.needBps !== null
            ? { recvMbps: Math.round((reading.recvBps / 1e6) * 100) / 100, needMbps: Math.round((reading.needBps / 1e6) * 10) / 10 }
            : {}),
          lighterMbps: Math.round(step.targetBps / 1e5) / 10,
          lighterTier: step.tier,
          switch: { cause, from: Math.round(positionRef.current * 10) / 10, to: Math.round(resumeAt * 10) / 10 },
          ...(held ? { prewarm: prewarmFields(held) } : {}),
          quality: "auto",
          ...slowFields(),
        }),
      screen: (slow, cause) => {
        if (!lifecycle.stepAside()) return;
        const figures = slowLinkFields(slow);
        trace(`connexion trop lente : ${figures.recvMbps} Mb/s reçus sur ${figures.measuredS} s de réception, ${figures.needMbps} Mb/s demandés — écran`);
        clearUnsentStop(sessionId);
        reportPlayback("error", {
          ...describeFileRef.current(),
          reason: SLOW_LINK_REASON,
          path: pathRef.current ?? "non décidé",
          ...(cause === "saut" ? { afterSeek: true } : {}),
          ...figures,
          quality: autoLighterRef.current ? "auto" : "original",
          ...slowFields(),
          ...tally.backgroundFacts(Date.now()),
        });
        setSlowLink(slow);
        setRuntimeError(SLOW_LINK_REASON);
        setNetworkLost(null);
      },
      giveUp: () => fallToStable(`aucune image après ${GIVE_UP_AFTER_MS / 1000} s`, undefined, slowFields()),
      playbackDecision: () => playbackDecisionRef.current(),
      seekBlocked: () => !readyRef.current || !!runtimeError || !!networkLost || !!error || document.visibilityState === "hidden",
      paused: () => videoElRef.current?.paused === true,
      seekMeasure: (elapsedMs) => diagLinkMeasure(elapsedMs),
      needBps: () => needBpsRef.current,
      unstable: () => networkUnstable(),
      auto: () => autoLighterRef.current,
      currentStep: () => null,
      position: () => intendedPosition(),
      seekSignal: setSeekSignal,
    } satisfies SlowLinkHost);
  }, [runner, itemId, slowLog, tracks.audio, info?.audio, currentAudio, lifecycle, fallToStable, lighterTakeover, slowFields, sessionId, tally, runtimeError, networkLost, error, intendedPosition, autoLighterRef, describeFileRef, needBpsRef, pathRef, playbackDecisionRef, positionRef, readyRef, setNetworkLost, setRuntimeError, setSeekSignal, setSlowLink, videoElRef, wantedAudioRef]);
  // La première image du natif : le préchauffage d'ouverture ne sert plus. Et au démontage, rien d'orphelin.
  useEffect(() => {
    if (ready && runner.held?.cause === "ouverture") runner.drop("image du lecteur natif");
  }, [ready, runner]);
  useEffect(
    () => () => {
      runner.drop("lecteur fermé");
      runner.dispose();
    },
    [runner]
  );

  /** Une décision d'ouverture, avec la mesure courante — voir `decideOpening`. */
  const decideAndRun = useCallback(
    (measure: LinkMeasure | null, elapsedMs: number, at: number) => {
      const { advice, action } = decideOpening({
        measure,
        needBps: needBpsRef.current,
        elapsedMs,
        unstable: networkUnstable(),
        auto: autoLighterRef.current,
        prewarm: runner.status("ouverture"),
        currentStep: null,
        giveUpMs: GIVE_UP_AFTER_MS,
      });
      runner.execute(action, "ouverture", at, advice.recvBps !== null ? advice : action.kind === "screen" ? action.slow : advice);
      return advice;
    },
    [runner, autoLighterRef, needBpsRef]
  );

  /**
   * Renoncer à une ouverture qui n'a rien montré en 35 s — et dire pourquoi quand on le sait
   * (`decideOpening` au délai du renoncement) : sans lenteur prouvée, le relais d'avant, motif d'avant ;
   * lenteur prouvée, la bascule en « Automatique », sinon l'écran « Lecture impossible : la connexion
   * est trop lente. » avec Réessayer et Fermer (§78).
   */
  const giveUpOnOpening = useCallback(() => {
    let measure: LinkMeasure | null = null;
    try {
      measure = openingMeterRef.current?.measure() ?? null;
    } catch {
      measure = null;
    }
    decideAndRun(measure, GIVE_UP_AFTER_MS, positionRef.current);
  }, [decideAndRun, openingMeterRef, positionRef]);

  // A player that never starts is the one failure a viewer cannot wait out: nothing on screen
  // changes, so there is nothing to react to. On a timer rather than derived from the clock, so
  // stepping aside happens on its own account and not in the middle of a render.
  useEffect(() => {
    // Never while waiting on the network. The whole point of that screen is that the film is not
    // lost and nothing about this file or this browser is wrong; giving up into the stable
    // player — which needs the very same network — would abandon hardware decoding for a reason
    // that has nothing to do with it, and after thirty-five seconds of an outage, silently.
    //
    // Ni quand une erreur est déjà à l'écran — le serveur de médias injoignable, par exemple, qui
    // refuse exprès de passer la main : le minuteur la passait quand même trente-cinq secondes
    // plus tard, au lecteur serveur qui échouait de la même façon, et le titre y restait pour
    // toute la séance (relevé le 23/09/2026).
    if (ready || runtimeError || networkLost || error) return;
    let id: ReturnType<typeof setTimeout>;
    // Ni pendant que des tentatives échouent (§78) : c'est une coupure, pas une lenteur — elle finit
    // par l'arrivée des octets, ou par l'écran « connexion perdue » ; le renoncement attend son issue.
    const tick = () => {
      if (pictureAtRef.current > openedAt) return;
      if (networkUnstable()) {
        id = setTimeout(tick, 1000);
        return;
      }
      giveUpOnOpening();
    };
    // Depuis le début de la mesure : une ouverture passée en arrière-plan repart de son retour (§78).
    id = setTimeout(tick, Math.max(0, Math.max(openedAt, measureEpoch) + GIVE_UP_AFTER_MS - Date.now()));
    return () => clearTimeout(id);
  }, [ready, runtimeError, networkLost, error, openedAt, measureEpoch, giveUpOnOpening, pictureAtRef]);

  /**
   * Le lien, lu chaque seconde pendant l'ouverture (DECISIONS.md §78, `decideOpening`) : l'indice
   * « Connexion lente… » ; en « Automatique », le préchauffage dès 8 s et la bascule à 10 s (très lente)
   * ou 20 s (moyenne) si l'image n'est toujours pas là. La première image retire tout et arrête le
   * préchauffage. Chaque étape va au fil `slowLink`, sans ligne de plus. Rien pendant une coupure, sous
   * une erreur, ou page cachée. Sur un bon lien : une lecture du compteur par seconde, rien d'autre.
   */
  useEffect(() => {
    if (ready || runtimeError || networkLost || error) return;
    let hinted = false;
    const id = setInterval(() => {
      // L'image vient d'arriver, avant que cet effet ne s'arrête au rendu suivant : plus rien à décider
      // — une bascule ici aurait remplacé un film qui joue.
      if (readyRef.current || pictureAtRef.current > openedAt) return;
      const meter = openingMeterRef.current;
      // Page cachée : aucune mesure ne vaut (§78) — elle reprendra de zéro au retour.
      if (!meter || document.visibilityState === "hidden") return;
      let measure: ReturnType<LinkMeter["measure"]> | null = null;
      try {
        measure = meter.measure();
      } catch {
        measure = null;
      }
      // Avant le délai du renoncement : celui-ci reste au minuteur d'abandon, comme avant.
      const elapsed = Math.min(Date.now() - Math.max(openedAt, measureEpoch), GIVE_UP_AFTER_MS - 1);
      const advice = decideAndRun(measure, elapsed, positionRef.current);
      if (advice.hint !== hinted) {
        slowLog.noteAt(advice.hint ? "indice" : "indice retiré", Date.now() - openedAt, advice.recvBps, advice.needBps);
        hinted = advice.hint;
        setSlowSignal({ at: openedAt, hint: advice.hint, recvBps: advice.recvBps, needBps: advice.needBps });
      }
    }, 1000);
    return () => clearInterval(id);
  }, [ready, runtimeError, networkLost, error, openedAt, measureEpoch, slowLog, decideAndRun, openingMeterRef, pictureAtRef, positionRef, readyRef, setSlowSignal]);

  /** La première image après que la lenteur a fait paraître quelque chose : notée au fil (§78). */
  const pictureNotedRef = useRef(false);
  useEffect(() => {
    if (!ready || pictureNotedRef.current || slowLog.empty) return;
    pictureNotedRef.current = true;
    slowLog.noteAt("image", Date.now() - openedAt);
  }, [ready, slowLog, openedAt]);

  /**
   * « Connexion perdue ou instable… » (§78) : des tentatives échouent (`networkTrouble`). Dit sous la
   * ligne de chargement, ou sous la roue d'une attente en pleine lecture — jamais sur un film qui
   * joue. Noté au fil quand il se voit.
   */
  useEffect(
    () =>
      subscribeNetworkTrouble((value) => {
        setUnstable(value);
        // Retenu pour l'attente en cours, jusqu'à sa fin — voir `stallAt`.
        if (value && stallAtRef.current !== null) setStallUnstable(true);
        if (!readyRef.current || diagWaiting()) slowLog.noteAt(value ? "instable" : "instable fini", Date.now() - mountedAtRef.current);
      }),
    [slowLog, mountedAtRef, readyRef, setStallUnstable, setUnstable, stallAtRef]
  );

  /** « Fermer » sur l'écran du renoncement : le lecteur. */
  const closeFromScreen = useCallback(() => {
    slowLog.choose("fermer", Date.now() - openedAt);
    handleClose();
  }, [slowLog, openedAt, handleClose]);

  /**
   * Les saccades en pleine lecture (§78) : un blocage de plus de 5 s, ou le 3e de plus d'une seconde
   * en trois minutes, causés par le réseau et sous un débit mesuré inférieur au besoin — un problème
   * visible. `decidePlayback` : préchauffer à la position courante, puis basculer dès que c'est prêt,
   * à la position d'alors. En « Originale » : rien. Appelée par les écouteurs du pipeline.
   */
  useEffect(() => {
    playbackDecisionRef.current = (triggered = false, early = false) => {
      const measure = diagLinkMeasure(PLAYBACK_MEASURE_WINDOW_MS);
      const reading = { recvBps: measuredBps(measure), needBps: needBpsRef.current };
      const action = decidePlayback({ triggered: runner.armPlayback(triggered), early, auto: autoLighterRef.current, prewarm: runner.status("lecture"), currentStep: null, ...reading });
      if (triggered && action.kind === "prewarm") slowLog.note(`saccades à ${Math.round(positionRef.current)} s (${mbps(reading.recvBps)}/${mbps(reading.needBps)})`);
      // La position de l'élément : celle que le spectateur voit, figée sur le blocage.
      const element = videoElRef.current;
      const at = element && Number.isFinite(element.currentTime) && element.currentTime > 0 ? element.currentTime : intendedPosition();
      runner.execute(action, "lecture", at, reading);
    };
    offerStutterRef.current = () => playbackDecisionRef.current(true);
  }, [slowLog, intendedPosition, runner, autoLighterRef, needBpsRef, offerStutterRef, playbackDecisionRef, positionRef, videoElRef]);

  /**
   * Le retour au premier plan (§78). Une ouverture encore en cours repart de zéro pour sa mesure
   * (`measureEpoch`) : aucun verdict sur une mesure prise en arrière-plan.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden" || readyRef.current) return;
      setMeasureEpoch(Date.now());
      // Ce qu'on disait d'après la mesure d'avant le départ ne vaut plus : on repart de rien.
      setSlowSignal((current) => ({ ...current, hint: false }));
      slowLog.noteAt("mesure reprise au retour", Date.now() - mountedAtRef.current);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [slowLog, mountedAtRef, readyRef, setMeasureEpoch, setSlowSignal]);

  return { closeFromScreen };
}
