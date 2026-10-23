import type { Dispatch, RefObject, SetStateAction } from "react";
import type { useT } from "@/components/TranslationProvider";
import { reportPlayback } from "@/lib/reportPlayback";
import { serverFailureFields, type ServerPlayerContext } from "@/lib/serverPlayerLog";
import { resourceEntries, type ServerStartup } from "@/lib/serverStartup";
import { SLOW_LINK_REASON, frozenReading, slowLinkFields, slowLinkVerdict, type LinkMeter, type LinkReading } from "@/lib/slowLink";
import { decideOpening, type LighterStep, type SlowLog } from "@/lib/slowLinkPolicy";
import type { SlowLinkRunner } from "@/lib/slowLinkRunner";

/**
 * Le chargement d'une négociation du lecteur serveur, surveillé : le chien de garde des 20 s (et ce
 * qu'il décide d'une connexion trop lente), et le lien lu chaque seconde tant que l'image n'est pas
 * là (§77, §78). `startPlayback` les arme ; leurs minuteurs restent les siens (`loadWatchdog`,
 * `linkWatch`), arrêtés aux mêmes endroits qu'avant.
 */

/** Les adresses du flux du lecteur serveur, pour les entrées de ressources de Safari (§77). */
export const STREAM_PREFIX = "/api/jellyfin/stream/";

/** Pas d'indice : l'état ordinaire d'un chargement (§78). */
export type LinkSignal = { hint: boolean; recvBps: number | null; needBps: number | null };
export const NO_LINK_SIGNAL: LinkSignal = { hint: false, recvBps: null, needBps: null };

type Translate = ReturnType<typeof useT>;

/** Le renoncement des 20 s sans image — la fonction que `startPlayback` arme et que le retour au premier plan réarme. */
export function makeFireWatchdog({
  linkWatch,
  setLinkSignal,
  unstableRef,
  linkMeterRef,
  needBps,
  nativeHls,
  directPlay,
  startup,
  cap,
  slowLogRef,
  autoLighterRef,
  runner,
  resumeAt,
  logContext,
  startedAtWall,
  setLinkFailure,
  setError,
  t,
  haltLoading,
  setReconnecting,
  setLoading,
}: {
  linkWatch: RefObject<ReturnType<typeof setInterval> | null>;
  setLinkSignal: Dispatch<SetStateAction<LinkSignal>>;
  unstableRef: RefObject<boolean>;
  linkMeterRef: RefObject<LinkMeter | null>;
  needBps: number | null;
  nativeHls: boolean;
  directPlay: boolean;
  startup: ServerStartup;
  cap: { maxBitrate: number; step: LighterStep | null };
  slowLogRef: RefObject<SlowLog>;
  autoLighterRef: RefObject<boolean>;
  runner: SlowLinkRunner;
  resumeAt: number | undefined;
  logContext: RefObject<ServerPlayerContext>;
  startedAtWall: number;
  setLinkFailure: Dispatch<SetStateAction<LinkReading | null>>;
  setError: Dispatch<SetStateAction<string | null>>;
  t: Translate;
  haltLoading: () => void;
  setReconnecting: Dispatch<SetStateAction<boolean>>;
  setLoading: Dispatch<SetStateAction<boolean>>;
}): () => void {
  return () => {
    if (linkWatch.current) clearInterval(linkWatch.current);
    linkWatch.current = null;
    setLinkSignal(NO_LINK_SIGNAL);
    let slow: ReturnType<typeof slowLinkVerdict> = null;
    try {
      // Jamais pendant une coupure (hls.js réessaie, ou le navigateur est hors ligne) : une coupure
      // n'est pas une lenteur, et n'appelle jamais la version allégée (§78). Sur le compteur
      // courant — réarmé au retour du premier plan, jamais une mesure d'arrière-plan.
      slow = unstableRef.current ? null : slowLinkVerdict(linkMeterRef.current?.measure(), needBps);
    } catch {
      slow = null;
    }
    // Où en était le démarrage — la liste, un segment, son décodage, l'image (§77).
    if (nativeHls || directPlay) startup.fromResources(resourceEntries(), STREAM_PREFIX);
    const stages = startup.fields(true);
    if (cap.step) slowLogRef.current.note(`échec (allégée palier ${cap.step.tier}) : pas d'image en 20 s`);
    // La décision au délai du renoncement (§78) : lenteur prouvée et un palier encore possible en
    // « Automatique » → la bascule au palier suivant, au lieu de l'écran.
    const { action } = decideOpening({
      measure: slow ? { bytes: slow.bytes, receivingMs: slow.measuredMs } : null,
      needBps,
      elapsedMs: 20_000,
      unstable: unstableRef.current,
      auto: autoLighterRef.current && !nativeHls && !directPlay,
      prewarm: "failed",
      currentStep: cap.step,
      giveUpMs: 20_000,
    });
    if (slow && action.kind === "switch") {
      runner.execute(action, "ouverture", resumeAt ?? 0, slow);
      return;
    }
    // Un écran, pas une bascule : un préchauffage lancé pendant le chargement ne servira pas — arrêté
    // chez Jellyfin, comme le natif quand il renonce (`execute` : `screen` / `giveUp`). Il tournait
    // derrière l'écran jusqu'à la fermeture du lecteur (13/10/2026).
    runner.drop(slow ? "écran final" : "renoncement sans lenteur prouvée");
    if (slow) {
      slowLogRef.current.noteAt("écran trop lente", Date.now() - startedAtWall, slow.recvBps, slow.needBps);
      reportPlayback("error", serverFailureFields(logContext.current, SLOW_LINK_REASON, { ...slowLinkFields(slow), ...stages, quality: autoLighterRef.current ? "auto" : "original", ...slowLogRef.current.fields() }));
      setLinkFailure(frozenReading(slow));
      // « Lecture impossible : la connexion est trop lente. » — sans chiffres (§78).
      setError(t("player.slowLink.failed"));
    } else {
      reportPlayback("error", serverFailureFields(logContext.current, "pas de première image en 20 s", { ...stages, ...slowLogRef.current.fields() }));
      setError(t('player.loadingTooLong'));
    }
    // Après la ligne `error`, qui lit encore le démarrage tel qu'il était.
    try {
      haltLoading();
    } catch {
      // L'arrêt n'est qu'un ménage : l'écran d'échec doit paraître quoi qu'il arrive.
    }
    setReconnecting(false);
    setLoading(false);
  };
}

