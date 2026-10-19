"use client";

import useSWR from "swr";
import { AlertTriangle, CheckCircle2, Download, HardDrive, ListTree, Loader2, RefreshCw } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { apiAction } from "@/lib/apiAction";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { ConfirmButton, Panel, Tile, ago, describeDownload, fullDate, hours, size } from "@/components/activity/parts";
import { ActivityLink } from "@/components/activity/nav";
import type { DownloadsOverview, OfflineCopyView } from "@/lib/activity/offlineDownloads";

export const DOWNLOADS_ADMIN_KEY = "/api/admin/offline";

const STATUS_TONE: Record<OfflineCopyView["status"], string> = {
  done: "bg-success/15 text-success",
  running: "bg-sky-500/15 text-sky-300",
  queued: "bg-white/10 text-muted",
  failed: "bg-danger/15 text-danger",
};

/** Les quatre chiffres — partagés par la vue d'ensemble et la vue dédiée. */
export function DownloadsTiles({ data }: { data: DownloadsOverview }) {
  const t = useT();
  const { totals } = data;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Tile icon={CheckCircle2} label={t("activity.downloads.ready")} value={totals.ready} tone={totals.ready ? "good" : "default"} />
      <Tile
        icon={Loader2}
        label={t("activity.downloads.preparing")}
        value={totals.preparing}
        hint={totals.queued ? t("activity.downloads.queuedHint", { n: totals.queued }) : undefined}
      />
      <Tile icon={AlertTriangle} label={t("activity.downloads.failed")} value={totals.failed} tone={totals.failed ? "warn" : "default"} />
      <Tile
        icon={HardDrive}
        label={t("activity.downloads.disk")}
        value={size(totals.usedBytes) ?? "0"}
        hint={totals.freeBytes != null ? t("activity.downloads.free", { size: size(totals.freeBytes) ?? "0" }) : undefined}
      />
    </div>
  );
}

/** Une version du serveur : titre, état, réglages, taille, qui l'attend, et quand elle partira. */
function CopyRow({ c, now, onDelete }: { c: OfflineCopyView; now: number; onDelete: () => Promise<void> }) {
  const t = useT();
  const share = c.expectedBytes > 0 ? Math.min(1, c.bytes / c.expectedBytes) : 0;
  const took = c.status === "done" && c.startedAt && c.finishedAt ? c.finishedAt - c.startedAt : null;
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3" data-testid="offline-copy">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium text-white">{c.title ?? c.itemId}</span>
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_TONE[c.status]}`}>{t(`activity.downloads.status.${c.status}`)}</span>
        </p>
        <p className="mt-0.5 truncate text-xs text-subtle">
          {[t(`activity.downloads.quality.${c.quality}`), c.codec === "hevc" ? "HEVC" : "H.264", c.audio].filter(Boolean).join(" · ")}
        </p>
        {c.status === "running" ? (
          <>
            <span className="mt-1.5 block h-1 w-full max-w-sm overflow-hidden rounded-full bg-white/10">
              <span className="block h-full rounded-full bg-accent-500" style={{ width: `${Math.round(share * 100)}%` }} />
            </span>
            <p className="mt-1 text-xs text-muted">
              {t("activity.downloads.progress", { done: size(c.bytes) ?? "0", total: size(c.expectedBytes) ?? "?", pct: Math.round(share * 100) })}
            </p>
          </>
        ) : (
          <p className="mt-1 text-xs text-muted">
            {[
              size(c.bytes),
              took != null && t("activity.downloads.took", { d: hours(took / 1000) }),
              took && c.runtimeSeconds ? `×${Math.round((c.runtimeSeconds / (took / 1000)) * 10) / 10}` : null,
              c.status === "failed" && c.error,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
        <p className="mt-1 text-xs text-subtle">
          {c.accounts.length ? t("activity.downloads.forAccounts", { who: c.accounts.join(", ") }) : t("activity.downloads.nobody")}
          {c.status === "done" && <> · {t("activity.downloads.lastAccess", { when: ago(c.accessedAt, now, t) })}</>}
          {c.expiresAt != null && <> · {t("activity.downloads.expiresOn", { date: fullDate(c.expiresAt) })}</>}
        </p>
      </div>
      <ConfirmButton label={t("activity.downloads.delete")} confirm={t("activity.downloads.deleteConfirm")} danger onConfirm={onDelete} />
    </li>
  );
}

/**
 * Les téléchargements vus de l'activité (19/10/2026) : les versions hors ligne que le serveur garde
 * en ce moment — prêtes, en préparation, échouées — et les derniers gestes de chacun, depuis
 * `server.log` (`offline/events.ts`, `logDownload`). Effacer une version la retire du serveur ; les
 * appareils qui l'ont déjà entière la gardent.
 */
export function ActivityDownloads() {
  const t = useT();
  const toast = useToast();
  const { data, isLoading, mutate } = useSWR<DownloadsOverview>(DOWNLOADS_ADMIN_KEY, fetcher, { refreshInterval: 15_000 });

  if (isLoading && !data) return <LoadingState />;
  if (!data) return <ErrorState message={t("activity.loadError")} onRetry={() => mutate()} />;

  const remove = async (id: string) => {
    try {
      await apiAction(`${DOWNLOADS_ADMIN_KEY}/${id}`, { method: "DELETE" });
      await mutate();
      toast.success(t("activity.downloads.deleted"));
    } catch (error) {
      toast.error(error instanceof Error && error.message ? error.message : t("common.error"));
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">{t("activity.downloads.intro", { n: data.keepDays })}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => mutate()} className="btn-ghost px-3 py-1.5 text-xs">
            <RefreshCw size={14} />
            <span className="hidden sm:inline">{t("activity.refresh")}</span>
          </button>
        </div>
      </div>

      <DownloadsTiles data={data} />

      <Panel title={t("activity.downloads.copies", { n: data.copies.length })} icon={HardDrive}>
        {data.copies.length ? (
          <ul className="divide-y divide-white/5">
            {data.copies.map((c) => (
              <CopyRow key={c.id} c={c} now={data.now} onDelete={() => remove(c.id)} />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-subtle">{t("activity.downloads.noCopies")}</p>
        )}
      </Panel>

      <Panel
        title={t("activity.downloads.events", { n: data.eventsDays })}
        icon={Download}
        action={
          <ActivityLink to={{ kind: "logs", preset: { source: "server", type: "offline" } }} className="inline-flex items-center gap-1 text-xs text-accent-400 hover:underline">
            <ListTree size={12} />
            {t("activity.logs.open")}
          </ActivityLink>
        }
      >
        {data.events.length ? (
          <ul className="scrollbar-thin max-h-[32rem] divide-y divide-white/5 overflow-y-auto">
            {data.events.map((e) => (
              <li key={`${e._file}:${e._line}`} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 px-4 py-2 text-sm sm:grid-cols-[8.5rem_7rem_1fr]" data-testid="download-event">
                <span className="text-xs tabular-nums text-subtle">{fullDate(e._t)}</span>
                <span className="truncate text-xs text-muted">{typeof e.user === "string" ? e.user : "—"}</span>
                <span className={`col-span-2 min-w-0 break-words sm:col-span-1 ${e.level === "error" ? "text-danger" : "text-white"}`}>{describeDownload(e, t)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-subtle">{t("activity.downloads.noEvents")}</p>
        )}
      </Panel>
    </div>
  );
}
