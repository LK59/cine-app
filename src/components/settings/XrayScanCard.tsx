"use client";

import { useState } from "react";
import useSWR from "swr";
import { Loader2, Pause, Play, Zap } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { ErrorState } from "@/components/StateViews";
import type { ScanAction, ScanTierStatus, XrayScanStatus } from "@/lib/xray/scheduler";

/**
 * Configuration → Acteurs à l'écran : l'analyse de la bibliothèque en fond (DECISIONS.md §138,
 * « Le planificateur de la bibliothèque »), sur le modèle de la recherche de répliques (§88,
 * `DialogueSearchCard`) — l'état d'ensemble, puis une carte par palier avec sa progression, ses heures
 * de vidéo, son temps restant et ses gestes (« Lancer maintenant », « Mettre en pause » / « Reprendre »,
 * « Ne plus forcer »). Rafraîchie toutes les cinq secondes pendant l'analyse, sinon au calme.
 */

const ACTIVE: XrayScanStatus["phase"][] = ["planning", "running"];

type T = ReturnType<typeof useT>;

/** Une durée lisible, en jours au-delà d'un jour — l'analyse d'une bibliothèque se compte en semaines. */
export function fmtScanDuration(seconds: number | null, t: T): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return t("xrayScan.duration.days", { d, h });
  if (h > 0) return t("xrayScan.duration.hours", { h, m });
  return t("xrayScan.duration.minutes", { m: Math.max(m, s > 0 ? 1 : 0) });
}

const fmtHours = (h: number) => (h >= 100 ? Math.round(h).toLocaleString() : (Math.round(h * 10) / 10).toLocaleString());

