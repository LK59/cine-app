"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { FlaskConical, Square, CircleCheckBig, CircleAlert, CircleX, CircleMinus, X } from "lucide-react";
import { usePlayback } from "@/components/PlaybackProvider";
import { useT } from "@/components/TranslationProvider";
import { benchHandedOver, benchBridge } from "@/lib/playerBench/bridge";
import {
  benchStore,
  benchAddResult,
  benchAnswer,
  benchAsk,
  benchProgress,
  cancelBench,
  dismissBench,
  finishBench,
} from "@/lib/playerBench/store";
import type { CheckResult, ItemResult } from "@/lib/playerBench/runner";

/**
 * Le banc d'essai en marche : il joue les scénarios et se montre par-dessus le lecteur.
 *
 * Monté une fois à la racine, sous `PlaybackProvider` — c'est d'elle qu'il ouvre et ferme les
 * films, exactement comme le ferait un bouton « Lecture ». Il ne fait rien tant qu'aucun banc
 * n'est demandé (`BenchGate` ne le monte même pas).
 */

function post(body: Record<string, unknown>): void {
  void fetch("/api/player/bench", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive: false,
  }).catch(() => {});
}

export function BenchGate() {
  const phase = useSyncExternalStore(benchStore.subscribe, () => benchStore.get().phase, () => "idle" as const);
  return phase === "idle" ? null : <BenchRunner />;
}

function BenchRunner() {
  const t = useT();
  const playback = usePlayback();
  const state = useSyncExternalStore(benchStore.subscribe, benchStore.get, benchStore.idle);
  const playbackRef = useRef(playback);
  useEffect(() => {
    playbackRef.current = playback;
  }, [playback]);
  const startedRef = useRef<string | null>(null);

  useEffect(() => {
    const config = state.config;
    if (state.phase !== "running" || !config || startedRef.current === config.runId) return;
    startedRef.current = config.runId;
    let lock: { release(): Promise<void> } | null = null;
    void (async () => {
      // L'écran reste allumé : un téléphone qui se met en veille au milieu d'un banc mesurerait
      // la veille, pas le lecteur.
      try {
        lock = await (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen") ?? null;
      } catch {
        lock = null;
      }
      const { runBench } = await import("@/lib/playerBench/runner");
      const results = await runBench(config, {
        open: (item) =>
          playbackRef.current.play({ itemId: item.itemId, title: item.title, resumeAt: 0, bench: config.runId }),
        close: () => playbackRef.current.close(),
        bridge: benchBridge,
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        ask: benchAsk,
        progress: benchProgress,
        cancelled: () => benchStore.get().cancelled,
        hidden: () => document.visibilityState === "hidden",
        handedOver: benchHandedOver,
        report: (result) => {
          benchAddResult(result);
          post({ kind: "item", runId: config.runId, depth: config.depth, interactive: config.interactive, ...result });
        },
      });
      const started = benchStore.get().startedAt;
      post({
        kind: "run",
        runId: config.runId,
        depth: config.depth,
        interactive: config.interactive,
        cancelled: benchStore.get().cancelled,
        elapsedMs: Date.now() - started,
        items: results.map((r) => ({ itemId: r.itemId, title: r.title, verdict: r.verdict })),
      });
      await (lock as { release(): Promise<void> } | null)?.release().catch(() => {});
      finishBench();
    })();
  }, [state.phase, state.config]);

  if (typeof document === "undefined") return null;
  const total = state.config?.items.length ?? 0;
  const current = state.config?.items[state.itemIndex];

  return createPortal(
    <>
      {state.phase === "running" && (
        <div className="pointer-events-none fixed inset-x-0 top-0 z-[200] flex justify-center p-2" style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}>
          <div className="pointer-events-auto flex max-w-[min(40rem,100%)] items-center gap-3 rounded-full border border-white/15 bg-black/80 py-1.5 pl-4 pr-1.5 text-xs text-white backdrop-blur">
            <FlaskConical size={14} className="shrink-0 text-accent-400" />
            <span className="min-w-0 truncate">
              {t("bench.progress", { n: Math.min(state.itemIndex + 1, total), total })} · {current?.title ?? ""} ·{" "}
              <span className="text-muted">{state.step}</span>
            </span>
            <button type="button" onClick={cancelBench} className="flex shrink-0 items-center gap-1 rounded-full bg-white/10 px-3 py-1.5 hover:bg-white/20">
              <Square size={12} /> {t("bench.stop")}
            </button>
          </div>
        </div>
      )}

      {state.question && (
        <div className="fixed inset-x-0 bottom-0 z-[200] flex justify-center p-3" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
          <div className="w-full max-w-md rounded-2xl border border-white/15 bg-black/85 p-4 text-white shadow-2xl backdrop-blur">
            <p className="mb-3 text-sm">{t(`bench.question.${state.question.id}`)}</p>
            {state.question.kind === "tap" ? (
              <button
                type="button"
                onClick={() => {
                  state.question?.onTap?.();
                  benchAnswer("yes");
                }}
                className="btn btn-primary w-full justify-center"
              >
                {t("bench.tapToPlay")}
              </button>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                <button type="button" onClick={() => benchAnswer("yes")} className="btn btn-primary justify-center">{t("bench.yes")}</button>
                <button type="button" onClick={() => benchAnswer("no")} className="btn btn-ghost justify-center text-danger">{t("bench.no")}</button>
                <button type="button" onClick={() => benchAnswer("skip")} className="btn btn-ghost justify-center">{t("bench.skip")}</button>
              </div>
            )}
          </div>
        </div>
      )}

      {state.phase === "done" && <BenchResults results={state.results} elapsedMs={state.finishedAt - state.startedAt} />}
    </>,
    document.body
  );
}

