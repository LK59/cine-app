import { useEffect, useRef, type MouseEvent, type PointerEvent, type WheelEvent } from "react";
import { isTouchDevice } from "../lib/capability";
import { dispatch } from "../media/commands";
import { closeRemote, openPanel } from "../state/actions";
import { useStore, useT } from "../state/store";
import { useTrackLabels } from "./trackLabels";

const stamp = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
};

/** Au doigt, la télécommande s'en va seule après ce délai sans la toucher (rendre le regard n'y demande aucun geste). */
const TOUCH_IDLE_MS = 8000;
/** La molette sur la barre : un saut par cran, pas un par événement (un pavé tactile en envoie des dizaines). */
const WHEEL_STEP = 60;

/**
 * La télécommande : une barre discrète au bas de l'image, pour ce qu'on fait sans quitter le film des yeux —
 * lecture ou pause, −10 s, +30 s, aller à un instant (clic sur la barre, ou molette dessus), les sous-titres. Le
 * panneau complet (pistes audio, son, bibliothèque) reste à un bouton.
 *
 * Elle paraît quand on clique ou touche l'écran pendant une lecture (`select` dans `state/actions.ts`) ; un clic
 * ou un toucher hors d'elle, ou Échap, la retire et rend le regard. Tout passe par les commandes, comme le panneau.
 */
export function Remote() {
  const t = useT();
  const playback = useStore((s) => s.playback);
  const { subtitles } = useTrackLabels();
  const touch = isTouchDevice();
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheel = useRef(0);

  const keepAlive = () => {
    if (!touch) return;
    if (idle.current) clearTimeout(idle.current);
    idle.current = setTimeout(closeRemote, TOUCH_IDLE_MS);
  };
  // Le délai part à l'ouverture ; chaque geste dans la barre le relance.
  useEffect(() => {
    if (touch) idle.current = setTimeout(closeRemote, TOUCH_IDLE_MS);
    return () => {
      if (idle.current) clearTimeout(idle.current);
    };
  }, [touch]);

  const ratio = playback.duration > 0 ? Math.min(1, playback.position / playback.duration) : 0;
  const seekTo = (e: MouseEvent<HTMLButtonElement>) => {
    // Activée au clavier (Espace, Entrée sur la barre focalisée), le clic n'a pas de position : il menait au début.
    if (e.detail === 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width > 0 && playback.duration > 0) dispatch({ type: "seek", to: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * playback.duration });
  };
  const onWheel = (e: WheelEvent) => {
    wheel.current += e.deltaY;
    if (Math.abs(wheel.current) < WHEEL_STEP) return;
    // Vers le haut : en avant, comme une molette qui fait défiler le temps.
    dispatch({ type: "seekBy", delta: wheel.current < 0 ? 10 : -10 });
    wheel.current = 0;
  };
  const outside = (e: PointerEvent) => {
    e.preventDefault();
    closeRemote();
  };

  return (
    <>
      <div className="remote-backdrop" onPointerDown={outside} data-testid="remote-backdrop" />
      <div className="remote" role="group" aria-label={t("hint.remote")} onPointerDown={keepAlive} data-testid="remote">
        <div className="remote-head">
          <span className="remote-title">{playback.title}</span>
          <button type="button" className="chip" onClick={() => openPanel()} data-testid="remote-panel">
            {t("hint.tv")}
          </button>
          <button type="button" className="chip" onClick={closeRemote} aria-label={t("panel.close")} data-testid="remote-close">
            ✕
          </button>
        </div>
        <div className="now-progress">
          <span className="tabular">{stamp(playback.position)}</span>
          <button type="button" className="now-bar" onClick={seekTo} onWheel={onWheel} aria-label={t("panel.seek")} data-testid="remote-bar">
            <span style={{ transform: `scaleX(${ratio})` }} />
          </button>
          <span className="tabular">{playback.duration > 0 ? stamp(playback.duration) : ""}</span>
        </div>
        <div className="remote-controls">
          <button type="button" className="chip" onClick={() => dispatch({ type: "seekBy", delta: -10 })} aria-label={t("panel.back10")} data-testid="remote-back">
            −10 s
          </button>
          <button type="button" className="chip chip-on remote-toggle" onClick={() => dispatch({ type: "toggle" })} data-testid="remote-toggle">
            {playback.wantPaused ? `▶ ${t("panel.play")}` : `❚❚ ${t("panel.pause")}`}
          </button>
          <button type="button" className="chip" onClick={() => dispatch({ type: "seekBy", delta: 30 })} aria-label={t("panel.forward30")} data-testid="remote-forward">
            +30 s
          </button>
          {subtitles.length > 0 ? (
            <label className="now-track remote-subtitles">
              <span>{t("panel.subtitles")}</span>
              <select
                value={playback.subtitleIndex ?? ""}
                onChange={(e) => {
                  keepAlive();
                  dispatch({ type: "subtitle", index: e.target.value === "" ? null : Number(e.target.value) });
                }}
                data-testid="remote-subtitles"
              >
                <option value="">{t("panel.subtitles.none")}</option>
                {subtitles.map((track) => (
                  <option key={track.number} value={track.number}>
                    {track.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </div>
    </>
  );
}
