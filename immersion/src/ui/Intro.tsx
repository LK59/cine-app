import { useEffect, useState } from "react";
import { useProgress } from "@react-three/drei";
import { useStore, useT } from "../state/store";
import { movementKeyLabels } from "../input/keyboardMouse";
import { enterWorld, worldEntered } from "../state/actions";
import { leaveToLaterna } from "../lib/session";
import { ExperienceLogo } from "./Logo";

/** Le temps que l'animation de la marque se joue en entier, même quand tout est déjà en cache. */
const MIN_INTRO_MS = 2600;

/**
 * L'accueil : la marque qui s'allume, le chargement réel de la scène, puis l'invitation à entrer.
 *
 * Le clic d'entrée n'est pas une formalité : c'est le geste que le navigateur exige pour verrouiller
 * le pointeur et pour laisser sortir du son. Tout ce qui en dépend part de là (`enterWorld`).
 */
export function Intro() {
  const t = useT();
  const phase = useStore((s) => s.phase);
  const sceneReady = useStore((s) => s.sceneReady);
  const setPhase = useStore((s) => s.setPhase);
  const { progress, active } = useProgress();
  const [lit, setLit] = useState(false);
  const [minElapsed, setMinElapsed] = useState(false);
  const [keysLabel, setKeysLabel] = useState("WASD");
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    // Une image plus tard : la transition CSS part de l'état éteint.
    const raf = requestAnimationFrame(() => setLit(true));
    const timer = setTimeout(() => setMinElapsed(true), MIN_INTRO_MS);
    void movementKeyLabels().then(setKeysLabel);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, []);

  const ready = sceneReady && minElapsed && !active;
  useEffect(() => {
    if (ready && phase === "loading") setPhase("gate");
  }, [ready, phase, setPhase]);

  // La barre ne recule jamais et n'affiche 100 % qu'une fois la scène vraiment prête.
  const shown = ready ? 100 : Math.min(97, Math.max(4, Math.round(progress)));

  function enter() {
    if (leaving || phase !== "gate") return;
    setLeaving(true);
    enterWorld();
    // Le fondu de sortie (voir `.intro.is-leaving`), puis le monde seul.
    setTimeout(worldEntered, 900);
  }

  return (
    <div className={`intro${leaving ? " is-leaving" : ""}${phase === "gate" ? " is-ready" : ""}`}>
      <div className="intro-snow" aria-hidden />
      <button type="button" className="intro-back" onClick={leaveToLaterna}>
        ← {t("back")}
      </button>
      <div className="intro-center">
        <ExperienceLogo lit={lit} />
        <div className="intro-status" aria-live="polite">
          {phase === "gate" ? (
            <button type="button" className="intro-enter" onClick={enter} autoFocus data-testid="enter">
              {t("gate.enter")}
            </button>
          ) : (
            <>
              <div className="intro-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={shown}>
                <span style={{ transform: `scaleX(${shown / 100})` }} />
              </div>
              <p className="intro-detail">
                {t("loading.title")} · <span className="tabular">{shown} %</span>
              </p>
            </>
          )}
        </div>
      </div>
      <ul className="intro-keys" aria-hidden={phase !== "gate"}>
        <li>
          <kbd>{keysLabel}</kbd> {t("gate.move")}
        </li>
        <li>
          <kbd>{t("key.mouse")}</kbd> {t("gate.look")}
        </li>
        <li>
          <kbd>{t("key.shift")}</kbd> {t("gate.run")}
        </li>
        <li>
          <kbd>E</kbd> {t("gate.tv")}
        </li>
        <li>
          <kbd>F</kbd> {t("gate.sit")}
        </li>
        <li>
          <kbd>{t("key.esc")}</kbd> {t("gate.pause")}
        </li>
      </ul>
    </div>
  );
}
