"use client";

import { useT } from "@/components/TranslationProvider";
import { clock, secs } from "@/components/activity/parts";
import { friseModel, type FriseMarkKind } from "@/lib/activity/frise";

const W = 1000;
const H = 200;

const MARK_COLOR: Record<FriseMarkKind, string> = {
  start: "#34d399",
  stop: "#94a3b8",
  stall: "#f43f5e",
  rebuild: "#f43f5e",
  error: "#f43f5e",
  fallback: "#f59e0b",
  audio: "#a78bfa",
  background: "#64748b",
};

/**
 * La frise d'une séance : le temps passé en abscisse, la position dans le film en ordonnée. Une
 * lecture sans histoire est une diagonale ; les sauts sont des traits verticaux, les attentes des
 * bandes orangées, l'arrière-plan des bandes grises, les incidents des points rouges.
 */
export function SeanceFrise({ lines, start, runtime }: { lines: Record<string, unknown>[]; start: number; runtime?: number | null }) {
  const t = useT();
  const m = friseModel(lines, start, runtime ?? null);
  const x = (ms: number) => (ms / m.duration) * W;
  const y = (pos: number) => H - (pos / m.top) * H;
  const hasBackground = m.bands.some((b) => b.kind === "background");
  const incidents = m.marks.filter((k) => k.kind === "stall" || k.kind === "rebuild" || k.kind === "error" || k.kind === "fallback");

  return (
    <figure className="space-y-2">
      <div className="grid grid-cols-[3rem_minmax(0,1fr)] gap-2">
        {/* L'axe des positions, en HTML : du texte dans un SVG étiré se déformerait. */}
        <div className="flex h-44 flex-col justify-between py-0.5 text-right font-mono text-[10px] text-slate-500 sm:h-52">
          <span>{clock(m.top)}</span>
          <span>{clock(m.top / 2)}</span>
          <span>0:00</span>
        </div>
        <div className="relative h-44 overflow-hidden rounded-lg bg-black/30 sm:h-52">
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" role="img" aria-label={t("activity.frise.aria")}>
            {[0.25, 0.5, 0.75].map((f) => (
              <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="rgba(255,255,255,0.05)" vectorEffect="non-scaling-stroke" />
            ))}
            {m.bands.map((b, i) => (
              <rect
                key={i}
                x={x(b.from)}
                width={Math.max(x(b.to) - x(b.from), 2)}
                y={0}
                height={H}
                fill={b.kind === "background" ? "rgba(100,116,139,0.25)" : "rgba(245,158,11,0.18)"}
              />
            ))}
            {m.runs.map((run, i) => (
              <polyline
                key={i}
                points={run.map((p) => `${x(p.t)},${y(p.pos)}`).join(" ")}
                fill="none"
                stroke="rgb(var(--accent-500))"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {m.jumps.map((j, i) => (
              <g key={i}>
                <line x1={x(j.t)} x2={x(j.t)} y1={y(j.from)} y2={y(j.to)} stroke="#38bdf8" strokeWidth={1.5} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
                <line x1={x(j.t)} x2={x(j.t + j.took)} y1={y(j.to)} y2={y(j.to)} stroke="#f59e0b" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              </g>
            ))}
          </svg>
          {/* Les repères en HTML, pour rester ronds et porter leur infobulle quelle que soit l'échelle. */}
          {m.marks.map((k, i) => (
            <span
              key={i}
              title={`${t(`activity.frise.marks.${k.kind}`)} · +${clock(k.t / 1000)} · ${clock(k.pos)}${k.label ? ` · ${k.label}` : ""}`}
              className="absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-black/60"
              style={{ left: `${(k.t / m.duration) * 100}%`, top: `${(1 - k.pos / m.top) * 100}%`, background: MARK_COLOR[k.kind] }}
            />
          ))}
        </div>
      </div>
      <div className="flex justify-between pl-14 font-mono text-[10px] text-slate-500">
        <span>+0:00</span>
        <span>+{clock(m.duration / 2000)}</span>
        <span>+{clock(m.duration / 1000)}</span>
      </div>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 pl-14 text-[11px] text-slate-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-accent-500" />
          {t("activity.frise.legend.play")}
        </span>
        {m.jumps.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-0 border-l border-dashed border-sky-400" />
            {t("activity.frise.legend.seek", { n: m.jumps.length, d: secs(m.jumps.reduce((n, j) => n + j.took, 0)) })}
          </span>
        )}
        {m.bands.some((b) => b.kind === "wait") && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-3 rounded-sm bg-amber-500/40" />
            {t("activity.frise.legend.wait")}
          </span>
        )}
        {hasBackground && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-3 rounded-sm bg-slate-500/50" />
            {t("activity.frise.legend.background")}
          </span>
        )}
        {incidents.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-rose-500" />
            {t("activity.frise.legend.incidents", { n: incidents.length })}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
