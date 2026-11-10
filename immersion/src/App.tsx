import { useCallback, useEffect } from "react";
import { useStore } from "./state/store";
import { checkCapability } from "./lib/capability";
import { accountLang, leaveToLaterna, SessionExpired, watchSession } from "./lib/session";
import { World } from "./world/World";
import { unlockPointer } from "./world/Controls";
import { rig, resetRig } from "./world/rig";
import { Intro } from "./ui/Intro";
import { PauseMenu } from "./ui/PauseMenu";
import { Hints } from "./ui/Hints";
import { FpsCounter, Hud } from "./ui/Hud";
import { closePanel, openPanel, panelDebug } from "./world/panel";
import { ContextLost, Crashed, SessionEnded, Unsupported } from "./ui/Screens";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { disposeAudio, resumeAudio } from "./media/audio";
import { play, playTestClip, stop, stopOnLeave } from "./media/playback";

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
    (window as unknown as { __immersion?: unknown }).__immersion = { store: useStore, rig, resetRig, play, playTestClip, stop, openPanel, closePanel, panelDebug };
    // La page s'en va, quelle qu'en soit la raison : l'arrêt de la lecture part quand même.
    window.addEventListener("pagehide", stopOnLeave);
    return () => window.removeEventListener("pagehide", stopOnLeave);
  }, [boot]);

  /** Quitter : le monde est démonté (le canevas libère ses ressources), puis la page part. */
  const quit = useCallback(() => {
    unlockPointer();
    // Dans l'ordre : la lecture est arrêtée et annoncée, le son rendu, puis le monde démonté.
    stop();
    disposeAudio();
    useStore.getState().setPhase("leaving");
    setTimeout(leaveToLaterna, 60);
  }, []);

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
          {mode === "paused" ? <PauseMenu onQuit={quit} /> : null}
        </>
      ) : (
        <Intro onEnter={resumeAudio} />
      )}
    </ErrorBoundary>
  );
}
