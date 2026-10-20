"use client";

import { useMemo, useState } from "react";
import useSWR from "swr";
import { Clock, Copy, HardDrive, Link2, PlayCircle, RefreshCw } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { apiAction } from "@/lib/apiAction";
import { useToast } from "@/components/Toast";
import { useLocale, useT } from "@/components/TranslationProvider";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { ConfirmButton, Panel, Tile, ago, clock, fullDate, hours, size } from "@/components/activity/parts";
import { SHARE_ADMIN_KEY, SHARE_EXTEND_CHOICES, copyText, shareErrorText, shareUrl } from "@/components/share/shareClient";
import type { ShareState, ShareSummary } from "@/lib/share/overview";

export interface SharesOverview {
  now: number;
  shares: ShareSummary[];
}

const STATE_TONE: Record<ShareState, string> = {
  active: "bg-success/15 text-success",
  expired: "bg-white/10 text-muted",
  revoked: "bg-danger/15 text-danger",
};

/** Le volume que les lecteurs ont mesuré, en octets pour `size` — `dataMB` est en Mo décimaux. */
const bytesOf = (mb: number) => mb * 1_000_000;

/**
 * Les chiffres des liens — partagés par la vue d'ensemble (`compact` : les deux qui disent « ça
 * sert en ce moment ») et la vue dédiée.
 */
export function SharesTiles({ data, compact = false }: { data: SharesOverview; compact?: boolean }) {
  const t = useT();
  const active = data.shares.filter((s) => s.state === "active").length;
  const playing = data.shares.reduce((n, s) => n + s.playingNow, 0);
  const watched = data.shares.reduce((n, s) => n + s.usage.watchedSeconds, 0);
  const dataMB = data.shares.reduce((n, s) => n + s.usage.dataMB, 0);
  return (
    <div className={`grid grid-cols-2 gap-3 ${compact ? "" : "md:grid-cols-4"}`}>
      <Tile icon={Link2} label={t("activity.shares.active")} value={active} hint={t("activity.shares.total", { n: data.shares.length })} />
      <Tile icon={PlayCircle} label={t("activity.shares.playing")} value={playing} tone={playing ? "good" : "default"} />
      {!compact && (
        <>
          <Tile icon={Clock} label={t("activity.shares.watched")} value={hours(watched)} />
          <Tile icon={HardDrive} label={t("activity.shares.data")} value={size(bytesOf(dataMB)) ?? "0"} hint={t("activity.shares.dataHint")} />
        </>
      )}
    </div>
  );
}

/** Pourquoi « Prolonger » n'est pas offert, ou `null` s'il l'est. Un lien expiré se rouvre (`extendShare`). */
function cannotExtend(s: ShareSummary, t: ReturnType<typeof useT>): string | null {
  if (s.state === "revoked") return t("activity.shares.cantExtendRevoked");
  if (s.accountDeleted) return t("activity.shares.cantExtendDeleted");
  return null;
}