/** Le lien lu chaque seconde du chargement (hls.js seulement) — l'appelant en décide. */
export function startLinkWatch({
  linkWatch,
  generation,
  playbackGeneration,
  errorRef,
  linkMeterRef,
  measureStartRef,
  needBps,
  unstableRef,
  autoLighterRef,
  runner,
  cap,
  slowLogRef,
  setLinkSignal,
  resumeAt,
}: {
  linkWatch: RefObject<ReturnType<typeof setInterval> | null>;
  generation: number;
  playbackGeneration: RefObject<number>;
  errorRef: RefObject<string | null>;
  linkMeterRef: RefObject<LinkMeter | null>;
  measureStartRef: RefObject<number>;
  needBps: number | null;
  unstableRef: RefObject<boolean>;
  autoLighterRef: RefObject<boolean>;
  runner: SlowLinkRunner;
  cap: { maxBitrate: number; step: LighterStep | null };
  slowLogRef: RefObject<SlowLog>;
  setLinkSignal: Dispatch<SetStateAction<LinkSignal>>;
  resumeAt: number | undefined;
}): void {
  let shown: LinkSignal = NO_LINK_SIGNAL;
  linkWatch.current = setInterval(() => {
    if (generation !== playbackGeneration.current || errorRef.current) return;
    if (document.visibilityState === "hidden") return;
    let measure: ReturnType<LinkMeter["measure"]> | null = null;
    try {
      measure = linkMeterRef.current?.measure() ?? null;
    } catch {
      measure = null;
    }
    // Avant le chien de garde : le renoncement reste à lui, comme avant.
    const elapsed = Math.min(Date.now() - measureStartRef.current, 20_000 - 1);
    const { advice, action } = decideOpening({
      measure,
      needBps,
      elapsedMs: elapsed,
      unstable: unstableRef.current,
      auto: autoLighterRef.current,
      prewarm: runner.status("ouverture"),
      currentStep: cap.step,
      giveUpMs: 20_000,
    });
    if (advice.hint !== shown.hint) {
      slowLogRef.current.noteAt(advice.hint ? "indice" : "indice retiré", elapsed, advice.recvBps, advice.needBps);
      shown = { hint: advice.hint, recvBps: advice.recvBps, needBps: advice.needBps };
      setLinkSignal(shown);
    }
    runner.execute(action, "ouverture", resumeAt ?? 0, advice);
  }, 1000);
}
