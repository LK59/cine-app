import { useEffect, useRef } from "react";
import { motion } from "../input/intents";
import { isTouchDevice } from "../lib/capability";
import { rig } from "../world/rig";
import { useStore, useT } from "../state/store";
import { SEATS, THINGS } from "../world/interactions";

/**
 * Le point de visée. Immobile quelques secondes — on regarde un film —, il s'efface en fondu ; il revient dès
 * que le regard tourne ou que l'on se déplace.
 */
function Reticle() {
  const dot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let moved = performance.now();
    let last = { yaw: rig.yaw, pitch: rig.pitch };
    const tick = (now: number) => {
      if (Math.abs(rig.yaw - last.yaw) > 0.0005 || Math.abs(rig.pitch - last.pitch) > 0.0005 || motion.forward !== 0 || motion.strafe !== 0) {
        moved = now;
        last = { yaw: rig.yaw, pitch: rig.pitch };
      }
      dot.current?.classList.toggle("is-idle", now - moved > RETICLE_IDLE_MS);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <div className="reticle" ref={dot} aria-hidden data-testid="reticle" />;
}
const RETICLE_IDLE_MS = 2500;

/** Le point de visée et ce que le visiteur peut faire d'ici — discrets, en bas de l'image. */
export function Hints() {
  const t = useT();
  const nearTv = useStore((s) => s.nearScreen !== null);
  const nearSeat = useStore((s) => s.nearSeat);
  const seated = useStore((s) => s.seated);
  const aimed = useStore((s) => s.aimedScreen !== null);
  const inRoom = useStore((s) => !!s.net.room);
  // L'indication d'une chose dépend de son état (allumer / éteindre) : relue avec lui.
  const thingHint = useStore((s) => {
    const thing = s.nearThing ? THINGS.find((candidate) => candidate.id === s.nearThing) : null;
    return thing ? thing.hint(s) : null;
  });
  // Au doigt, ces gestes sont des boutons (`TouchControls`) : la légende des touches n'a pas lieu d'être.
  if (isTouchDevice()) return <Reticle />;
  return (
    <>
      <Reticle />
      <div className="hints">
        {thingHint ? (
          <span className="hint" data-testid="hint-thing">
            <kbd>E</kbd> {t(thingHint)}
          </span>
        ) : nearTv ? (
          <span className="hint">
            <kbd>E</kbd> {t("hint.tv")}
          </span>
        ) : null}
        {/* Pendant une lecture, cliquer l'écran visé pose la télécommande (`openRemote`). */}
        {inRoom ? (
          <span className="hint" data-testid="hint-chat">
            <kbd>T</kbd> {t("chat.open")}
          </span>
        ) : null}
        {aimed && !thingHint ? (
          <span className="hint" data-testid="hint-remote">
            <kbd>{t("key.mouse")}</kbd> {t("hint.remote")}
          </span>
        ) : null}
        {seated ? (
          <>
            <span className="hint">
              <kbd>F</kbd> {t("hint.stand")}
            </span>
            <span className="hint" data-testid="hint-zoom">
              <kbd>{t("key.wheel")}</kbd> {t("hint.zoom")}
            </span>
          </>
        ) : nearSeat ? (
          <span className="hint" data-testid="hint-seat">
            <kbd>F</kbd> {t(SEATS[nearSeat].hint)}
          </span>
        ) : null}
      </div>
    </>
  );
}
