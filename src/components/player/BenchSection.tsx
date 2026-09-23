"use client";

import { useState, useSyncExternalStore } from "react";
import useSWR from "swr";
import { FlaskConical, Play } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { benchStore, startBench } from "@/lib/playerBench/store";
import { estimateSeconds, type BenchDepth } from "@/lib/playerBench/runner";
import type { BenchCandidate } from "@/lib/playerBench/plan";
import type { BenchRunSummary } from "@/app/api/player/bench/route";

/**
 * Le banc d'essai du lecteur, lancé depuis le panneau Compte — administrateur seulement.
 *
 * Il se lance d'ici plutôt que depuis la gestion parce que c'est ici qu'on est, sur le téléphone
 * qu'on veut éprouver. Les films sont proposés par le journal du lecteur (voir `plan.ts`), cochés
 * d'office, et chacun peut être retiré ou ajouté.
 */
export function BenchSection() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { data: plan } = useSWR<{ candidates: BenchCandidate[]; suggested: string[] }>(open ? "/api/player/bench/plan" : null, fetcher);
  const { data: history } = useSWR<{ runs: BenchRunSummary[] }>(open ? "/api/player/bench" : null, fetcher);
  // `null` : la sélection proposée, tant qu'on n'y a pas touché.
  const [picked, setPicked] = useState<string[] | null>(null);
  const [depth, setDepth] = useState<BenchDepth>("full");
  const [interactive, setInteractive] = useState(true);
  const running = useSyncExternalStore(benchStore.subscribe, () => benchStore.get().phase === "running", () => false);

  const selection = picked ?? plan?.suggested ?? [];
  const toggle = (id: string) =>
    setPicked((current) => {
      const base = current ?? plan?.suggested ?? [];
      return base.includes(id) ? base.filter((x) => x !== id) : [...base, id];
    });
  const minutes = Math.max(1, Math.round(estimateSeconds(depth, selection.length, interactive) / 60));

  const launch = () => {
    if (!plan) return;
    const items = plan.candidates.filter((c) => selection.includes(c.itemId)).map((c) => ({ itemId: c.itemId, title: c.title }));
    if (items.length === 0) return;
    startBench({ runId: `banc-${Date.now().toString(36)}`, items, depth, interactive });
  };

  return (
    <section className="border-t border-white/10 py-7 [@media(max-height:500px)]:py-4">
      <h2 className="mb-4 flex items-center gap-2.5 text-sm font-semibold text-white [@media(max-height:500px)]:mb-2.5">
        <FlaskConical size={16} className="text-subtle" />
        {t("bench.title")}
      </h2>
      <p className="mb-3 text-xs text-subtle">{t("bench.hint")}</p>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="btn btn-ghost w-full justify-center sm:w-auto">
          <FlaskConical size={16} />
          {t("bench.prepare")}
        </button>
      ) : !plan ? (
        <p className="text-sm text-muted">{t("bench.loading")}</p>
      ) : plan.candidates.length === 0 ? (
        <p className="text-sm text-muted">{t("bench.empty")}</p>
      ) : (
        <div className="space-y-4">
          <ul className="max-h-80 space-y-1 overflow-y-auto rounded-xl border border-white/10 bg-white/5 p-2">
            {plan.candidates.map((c) => (
              <li key={c.itemId}>
                <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5">
                  <input type="checkbox" checked={selection.includes(c.itemId)} onChange={() => toggle(c.itemId)} className="accent-current text-accent-500" />
                  <span className="min-w-0 flex-1 truncate text-sm text-white">{c.title}</span>
                  <span className="flex shrink-0 flex-wrap justify-end gap-1">
                    {c.tags.map((tag) => (
                      <span key={tag} className="rounded bg-white/10 px-1.5 py-0.5 text-[11px] text-muted">
                        {tag}
                      </span>
                    ))}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap gap-2">
            {(["full", "quick", "extreme"] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDepth(d)}
                className={`rounded-full px-3 py-1.5 text-xs ${depth === d ? "bg-accent-500 text-white" : "bg-white/10 text-muted"}`}
              >
                {t(d === "full" ? "bench.depthFull" : d === "quick" ? "bench.depthQuick" : "bench.depthExtreme")}
              </button>
            ))}
            <label className="flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-xs text-muted">
              <input type="checkbox" checked={interactive} onChange={(e) => setInteractive(e.target.checked)} />
              {t("bench.interactive")}
            </label>
          </div>
          <p className="text-xs text-subtle">
            {t("bench.estimate", { n: selection.length, min: minutes })} {interactive ? t("bench.interactiveHint") : ""}
          </p>

          <button type="button" disabled={running || selection.length === 0} onClick={launch} className="btn btn-primary w-full justify-center sm:w-auto">
            <Play size={16} />
            {running ? t("bench.running") : t("bench.start")}
          </button>

          <div>
            <h3 className="mb-2 text-xs font-semibold text-muted">{t("bench.lastRuns")}</h3>
            {!history?.runs.length ? (
              <p className="text-xs text-subtle">{t("bench.noRuns")}</p>
            ) : (
              <ul className="space-y-1 text-xs text-muted">
                {history.runs.map((run) => {
                  const fails = run.items.filter((i) => i.verdict === "fail").length;
                  const warns = run.items.filter((i) => i.verdict === "warn").length;
                  return (
                    <li key={run.runId} className="flex gap-2">
                      <span className="shrink-0 tabular-nums">{new Date(run.startedAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
                      <span className="min-w-0 truncate">
                        {agentName(run.agent)} · {t("bench.runLine", { n: run.items.length, fail: fails, warn: warns })}
                        {run.finished ? "" : ` · ${t("bench.unfinished")}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** Le navigateur, en un mot : ce qui distingue deux séries lancées depuis deux appareils. */
function agentName(agent: string): string {
  if (/iPhone|iPad/.test(agent)) return /iPad/.test(agent) ? "iPad" : "iPhone";
  if (/Android/.test(agent)) return "Android";
  if (/Firefox/.test(agent)) return "Firefox";
  if (/Edg\//.test(agent)) return "Edge";
  if (/Chrome/.test(agent)) return "Chrome";
  if (/Safari/.test(agent)) return "Safari";
  return "?";
}