export function XrayScanCard() {
  const t = useT();
  const toast = useToast();
  const { data, error, mutate } = useSWR<XrayScanStatus>("/api/admin/xray/scan", fetcher, {
    refreshInterval: (latest) => (latest && ACTIVE.includes(latest.phase) ? 5000 : 20_000),
  });
  const [busy, setBusy] = useState<string | null>(null);

  if (!data && error) return <ErrorState message={t("common.error")} onRetry={() => void mutate()} />;
  if (!data) return <Loader2 className="animate-spin text-subtle" />;

  if (!data.configured) {
    return (
      <section className="settings-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
        <h3 className="text-base font-semibold text-white">{t("xrayScan.title")}</h3>
        <p className="mt-1 text-sm text-muted">{t("xrayScan.off")}</p>
      </section>
    );
  }

  async function act(action: ScanAction, tier: number | null) {
    const key = `${action}:${tier ?? "all"}`;
    setBusy(key);
    const res = await fetch("/api/admin/xray/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, tier }) }).catch(() => null);
    setBusy(null);
    if (!res?.ok) toast.error(t("xrayScan.actionFailed"));
    await mutate();
  }

  const allPaused = data.tiers.every((tier) => tier.paused);
  const current = data.current;

  return (
    <div className="space-y-4">
      <section className="settings-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5" data-testid="xray-scan-overview">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-white">{t("xrayScan.title")}</h3>
            <p className="mt-1 text-sm text-muted">{t(`xrayScan.phase.${data.phase}`)}</p>
          </div>
          <button type="button" className="btn btn-sm rounded-full" disabled={busy !== null} onClick={() => void act(allPaused ? "resume" : "pause", null)}>
            {allPaused ? <Play size={14} /> : <Pause size={14} />}
            {t(allPaused ? "xrayScan.resumeAll" : "xrayScan.pauseAll")}
          </button>
        </div>
        <div className="mt-3 space-y-1 text-xs text-subtle">
          {current && (
            <p className="truncate text-white">
              {current.title
                ? t("xrayScan.current", { title: current.title, percent: Math.round(current.progress * 100) })
                : t("xrayScan.currentOther", { percent: Math.round(current.progress * 100) })}
            </p>
          )}
          <p>{data.speed !== null ? t("xrayScan.speed", { x: data.speed.toLocaleString() }) : t("xrayScan.speedUnknown")}</p>
          <p>{t("xrayScan.etaAll", { eta: fmtScanDuration(data.etaAllS, t) })}</p>
          {data.plannedAt && <p>{t("xrayScan.plannedAt", { date: new Date(data.plannedAt).toLocaleString() })}</p>}
          {data.lastError && <p className="text-warning">{t("xrayScan.lastError", { error: data.lastError })}</p>}
        </div>
      </section>

      {data.tiers.map((tier) => (
        <TierCard key={tier.tier} tier={tier} busy={busy} onAct={(action) => void act(action, tier.tier)} t={t} />
      ))}

      <p className="px-1 text-xs text-subtle">
        {t("xrayScan.excludedWhy")} {t("xrayScan.etaNote")}
      </p>

      {data.errors.length > 0 && (
        <section className="settings-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5">
          <details>
            <summary className="cursor-pointer text-sm text-warning">{t("xrayScan.errors")}</summary>
            <ul className="mt-2 divide-y divide-white/5">
              {data.errors.map((e) => (
                <li key={e.itemId} className="py-1.5 text-xs">
                  <span className="text-white">{e.title}</span>
                  <span className="text-subtle"> — {e.error}</span>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
    </div>
  );
}

function TierCard({ tier, busy, onAct, t }: { tier: ScanTierStatus; busy: string | null; onAct: (action: ScanAction) => void; t: T }) {
  const percent = tier.total > 0 ? Math.min(100, Math.round((tier.done / tier.total) * 100)) : 100;
  const mine = (action: ScanAction) => busy === `${action}:${tier.tier}`;
  return (
    <section className="settings-card rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5" data-testid={`xray-scan-tier-${tier.tier}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-white">{t(`xrayScan.tier.${tier.tier}`)}</h3>
          <p className="mt-1 text-sm text-muted">{t(`xrayScan.tierWhy.${tier.tier}`)}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {tier.forced ? (
            <button type="button" aria-pressed className="btn btn-primary btn-sm rounded-full" disabled={busy !== null} onClick={() => onAct("unforce")}>
              {mine("unforce") ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
              {t("xrayScan.unforce")}
            </button>
          ) : (
            <button type="button" className="btn btn-primary btn-sm rounded-full" disabled={busy !== null} onClick={() => onAct("run")}>
              {mine("run") ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
              {t("xrayScan.runNow")}
            </button>
          )}
          {tier.paused ? (
            <button type="button" className="btn btn-sm rounded-full" disabled={busy !== null} onClick={() => onAct("resume")}>
              {mine("resume") ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
              {t("xrayScan.resume")}
            </button>
          ) : (
            <button type="button" className="btn btn-sm rounded-full" disabled={busy !== null} onClick={() => onAct("pause")}>
              {mine("pause") ? <Loader2 size={14} className="animate-spin" /> : <Pause size={14} />}
              {t("xrayScan.pause")}
            </button>
          )}
        </div>
      </div>
      {(tier.forced || tier.paused) && <p className={`mt-2 text-xs ${tier.forced ? "text-warning" : "text-subtle"}`}>{t(tier.forced ? "xrayScan.forced" : "xrayScan.paused")}</p>}
      <div className="mt-4 space-y-2">
        <div className="h-2 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="h-full rounded-full bg-white transition-[width] duration-500" style={{ width: `${percent}%` }} />
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <Fact label={t("xrayScan.done")} value={`${tier.done.toLocaleString()} / ${tier.total.toLocaleString()}`} />
          <Fact label={t("xrayScan.hours")} value={t("xrayScan.hoursValue", { done: fmtHours(tier.hoursDone), total: fmtHours(tier.hoursTotal) })} />
          <Fact label={t("xrayScan.eta")} value={fmtScanDuration(tier.etaS, t)} />
          <Fact label={t("xrayScan.queued")} value={String(tier.queued)} />
          <Fact label={t("xrayScan.failed")} value={String(tier.failed)} />
          <Fact label={t("xrayScan.excluded")} value={String(tier.excluded)} />
        </dl>
      </div>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="tabular-nums text-white">{value}</dd>
    </div>
  );
}
