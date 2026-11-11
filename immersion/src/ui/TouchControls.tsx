import { useEffect, useRef } from "react";
import { emit } from "../input/intents";
import { STICK_REACH, stick } from "../input/touch";
import { useStore, useT } from "../state/store";
import { SEATS, THINGS } from "../world/interactions";

/**
 * Les commandes de l'écran tactile, par-dessus le monde : le manche là où le pouce s'est posé, et à droite
 * les gestes qui ont une touche au clavier — agir sur ce que l'on a devant soi, s'asseoir ou se lever,
 * lecture ou pause, le menu. Chaque bouton émet la même intention que sa touche.
 */
export function TouchControls() {
  const t = useT();
  const walking = useStore((s) => s.phase === "world" && s.mode === "walk");
  const nearTv = useStore((s) => s.nearScreen !== null);
  const nearSeat = useStore((s) => s.nearSeat);
  const seated = useStore((s) => s.seated);
  const live = useStore((s) => s.playback.status === "playing" || s.playback.status === "paused");
  const inRoom = useStore((s) => !!s.net.room);
  const paused = useStore((s) => s.playback.wantPaused);
  const thingHint = useStore((s) => {
    const thing = s.nearThing ? THINGS.find((candidate) => candidate.id === s.nearThing) : null;
    return thing ? thing.hint(s) : null;
  });
  const base = useRef<HTMLDivElement>(null);
  const knob = useRef<HTMLDivElement>(null);

  // Le manche suit le pouce image par image, sans passer par l'état de l'interface.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const b = base.current;
      const k = knob.current;
      if (b && k) {
        b.style.opacity = stick.active ? "1" : "0";
        b.style.transform = `translate(${stick.x0}px, ${stick.y0}px)`;
        const dx = stick.x - stick.x0;
        const dy = stick.y - stick.y0;
        const scale = Math.min(1, STICK_REACH / Math.max(1, Math.hypot(dx, dy)));
        k.style.transform = `translate(${dx * scale}px, ${dy * scale}px)`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!walking) return null;
  const act = thingHint ? t(thingHint) : nearTv ? t("hint.tv") : null;
  const seat = seated ? t("hint.stand") : nearSeat ? t(SEATS[nearSeat].hint) : null;
  const press = (intent: Parameters<typeof emit>[0]) => (e: React.PointerEvent) => {
    e.preventDefault();
    emit(intent);
  };
  return (
    <div className="touch" data-testid="touch">
      <div className="touch-stick" ref={base} aria-hidden>
        <div className="touch-knob" ref={knob} />
      </div>
      <button type="button" className="touch-menu" onPointerDown={press("menu")} aria-label={t("gate.pause")} data-testid="touch-menu">
        ☰
      </button>
      {inRoom ? (
        <button type="button" className="touch-menu touch-chat" onPointerDown={press("chat")} aria-label={t("chat.open")} data-testid="touch-chat">
          💬
        </button>
      ) : null}
      <div className="touch-actions">
        {live ? (
          <button type="button" className="touch-button" onPointerDown={press("playPause")} data-testid="touch-play">
            {paused ? "▶" : "❚❚"}
          </button>
        ) : null}
        {seat ? (
          <button type="button" className="touch-button touch-wide" onPointerDown={press("sit")} data-testid="touch-sit">
            {seat}
          </button>
        ) : null}
        {act ? (
          <button type="button" className="touch-button touch-wide touch-main" onPointerDown={press("interact")} data-testid="touch-act">
            {act}
          </button>
        ) : null}
      </div>
    </div>
  );
}