/** Un lien : pour qui, son état, ses dates, qui l'a ouvert, ce qui joue, ce qu'il a consommé — et ses gestes. */
function ShareRow({
  s,
  now,
  onExtend,
  onRevoke,
  onDelete,
  onCopy,
}: {
  s: ShareSummary;
  now: number;
  onExtend: (days: number) => Promise<void>;
  onRevoke: () => Promise<void>;
  onDelete: () => Promise<void>;
  onCopy: () => void;
}) {
  const t = useT();
  const [extending, setExtending] = useState(false);
  const [busy, setBusy] = useState(false);
  const blocked = cannotExtend(s, t);
  const end =
    s.state === "revoked" ? t("activity.shares.revokedOn", { date: fullDate(s.revokedAt) })
    : s.state === "expired" ? t("activity.shares.expiredOn", { date: fullDate(s.expiresAt) })
    : t("activity.shares.until", { date: fullDate(s.expiresAt) });
  const last = s.usage.lastSeance;

  const extend = async (days: number) => {
    setBusy(true);
    try {
      await onExtend(days);
      setExtending(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3" data-testid="share-row">
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium text-white">{s.title}</span>
          <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${STATE_TONE[s.state]}`}>{t(`activity.shares.state.${s.state}`)}</span>
          {s.playingNow > 0 && (
            <span className="rounded bg-success/15 px-1.5 py-0.5 text-[11px] font-medium text-success">
              {t("activity.shares.playingNow", { n: s.playingNow, max: s.maxStreams })}
            </span>
          )}
        </p>
        <p className="mt-0.5 truncate text-xs text-subtle">
          {[t("activity.shares.guest", { label: s.label }), t(`activity.shares.kind.${s.kind}`), t("activity.shares.created", { date: fullDate(s.createdAt), who: s.createdBy }), end].join(" · ")}
        </p>
        {s.nowPlaying && <p className="mt-1 truncate text-xs text-success">{t("activity.shares.nowPlaying", { title: s.nowPlaying.title })}</p>}
        <p className="mt-1 text-xs text-muted">
          {s.redeemed > 0
            ? [
                t("activity.shares.redeemed", { n: s.redeemed }),
                s.lastUsedAt && t("activity.shares.lastVisit", { when: ago(s.lastUsedAt, now, t) }),
                s.lastDevice,
                s.lastIp,
              ]
                .filter(Boolean)
                .join(" · ")
            : t("activity.shares.never")}
        </p>
        {s.usage.seances > 0 && (
          <p className="mt-1 text-xs text-muted">
            {[
              t("activity.shares.seances", { n: s.usage.seances }),
              t("activity.shares.watchedFor", { d: hours(s.usage.watchedSeconds) }),
              size(bytesOf(s.usage.dataMB)),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        )}
        {last && (
          <p className="mt-1 truncate text-xs text-subtle">
            {last.positionSeconds != null
              ? t("activity.shares.lastSeanceAt", { title: last.title, at: clock(last.positionSeconds), when: ago(last.at, now, t) })
              : t("activity.shares.lastSeance", { title: last.title, when: ago(last.at, now, t) })}
          </p>
        )}
        {blocked && s.state !== "active" && <p className="mt-1 text-xs text-subtle">{blocked}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1">
        <button type="button" onClick={onCopy} className="btn-ghost px-2.5 py-1 text-xs">
          <Copy size={13} />
          {t("activity.shares.copyLink")}
        </button>
        {extending ? (
          <span className="inline-flex gap-1" role="group" aria-label={t("activity.shares.extend")}>
            {SHARE_EXTEND_CHOICES.map((n) => (
              <button key={n} type="button" disabled={busy} onClick={() => void extend(n)} className="btn-primary px-2.5 py-1 text-xs tabular-nums">
                {t("activity.shares.extendBy", { n })}
              </button>
            ))}
            <button type="button" onClick={() => setExtending(false)} className="btn-ghost px-2 py-1 text-xs">
              {t("common.cancel")}
            </button>
          </span>
        ) : (
          <button
            type="button"
            disabled={blocked !== null}
            title={blocked ?? undefined}
            onClick={() => setExtending(true)}
            className="btn-ghost px-2.5 py-1 text-xs disabled:opacity-40"
          >
            {t("activity.shares.extend")}
          </button>
        )}
        {s.state === "active" ? (
          <ConfirmButton label={t("activity.shares.revoke")} confirm={t("activity.shares.revokeConfirm")} onConfirm={onRevoke} />
        ) : (
          <ConfirmButton label={t("activity.shares.delete")} confirm={t("activity.shares.deleteConfirm")} danger onConfirm={onDelete} />
        )}
      </div>
    </li>
  );
}

/**
 * Les liens de partage vus de l'activité (DECISIONS.md §112) : pour qui, jusqu'à quand, ce qu'ils
 * ont ouvert et consommé (`sharesOverview`), et les gestes de l'administrateur — prolonger, révoquer
 * un lien vivant, supprimer un lien fini (son compte Jellyfin part avec lui). Le mot de passe n'y est
 * jamais : le serveur ne le garde que haché ; un lien dont le mot de passe est perdu se remplace.
 */
export function ActivityShares() {
  const t = useT();
  const { locale } = useLocale();
  const toast = useToast();
  const { data, isLoading, mutate } = useSWR<SharesOverview>(SHARE_ADMIN_KEY, fetcher, { refreshInterval: 20_000 });

  // Les vivants d'abord, puis du plus récent au plus ancien — l'ordre de la base n'en est pas un.
  const shares = useMemo(
    () => [...(data?.shares ?? [])].sort((a, b) => Number(b.state === "active") - Number(a.state === "active") || b.createdAt - a.createdAt),
    [data]
  );

  if (isLoading && !data) return <LoadingState />;
  if (!data) return <ErrorState message={t("activity.loadError")} onRetry={() => mutate()} />;

  const act = async (url: string, init: RequestInit, done: string) => {
    try {
      await apiAction(url, init);
      await mutate();
      toast.success(done);
    } catch (error) {
      toast.error(shareErrorText(error, t, locale));
    }
  };

  const copy = async (s: ShareSummary) => {
    if (await copyText(shareUrl(s.path))) toast.success(t("share.admin.copied"));
    else toast.error(t("share.admin.copyFailed"));
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">{t("activity.shares.intro")}</p>
        <button type="button" onClick={() => mutate()} className="btn-ghost px-3 py-1.5 text-xs">
          <RefreshCw size={14} />
          <span className="hidden sm:inline">{t("activity.refresh")}</span>
        </button>
      </div>

      <SharesTiles data={data} />

      <Panel title={t("activity.shares.links", { n: shares.length })} icon={Link2}>
        {shares.length ? (
          <ul className="divide-y divide-white/5">
            {shares.map((s) => (
              <ShareRow
                key={s.id}
                s={s}
                now={data.now}
                onCopy={() => void copy(s)}
                onExtend={(days) =>
                  act(`${SHARE_ADMIN_KEY}/${s.id}`, { method: "PATCH", body: JSON.stringify({ action: "extend", days }) }, t("activity.shares.extended", { n: days }))
                }
                onRevoke={() => act(`${SHARE_ADMIN_KEY}/${s.id}`, { method: "PATCH", body: JSON.stringify({ action: "revoke" }) }, t("activity.shares.revoked"))}
                onDelete={() => act(`${SHARE_ADMIN_KEY}/${s.id}`, { method: "DELETE" }, t("activity.shares.deleted"))}
              />
            ))}
          </ul>
        ) : (
          <p className="px-4 py-6 text-sm text-subtle">{t("activity.shares.none")}</p>
        )}
      </Panel>
    </div>
  );
}
