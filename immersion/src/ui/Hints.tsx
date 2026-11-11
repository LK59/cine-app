import { isTouchDevice } from "../lib/capability";
import { useStore, useT } from "../state/store";
import { SEATS, THINGS } from "../world/interactions";

/** Le point de visée et ce que le visiteur peut faire d'ici — discrets, en bas de l'image. */
export function Hints() {
  const t = useT();
  const nearTv = useStore((s) => s.nearScreen !== null);
  const nearSeat = useStore((s) => s.nearSeat);
  const seated = useStore((s) => s.seated);
  // L'indication d'une chose dépend de son état (allumer / éteindre) : relue avec lui.
  const thingHint = useStore((s) => {
    const thing = s.nearThing ? THINGS.find((candidate) => candidate.id === s.nearThing) : null;
    return thing ? thing.hint(s) : null;
  });
  // Au doigt, ces gestes sont des boutons (`TouchControls`) : la légende des touches n'a pas lieu d'être.
  if (isTouchDevice()) return <div className="reticle" aria-hidden />;
  return (
    <>
      <div className="reticle" aria-hidden />
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