const ICONS = {
  ok: <CircleCheckBig size={14} className="shrink-0 text-success" />,
  warn: <CircleAlert size={14} className="shrink-0 text-warning" />,
  fail: <CircleX size={14} className="shrink-0 text-danger" />,
  skip: <CircleMinus size={14} className="shrink-0 text-subtle" />,
};

/** « seek-random-3 » → la clé « seek-random » et le numéro 3 ; « question:sync » → « question ». */
export function checkLabelKey(id: string): { key: string; suffix: string } {
  if (id.startsWith("question:")) return { key: "question", suffix: "" };
  const known = [
    "open", "play", "seek-far", "seek-back-10", "seek-forward-30", "seek-random", "seek-back-far", "seek-near-end",
    "seek-return", "seeks", "burst", "pause", "paused-seek", "seek-then-audio", "audio-paused", "audio-back-play",
    "audio", "subtitles", "long-play", "lost", "cancelled",
    "x-storm", "x-pingpong", "x-steps", "x-seek-audio-seek", "x-audio-storm", "x-pause-storm", "x-subs-storm",
    "x-edge-start", "x-edge-end", "x-after-end", "x-beyond-end", "x-reopen",
  ];
  const play = /^audio-\d+-play$/.test(id);
  if (play) return { key: "audio-play", suffix: "" };
  for (const key of known) {
    if (id === key) return { key, suffix: "" };
    if (id.startsWith(`${key}-`) && /^\d+$/.test(id.slice(key.length + 1))) return { key, suffix: key === "seek-random" ? ` ${id.slice(key.length + 1)}` : "" };
  }
  return { key: "", suffix: id };
}

function BenchResults({ results, elapsedMs }: { results: ItemResult[]; elapsedMs: number }) {
  const t = useT();
  const all = results.flatMap((r) => r.checks);
  const count = (v: CheckResult["verdict"]) => all.filter((c) => c.verdict === v).length;
  const label = (c: CheckResult) => {
    const { key, suffix } = checkLabelKey(c.id);
    return (key ? t(`bench.checks.${key}`) : "") + suffix;
  };
  return (
    <div className="fixed inset-0 z-[200] flex items-end justify-center bg-black/60 p-3 sm:items-center" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-white/15 bg-ink text-white shadow-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-white/10 p-4">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <FlaskConical size={16} className="text-accent-400" /> {t("bench.done")}
            </h2>
            <p className="mt-1 text-xs text-muted">
              {t("bench.summary", { ok: count("ok"), warn: count("warn"), fail: count("fail") })} ·{" "}
              {t("bench.elapsed", { min: Math.max(1, Math.round(elapsedMs / 60000)) })}
            </p>
          </div>
          <button type="button" onClick={dismissBench} className="rounded-full p-1.5 hover:bg-white/10" aria-label={t("bench.close")}>
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto p-4 text-xs">
          {results.map((r) => (
            <details key={r.itemId + r.elapsedMs} className="mb-3 rounded-xl border border-white/10 bg-white/5" open={r.verdict !== "ok" && r.verdict !== "skip"}>
              <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
                {ICONS[r.verdict]} <span className="min-w-0 truncate">{r.title}</span>
                <span className="ml-auto shrink-0 text-xs text-subtle">{r.path ?? "—"} · {Math.round(r.elapsedMs / 1000)} s</span>
              </summary>
              <ul className="space-y-1.5 px-3 pb-3">
                {r.checks.map((c, i) => (
                  <li key={i} className="flex gap-2">
                    {ICONS[c.verdict]}
                    <div className="min-w-0">
                      <span className="text-white">{label(c)}</span>
                      <span className="block break-words text-subtle">{c.detail}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          ))}
          <p className="text-subtle">{t("bench.savedHint")}</p>
        </div>
      </div>
    </div>
  );
}
