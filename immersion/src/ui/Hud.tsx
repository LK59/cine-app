import { useEffect, useState } from "react";
import { useStore, useT } from "../state/store";

const stamp = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
};

const VISIBLE_MS = 3200;

/**
 * Le HUD de lecture : le titre, la barre de progression, l'état — et rien quand tout va bien.
 *
 * Il se montre à chaque geste (lecture, pause, saut, son) et quand quelque chose attend (flux en
 * préparation, tampon, pause), puis s'efface de lui-même : on est venu regarder un film dans un
 * chalet, pas une barre de lecteur.
 */
export function Hud() {
  const t = useT();
  const playback = useStore((s) => s.playback);
  const wake = useStore((s) => s.hudWake);
  const [fresh, setFresh] = useState(false);

  // Chaque changement d'état ou geste le réveille pour quelques secondes.
  useEffect(() => {
    setFresh(true);
    const timer = setTimeout(() => setFresh(false), VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [wake, playback.status, playback.muted, playback.itemId]);

  if (playback.status === "idle") return null;
  const lingering = playback.status === "loading" || playback.status === "paused" || playback.status === "error" || playback.waiting;
  const shown = fresh || lingering;
  const state =
    playback.status === "loading" ? t("hud.loading") : playback.status === "error" ? t("hud.error") : playback.status === "ended" ? t("hud.ended") : playback.waiting ? t("hud.buffering") : playback.status === "paused" ? t("hud.paused") : null;
  const ratio = playback.duration > 0 ? Math.min(1, playback.position / playback.duration) : 0;

  return (
    <div className={`hud${shown ? " is-shown" : ""}`} data-testid="hud" aria-live="polite">
      <div className="hud-line">
        <span className="hud-title">{playback.title}</span>
        {state ? <span className={`hud-state${playback.status === "error" ? " is-error" : ""}`}>{state}</span> : null}
        {playback.muted ? <span className="hud-state">{t("hud.muted")}</span> : null}
      </div>
      {playback.status === "error" && playback.error ? <p className="hud-error">{playback.error}</p> : null}
      {playback.duration > 0 ? (
        <div className="hud-progress">
          <span className="tabular">{stamp(playback.position)}</span>
          <div className="hud-bar">
            <span style={{ transform: `scaleX(${ratio})` }} />
          </div>
          <span className="tabular">{stamp(playback.duration)}</span>
        </div>
      ) : null}
      <div className="hud-keys">
        <span>
          <kbd>{t("key.space")}</kbd> {t("hud.keys.play")}
        </span>
        <span>
          <kbd>←</kbd>
          <kbd>→</kbd> {t("hud.keys.seek")}
        </span>
        <span>
          <kbd>M</kbd> {t("hud.keys.mute")}
        </span>
      </div>
    </div>
  );
}

/** Le compteur d'images par seconde (réglage) : mesuré sur l'horloge du navigateur, rafraîchi deux fois par seconde. */
export function FpsCounter() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let frames = 0;
    let since = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      frames += 1;
      if (now - since >= 500) {
        setFps(Math.round((frames * 1000) / (now - since)));
        frames = 0;
        since = now;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="fps tabular" data-testid="fps">
      {fps} i/s
    </div>
  );
}
