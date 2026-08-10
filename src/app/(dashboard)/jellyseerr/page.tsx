"use client";

import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import Link from "next/link";
import { fetcher } from "@/lib/swr";
import { PageHeader } from "@/components/PageHeader";
import { LoadingState, ErrorState, EmptyState } from "@/components/StateViews";
import { Check, X, ListChecks, User } from "lucide-react";
import Image from "next/image";
import type { JellyseerrRequest } from "@/lib/clients/jellyseerr";
import { INTERVALS } from "@/lib/refresh-intervals";
import type { EnrichedRequest } from "@/lib/jellyseerr-enrich";
import { useRole } from "@/lib/useRole";
import { useToast } from "@/components/Toast";
import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { relDate } from "@/lib/format";
import { useT } from "@/components/TranslationProvider";

function RequestRow({ r, showActions, onApprove, onDecline }: {
  r: EnrichedRequest;
  showActions: boolean;
  onApprove?: () => void;
  onDecline?: () => void;
}) {
  const t = useT();

  const STATUS_LABELS: Record<number, { label: string; className: string }> = {
    1: { label: t('jellyseerr.statusLabels.1'), className: "bg-amber-500/15 text-amber-400" },
    2: { label: t('jellyseerr.statusLabels.2'), className: "bg-emerald-500/15 text-emerald-400" },
    3: { label: t('jellyseerr.statusLabels.3'), className: "bg-red-500/15 text-red-400" },
    4: { label: t('jellyseerr.statusLabels.4'), className: "bg-blue-500/15 text-blue-400" },
    5: { label: t('jellyseerr.statusLabels.5'), className: "bg-accent-500/15 text-accent-400" },
  };

  const statusInfo = STATUS_LABELS[r.status];

  const inner = (
    <div className="flex items-center gap-3 p-3">
      {r.media.posterPath ? (
        <Image
          src={`${TMDB_IMAGE_BASE}/w92${r.media.posterPath}`}
          alt={r.media.title ?? ""}
          width={40}
          height={56}
          className="shrink-0 rounded-sm object-cover"
        />
      ) : (
        <div className="h-14 w-10 shrink-0 rounded-sm bg-slate-800" />
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white">
          {r.media.title || t('jellyseerr.untitled')}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="text-[11px] uppercase text-slate-500">
            {r.media.mediaType === "movie" ? t('jellyseerr.mediaTypeMovie') : t('jellyseerr.mediaTypeSeries')}
          </span>
          {statusInfo && (
            <span className={`badge text-[11px] ${statusInfo.className}`}>{statusInfo.label}</span>
          )}
          <span className="text-[11px] text-slate-600">{relDate(r.createdAt, t)}</span>
        </div>
        {!showActions && r.requestedBy.displayName && (
          <p className="mt-0.5 text-[11px] text-slate-500">
            {t('jellyseerr.requestedBy', { name: r.requestedBy.displayName })}
          </p>
        )}
      </div>
      {showActions && (
        <div className="flex shrink-0 items-center gap-1">
          <button onClick={onApprove} className="btn-ghost px-2 text-emerald-400" title={t('jellyseerr.approve')}>
            <Check size={14} />
          </button>
          <button onClick={onDecline} className="btn-danger px-2" title={t('jellyseerr.deny')}>
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );

  return r.cinemaHref ? (
    <Link href={r.cinemaHref} className="block hover:bg-white/5 transition-colors">
      {inner}
    </Link>
  ) : (
    <div>{inner}</div>
  );
}

export default function JellyseerrPage() {
  const { mutate } = useSWRConfig();
  const { isGuest, jfUser } = useRole();
  const toast = useToast();
  const t = useT();
  const [tab, setTab] = useState<"all" | "mine">(jfUser ? "mine" : "all");

  const allKey = isGuest
    ? "/api/jellyseerr/requests?filter=all"
    : "/api/jellyseerr/requests?filter=pending";

  const { data: allData, error: allError, isLoading: allLoading } = useSWR<{ results: EnrichedRequest[] }>(
    tab === "all" ? allKey : null,
    fetcher,
    { refreshInterval: INTERVALS.FAST }
  );

  const { data: myData, isLoading: myLoading } = useSWR<{ results: EnrichedRequest[] }>(
    tab === "mine" ? "/api/jellyseerr/my-requests" : null,
    fetcher,
    { refreshInterval: INTERVALS.MEDIUM }
  );

  async function respond(id: number, action: "approve" | "decline") {
    try {
      const res = await fetch(`/api/jellyseerr/requests/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error();
      mutate(allKey);
      toast.success(action === "approve" ? t('jellyseerr.approveSuccess') : t('jellyseerr.denySuccess'));
    } catch {
      toast.error(t('jellyseerr.actionError'));
    }
  }

  const allRequests = allData?.results ?? [];
  const myRequests = myData?.results ?? [];

  return (
    <div>
      <PageHeader title={t('jellyseerr.pageTitle')} />

      {/* Tabs */}
      <div className="mb-6 flex gap-2 border-b border-white/10 pb-0">
        {jfUser && (
          <button
            onClick={() => setTab("mine")}
            className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
              tab === "mine"
                ? "border-b-2 border-accent-500 text-accent-400"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <User size={14} />
            {t('jellyseerr.tabMine')}
            {myRequests.length > 0 && (
              <span className="ml-1 rounded-full bg-accent-600/30 px-1.5 py-0.5 text-[10px] text-accent-400">
                {myRequests.length}
              </span>
            )}
          </button>
        )}
        <button
          onClick={() => setTab("all")}
          className={`flex items-center gap-2 rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
            tab === "all"
              ? "border-b-2 border-accent-500 text-accent-400"
              : "text-slate-400 hover:text-slate-200"
          }`}
        >
          <ListChecks size={14} />
          {isGuest ? t('jellyseerr.tabAll') : t('jellyseerr.tabPending')}
          {tab === "all" && allRequests.length > 0 && (
            <span className="ml-1 rounded-full bg-accent-600/30 px-1.5 py-0.5 text-[10px] text-accent-400">
              {allRequests.length}
            </span>
          )}
        </button>
      </div>

      {/* Mes demandes tab */}
      {tab === "mine" && (
        <>
          {myLoading && <LoadingState />}
          {!myLoading && myRequests.length === 0 && (
            <EmptyState label={t('jellyseerr.emptyMine')} />
          )}
          {myRequests.length > 0 && (
            <div className="card divide-y divide-white/5">
              {myRequests.map((r) => (
                <RequestRow key={r.id} r={r} showActions={false} />
              ))}
            </div>
          )}
        </>
      )}

      {/* All / pending tab */}
      {tab === "all" && (
        <>
          {allLoading && <LoadingState />}
          {allError && <ErrorState message={t('jellyseerr.serviceDown')} />}
          {allData && allRequests.length === 0 && (
            <EmptyState label={isGuest ? t('jellyseerr.emptyAll') : t('jellyseerr.emptyPending')} />
          )}
          {allRequests.length > 0 && (
            <div className="card divide-y divide-white/5">
              {allRequests.map((r) => (
                <RequestRow
                  key={r.id}
                  r={r}
                  showActions={!isGuest}
                  onApprove={() => respond(r.id, "approve")}
                  onDecline={() => respond(r.id, "decline")}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
