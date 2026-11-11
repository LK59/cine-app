import { useCallback, useEffect, useMemo } from "react";
import { useStore, useT } from "./state/store";
import { checkCapability, flatPanel, isTouchDevice } from "./lib/capability";
import { Panel } from "./ui/Panel";
import { accountLang, leaveToLaterna, SessionExpired, watchSession } from "./lib/session";
import { World } from "./world/World";
import { rig, resetRig } from "./world/rig";
import { Intro } from "./ui/Intro";
import { PauseMenu } from "./ui/PauseMenu";
import { BenchOverlay } from "./ui/BenchOverlay";
import { speakerLevels } from "./media/audio";
import { timing as benchTiming } from "./bench/bench";
import { musicLevels } from "./media/music";
import { SEATS, THINGS } from "./world/interactions";
import { SCREENS } from "./world/layout";
import { Hints } from "./ui/Hints";
import { FpsCounter, Hud } from "./ui/Hud";
import { closePanel, debug, openPanel } from "./state/actions";
import { emit, view } from "./input/intents";
import { perf } from "./lib/perf";
import { cueAt } from "./media/subtitles";
import { effects } from "./world/Effects";
import { screenLight } from "./world/screenLight";
import { ContextLost, Crashed, SessionEnded, Unsupported } from "./ui/Screens";
import { TouchControls } from "./ui/TouchControls";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { getVideo, playTestClip, stopOnLeave } from "./media/playback";
import { dropForTest } from "./net/salons";
import { dispatch } from "./media/commands";
import { startUpNext } from "./media/upNext";
import { sendAutoLog } from "./lib/autoLog";
import { watchErrors } from "./lib/errorLog";
import { Prompts } from "./ui/Prompts";
import { Remote } from "./ui/Remote";

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
  const touch = useMemo(() => isTouchDevice(), []);
  const t = useT();

  const boot = useCallback(() => {
    const state = useStore.getState();
    state.setUnsupported(checkCapability());
  }, []);

  useEffect(() => {
    watchSession(() => useStore.getState().setPhase("expired"));
    boot();
    startUpNext();
    accountLang().then(
      (lang) => lang && useStore.getState().setLang(lang),
      (err) => {
        if (!(err instanceof SessionExpired)) console.warn("[immersion] langue du compte indisponible");
      }
    );
    // Prise de test et de capture : l'état, et le visiteur qu'on peut poser où l'on veut.
    (window as unknown as { __immersion?: unknown }).__immersion = { store: useStore, rig, resetRig, dispatch, playTestClip, video: getVideo, openPanel, closePanel, emit, debug, benchTiming, view, cueAt, perf, effects, screenLight, speakerLevels, musicLevels, things: THINGS.map(({ id, at }) => ({ id, at })), seats: SEATS, screens: Object.fromEntries(SCREENS.map((screen) => [screen.id, screen])), salons: { drop: dropForTest } };
    // Ce qu'aucune barrière n'attrape (rappels, minuteurs, promesses) part au serveur (`errorLog.ts`).
    const unwatchErrors = watchErrors();
    // La page s'en va, quelle qu'en soit la raison : l'arrêt de la lecture part quand même.
    window.addEventListener("pagehide", stopOnLeave);
    // La visite (qualité, phase, erreurs, et ce qu'« Auto » en a fait) : une ligne au journal, en partant.
    window.addEventListener("pagehide", sendAutoLog);
    // Un téléphone que l'on tourne en paysage : l'écran « tournez l'appareil » s'efface de lui-même.
    const retry = () => useStore.getState().phase === "unsupported" && boot();
    window.addEventListener("resize", retry);
    return () => {
      unwatchErrors();
      window.removeEventListener("pagehide", stopOnLeave);
      window.removeEventListener("pagehide", sendAutoLog);
      window.removeEventListener("resize", retry);
    };
  }, [boot]);

  if (phase === "checking") return null;
  if (phase === "unsupported") return <Unsupported onRetry={boot} />;
  if (phase === "lost") return <ContextLost />;
  if (phase === "expired") return <SessionEnded />;
  if (phase === "leaving") return <div className="leaving" />;

  return (
    <ErrorBoundary fallback={<Crashed />} report="crash">
      <World />
      {phase === "world" ? (
        <>
          {mode === "walk" ? <Hints /> : null}
          {touch ? <TouchControls /> : null}
          {mode === "panel" && flatPanel() ? (
            <div className="panel-flat">
              <Panel />
            </div>
          ) : null}
          {/* Le panneau en 3D se ferme à Échap : dit en dehors de lui, toujours à l'écran. Un visiteur l'a ouvert trop
              près d'un mur, le bouton « Fermer » est sorti du champ, et il s'est cru « bloqué dans la fenêtre Laterna ».
              Au doigt, pas de touche : le bouton suffit (et le panneau à plat le garde à l'écran). */}
          {mode === "panel" && !touch ? (
            <div className="hints hints-panel">
              <span className="hint" data-testid="panel-escape">
                <kbd>{t("key.esc")}</kbd> {t("panel.escape")}
              </span>
            </div>
          ) : null}
          {mode === "walk" ? <Hud /> : null}
          {mode === "remote" ? <Remote /> : null}
          {mode === "walk" || mode === "remote" ? <Prompts /> : null}
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
