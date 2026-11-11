import { useEffect, useRef, useState } from "react";
import { useProgress } from "@react-three/drei";
import { useStore, useT, useMovementKeys } from "../state/store";
import { enterWorld, worldEntered } from "../state/actions";
import { isTouchDevice } from "../lib/capability";
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
  const touch = isTouchDevice();
  const phase = useStore((s) => s.phase);
  const sceneReady = useStore((s) => s.sceneReady);
  const setPhase = useStore((s) => s.setPhase);
  const { progress, active, loaded, total } = useProgress();
  const [lit, setLit] = useState(false);
  const [minElapsed, setMinElapsed] = useState(false);
  const keysLabel = useMovementKeys();
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    // Une image plus tard : la transition CSS part de l'état éteint.
    const raf = requestAnimationFrame(() => setLit(true));
    const timer = setTimeout(() => setMinElapsed(true), MIN_INTRO_MS);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, []);

  const ready = sceneReady && minElapsed && !active;
  useEffect(() => {
    if (ready && phase === "loading") setPhase("gate");
  }, [ready, phase, setPhase]);

  // Le chargement en deux temps, qu'on nomme : **le téléchargement** des décors (leur compte avance), puis **la
  // préparation** de la scène (programmes, premières images). La barre ne recule jamais — le total des fichiers
  // grandit en route, le pourcentage brut faisait des allers-retours — et elle ne reste jamais figée : pendant la
  // préparation, qui n'a pas de mesure, elle avance doucement vers la fin.
  // Avant le premier fichier demandé, c'est déjà le téléchargement qui s'annonce — pas la préparation.
  // Avec les paquets de décors (`lib/packs.ts`), le téléchargement, ce sont leurs octets ; les chargeurs de three
  // qui suivent ne lisent plus que la mémoire — c'est déjà la préparation.
  const packs = useStore((s) => s.packs);
  const everActive = useRef(false);
  if (active) everActive.current = true;
  const downloading = packs ? packs.loaded < packs.total : active || !everActive.current;
  const fetched = packs ? (packs.total > 0 ? (packs.loaded / packs.total) * 100 : 100) : progress;
  const [shown, setShown] = useState(4);
  const target = useRef(4);
  target.current = ready ? 100 : downloading ? Math.max(target.current, Math.min(86, 4 + fetched * 0.82)) : Math.max(target.current, 86);
  useEffect(() => {
    if (ready) {
      setShown(100);
      return;
    }
    const timer = setInterval(() => {
      setShown((current) => {
        // Vers la cible, d'un pas mesuré ; arrivée à la cible pendant la préparation, elle continue vers 98 %, de plus en plus lentement.
        const goal = target.current >= 86 ? 98 : target.current;
        const pace = goal > target.current ? 0.012 : 0.16;
        const next = current + Math.max(0, goal - current) * pace;
        return next - current < 0.02 ? current : next;
      });
    }, 80);
    return () => clearInterval(timer);
  }, [ready]);
  const percent = Math.round(shown);

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
              {touch ? t("gate.enter.touch") : t("gate.enter")}
            </button>
          ) : (
            <>
              <div className="intro-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
                <span style={{ transform: `scaleX(${shown / 100})` }} />
              </div>
              <p className="intro-detail">
                {downloading ? t("loading.download") : t("loading.prepare")}
                {downloading && packs ? (
                  <span className="tabular">
                    {" "}
                    · {Math.round(packs.loaded / 1e6)} / {Math.round(packs.total / 1e6)} {t("unit.mb")}
                  </span>
                ) : downloading && total > 0 ? (
                  <span className="tabular">
                    {" "}
                    · {loaded} / {total}
                  </span>
                ) : null}
                <span className="tabular"> · {percent} %</span>
              </p>
            </>
          )}
        </div>
      </div>
{touch ? (
        <p className="intro-keys intro-touch" aria-hidden={phase !== "gate"}>
          {t("gate.touch")}
        </p>
      ) : (
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
      )}
    </div>
  );
}
