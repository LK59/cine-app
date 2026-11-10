import { useCallback, useEffect } from "react";
import { useStore } from "./state/store";
import { checkCapability } from "./lib/capability";
import { accountLang, leaveToLaterna, SessionExpired, watchSession } from "./lib/session";
import { World } from "./world/World";
import { rig, resetRig } from "./world/rig";
import { Intro } from "./ui/Intro";
import { PauseMenu } from "./ui/PauseMenu";
import { BenchOverlay } from "./ui/BenchOverlay";
import { speakerLevels } from "./media/audio";
import { timing as benchTiming } from "./bench/bench";
import { musicLevels } from "./media/music";
import { Hints } from "./ui/Hints";
import { FpsCounter, Hud } from "./ui/Hud";
import { closePanel, debug, openPanel } from "./state/actions";
import { emit } from "./input/intents";
import { ContextLost, Crashed, SessionEnded, Unsupported } from "./ui/Screens";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { getVideo, playTestClip, stopOnLeave } from "./media/playback";
import { dispatch } from "./media/commands";

/**
 * La page du mode : ce qui s'affiche selon la phase.
 *
 * `checking` → l'appareil convient-il ? → `loading` (le monde se monte sous l'accueil) → `gate`
 * (« Cliquer pour entrer ») → `world`. Trois sorties de route : `unsupported`, `lost` (contexte
 * WebGL perdu), `expired` (session finie).
 */
export function App() {
  const phase = useStore((s) => s.phase);
  const mode = useStore((s) => s.mode);
  const measuring = useStore((s) => s.bench?.running === true);
  const showFps = useStore((s) => s.settings.showFps);

  const boot = useCallback(() => {
    const state = useStore.getState();
    state.setUnsupported(checkCapability());
  }, []);

  useEffect(() => {
    watchSession(() => useStore.getState().setPhase("expired"));
    boot();
    accountLang().then(
      (lang) => lang && useStore.getState().setLang(lang),
      (err) => {
        if (!(err instanceof SessionExpired)) console.warn("[immersion] langue du compte indisponible");
      }
    );
    // Prise de test et de capture : l'état, et le visiteur qu'on peut poser où l'on veut.
    (window as unknown as { __immersion?: unknown }).__immersion = { store: useStore, rig, resetRig, dispatch, playTestClip, video: getVideo, openPanel, closePanel, emit, debug, benchTiming, speakerLevels, musicLevels };
    // La page s'en va, quelle qu'en soit la raison : l'arrêt de la lecture part quand même.
    window.addEventListener("pagehide", stopOnLeave);
    return () => window.removeEventListener("pagehide", stopOnLeave);
  }, [boot]);

  if (phase === "checking") return null;
  if (phase === "unsupported") return <Unsupported onRetry={boot} />;
  if (phase === "lost") return <ContextLost />;
  if (phase === "expired") return <SessionEnded />;
  if (phase === "leaving") return <div className="leaving" />;

  return (
    <ErrorBoundary fallback={<Crashed />}>
      <World />
      {phase === "world" ? (
        <>
          {mode === "walk" ? <Hints /> : null}
          {mode === "walk" ? <Hud /> : null}
          {showFps ? <FpsCounter /> : null}
          {/* Pendant une mesure, le menu s'efface : la scène est rendue comme en visite. */}
          {measuring ? <BenchOverlay /> : mode === "paused" ? <PauseMenu /> : null}
        </>
      ) : (
        <Intro />
      )}
    </ErrorBoundary>
  );
}
