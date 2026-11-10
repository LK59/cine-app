import { useStore, useT } from "../state/store";

/** Le point de visée et ce que le visiteur peut faire d'ici — discrets, en bas de l'image. */
export function Hints() {
  const t = useT();
  const nearTv = useStore((s) => s.nearTv);
  const nearSofa = useStore((s) => s.nearSofa);
  const seated = useStore((s) => s.seated);
  return (
    <>
      <div className="reticle" aria-hidden />
      <div className="hints">
        {nearTv ? (
          <span className="hint">
            <kbd>E</kbd> {t("hint.tv")}
          </span>
        ) : null}
        {seated ? (
          <span className="hint">
            <kbd>F</kbd> {t("hint.stand")}
          </span>
        ) : nearSofa ? (
          <span className="hint">
            <kbd>F</kbd> {t("hint.sit")}
          </span>
        ) : null}
      </div>
    </>
  );
}
