"use client";

import { useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { FileWarning, Film, Loader2, Pause, Play, ShieldCheck, Tv } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { fmtEta, fmtSize } from "@/lib/format";
import { formatTime } from "@/lib/playerClock";
import { useT, useLocale } from "@/components/TranslationProvider";
import { getDateLocale } from "@/lib/i18n";
import { useToast } from "@/components/Toast";
import { Panel } from "@/components/activity/parts";
import type { IntegrityPhase, IntegrityStatusView } from "@/lib/integrity/engine";

/**
 * Contrôle de la bibliothèque → Intégrité des fichiers (DECISIONS.md §93).
 *
 * Le bouton qui lance la première passe (puis « Reprendre » après une pause), sa progression, et la
 * liste des fichiers abîmés : titre, chemin, et chaque zone illisible avec sa position et son octet —
 * le lien ouvre la page de gestion du titre, d'où la recherche de version le remplace. Noir et blanc :
 * un fichier abîmé est un fait à corriger, pas une alarme.
 */

export const INTEGRITY_KEY = "/api/admin/library-check/integrity";
const ACTIVE: IntegrityPhase[] = ["planning", "running", "waiting-playback", "waiting-disk"];
const PAGE = 12;

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-subtle">{label}</dt>
      <dd className="truncate tabular-nums text-white">{value}</dd>
    </div>
  );
}

export function IntegrityPanel() {
  const t = useT();
  const { locale } = useLocale();
  const toast = useToast();
  const { data, mutate } = useSWR<IntegrityStatusView>(INTEGRITY_KEY, fetcher, {
    refreshInterval: (latest) => (latest && ACTIVE.includes(latest.phase) ? 3000 : 30_000),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);

  async function act(action: "start" | "pause") {
    setBusy(action);
    const res = await fetch(INTEGRITY_KEY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }).catch(() => null);
    setBusy(null);
    if (!res?.ok) toast.error(t("libraryCheck.integrity.actionFailed"));
    await mutate();
  }

  const running = !!data && ACTIVE.includes(data.phase);
  const run = data?.run ?? null;
  const unfinished = !!run && run.finishedAt === null;
  const percent = run && run.bytesTotal > 0 ? Math.min(100, Math.round((run.bytesRead / run.bytesTotal) * 100)) : run?.finishedAt ? 100 : 0;
  const damaged = (data?.problems ?? []).filter((p) => p.status === "damaged");
  const unreadable = (data?.problems ?? []).filter((p) => p.status === "error");

  return (
    <Panel
      title={t("libraryCheck.integrity.title")}
      icon={ShieldCheck}
      action={
        data &&
        (running ? (
          <button type="button" className="btn btn-sm rounded-full" disabled={busy !== null} onClick={() => void act("pause")}>
            {busy === "pause" ? <Loader2 size={14} className="animate-spin" /> : <Pause size={14} />}
            {t("libraryCheck.integrity.pause")}
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm rounded-full" disabled={busy !== null} onClick={() => void act("start")}>
            {busy === "start" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {unfinished ? t("libraryCheck.integrity.resume") : t("libraryCheck.integrity.start")}
          </button>
        ))
      }
    >
      <div className="space-y-3 border-b border-white/5 px-4 py-3 text-xs text-subtle">
        <p>{t("libraryCheck.integrity.hint")}</p>
        {data && (
          <p className="text-muted" data-testid="integrity-phase">
            {t(`libraryCheck.integrity.phase.${data.phase}`)}
            {data.current && running ? ` · ${data.current}` : ""}
          </p>
        )}
        {run && (
          <div className="space-y-2">
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
              <div className="h-full rounded-full bg-white transition-[width] duration-500" style={{ width: `${percent}%` }} />
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
              <Fact label={t("libraryCheck.integrity.files")} value={`${run.done} / ${run.total}`} />
              <Fact label={t("libraryCheck.integrity.read")} value={`${fmtSize(run.bytesRead)} / ${fmtSize(run.bytesTotal)}`} />
              <Fact label={t("libraryCheck.integrity.eta")} value={data?.etaMs != null ? fmtEta(Math.round(data.etaMs / 1000)) : "—"} />
              <Fact label={t("libraryCheck.integrity.damagedCount")} value={String(run.damaged)} />
            </dl>
            {run.finishedAt && (
              <p>
                {t("libraryCheck.integrity.finished", {
                  when: new Date(run.finishedAt).toLocaleString(getDateLocale(locale), { dateStyle: "medium", timeStyle: "short" }),
                })}
              </p>
            )}
          </div>
        )}
        {data && (
          <p>
            {t("libraryCheck.integrity.counts", { ok: data.counts.ok, damaged: data.counts.damaged, unsupported: data.counts.unsupported, error: data.counts.error })}
            {data.initialDone ? ` · ${t("libraryCheck.integrity.nightly")}` : ""}
          </p>
        )}
      </div>

      {data && damaged.length === 0 && unreadable.length === 0 && (
        <p className="px-4 py-5 text-sm text-subtle">{data.counts.ok > 0 ? t("libraryCheck.integrity.none") : t("libraryCheck.integrity.never")}</p>
      )}

      {damaged.length > 0 && (
        <ul className="divide-y divide-white/5">
          {damaged.slice(0, shown).map((f) => {
            const Icon = f.kind === "movie" ? Film : Tv;
            const href = f.serviceId !== null ? (f.kind === "movie" ? `/radarr/${f.serviceId}` : `/sonarr/${f.serviceId}`) : null;
            return (
              <li key={f.path} className="space-y-1.5 px-4 py-3.5" data-testid="integrity-damaged">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="flex min-w-0 items-center gap-2 text-sm font-medium text-white">
                    <Icon size={14} className="shrink-0 text-muted" />
                    <span className="min-w-0 break-words">{f.title ?? f.path}</span>
                  </p>
                  {href && (
                    <Link href={href} className="btn btn-sm shrink-0 rounded-full">
                      {t(f.kind === "movie" ? "libraryCheck.integrity.replaceRadarr" : "libraryCheck.integrity.replaceSonarr")}
                    </Link>
                  )}
                </div>
                <p className="break-all text-xs text-subtle">{f.path}</p>
                <ul className="flex flex-wrap gap-1.5 text-xs text-muted">
                  {f.zones.map((z) => (
                    <li key={z.byte} className="rounded-full bg-white/8 px-2.5 py-0.5 tabular-nums">
                      {t("libraryCheck.integrity.zone", { time: formatTime(z.seconds), byte: z.byte })}
                    </li>
                  ))}
                </ul>
                {(f.truncated || f.unreachableTail) && (
                  <p className="text-xs text-subtle">{t(f.truncated ? "libraryCheck.integrity.truncated" : "libraryCheck.integrity.unreachableTail")}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {damaged.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + PAGE * 4)} className="w-full border-t border-white/5 px-4 py-2.5 text-xs text-subtle hover:text-muted">
          {t("libraryCheck.showMore", { n: damaged.length - shown })}
        </button>
      )}

      {unreadable.length > 0 && (
        <div className="border-t border-white/5 px-4 py-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
            <FileWarning size={13} /> {t("libraryCheck.integrity.unreadable", { n: unreadable.length })}
          </p>
          <ul className="mt-1.5 space-y-1 text-xs text-subtle">
            {unreadable.slice(0, 20).map((f) => (
              <li key={f.path} className="break-all">
                {f.title ?? f.path} — {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
