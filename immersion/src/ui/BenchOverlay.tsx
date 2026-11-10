import { useEffect } from "react";
import { cancelBench } from "../bench/bench";
import type { Key } from "../lib/i18n";
import { useStore, useT } from "../state/store";

/**
 * Pendant une mesure : ce qui est mesuré et où on en est, dans un coin — la scène doit rester telle
 * qu'un visiteur la verrait, un voile fausserait le chiffre. Échap l'interrompt.
 */
export function BenchOverlay() {
  const t = useT();
  const bench = useStore((s) => s.bench);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      cancelBench();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  if (!bench) return null;
  const overall = bench.steps ? (Math.max(0, bench.step - 1) + bench.progress) / bench.steps : 0;
  return (
    <div className="bench-overlay tabular" data-testid="bench-overlay">
      <strong>{t("bench.running")}</strong>
      <span>
        {bench.preset ? t(`quality.${bench.preset}` as Key) : "…"} · {t(bench.video ? "bench.withVideo" : "bench.screensOff")} · {bench.step}/{bench.steps}
      </span>
      <span className="bench-bar">
        <i style={{ width: `${Math.round(overall * 100)}%` }} />
      </span>
      <button type="button" className="btn btn-quiet" onClick={cancelBench} data-testid="bench-cancel">
        {t("bench.cancel")}
      </button>
    </div>
  );
}
