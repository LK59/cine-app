"use client";

import { useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { Modal } from "@/components/Modal";
import { LoadingState, ErrorState } from "@/components/StateViews";
import { useToast } from "@/components/Toast";
import { useT } from "@/components/TranslationProvider";

interface SeasonInfo {
  seasonNumber: number;
  name: string;
  episodeCount: number;
  status: number | null;
}

// Jellyseerr's MediaStatus enum: 1=unknown/missing, 2=pending, 3=processing,
// 4=partially available, 5=available — anything >=2 means "already requested or already there",
// nothing left to ask for on that season specifically.
const COVERED_STATUSES = new Set([2, 3, 4, 5]);

// Single entry point for creating a Jellyseerr request, for both movies and series — was two
// separate ad-hoc implementations before (RequestButton, PosterCard's own doRequest), unified
// here so the season-picker fix (see below) only has to exist once.
//
// Movies: a plain confirm — Jellyseerr has no per-season concept for them.
// Series: THIS is the actual fix for the "Cannot read properties of undefined (reading
// 'filter')" 500 reported live — creating a tv request with no `seasons` field crashes
// Jellyseerr's own request handler. Fetches the series' real per-season status from Jellyseerr
// first (not guessed) so already-requested/available seasons are shown as such and excluded from
// the default selection, and a second, later request for the REMAINING seasons of an already
// partially-requested series ("Demander plus") is a normal, expected flow — not blocked as a
// duplicate, since only the still-missing seasons are ever sent.
export function RequestFlowModal({
  mediaType,
  tmdbId,
  title,
  onClose,
  onSuccess,
}: {
  mediaType: "movie" | "series";
  tmdbId: number;
  title: string;
  onClose: () => void;
  onSuccess?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);

  const { data, error, isLoading } = useSWR<{ status: number; seasons?: SeasonInfo[] }>(
    mediaType === "series" ? `/api/jellyseerr/media?tmdbId=${tmdbId}&type=series` : null,
    fetcher,
    { revalidateOnFocus: false }
  );

  const seasons = data?.seasons ?? [];
  const missing = seasons.filter((s) => s.status === null || !COVERED_STATUSES.has(s.status));
  const hasCovered = seasons.some((s) => s.status !== null && COVERED_STATUSES.has(s.status));

  // Default selection (every missing season, pre-checked) applied once when the data for THIS
  // series arrives — during render, not an effect, per React's guidance for deriving state from
  // a prop/fetch change; re-applied if tmdbId itself changes under an already-mounted modal.
  const [selected, setSelected] = useState<Set<number> | null>(null);
  const [initializedFor, setInitializedFor] = useState<number | null>(null);
  if (data && initializedFor !== tmdbId) {
    setInitializedFor(tmdbId);
    setSelected(new Set(missing.map((s) => s.seasonNumber)));
  }

  async function submit(seasonNumbers?: number[]) {
    setSubmitting(true);
    try {
      const res = await fetch("/api/jellyseerr/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaType: mediaType === "movie" ? "movie" : "tv",
          mediaId: tmdbId,
          ...(seasonNumbers ? { seasons: seasonNumbers } : {}),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error || t("common.unknown"));
        return;
      }
      toast.success(t("modals.request.sentToast"));
      // Cache carries availability/request status shown elsewhere (discover, watchlist) — a
      // request made here should be reflected there without waiting out the cache's own TTL.
      fetch("/api/cache/invalidate", { method: "POST" }).catch(() => {});
      onSuccess?.();
      onClose();
    } catch {
      toast.error(t("common.unknown"));
    } finally {
      setSubmitting(false);
    }
  }

  function toggleSeason(seasonNumber: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(seasonNumber)) next.delete(seasonNumber);
      else next.add(seasonNumber);
      return next;
    });
  }

  if (mediaType === "movie") {
    return (
      <Modal title={t("modals.request.confirmTitle")} onClose={onClose}>
        <p className="mb-1 truncate text-sm text-white">{title}</p>
        <p className="mb-4 text-xs text-slate-500">{t("modals.request.confirmBody")}</p>
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 rounded-xl border border-white/10 py-2 text-sm text-slate-400 transition-colors hover:text-white"
          >
            {t("common.cancel")}
          </button>
          <button onClick={() => submit()} disabled={submitting} className="btn-primary flex-1 justify-center">
            {submitting ? "…" : t("common.request")}
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={title} onClose={onClose}>
      {isLoading && <LoadingState label={t("modals.request.loadingSeasons")} />}
      {error && <ErrorState message={t("modals.request.loadError")} />}
      {data && seasons.length === 0 && <p className="text-sm text-slate-500">{t("modals.request.noSeasons")}</p>}
      {data && seasons.length > 0 && missing.length === 0 && (
        <p className="text-sm text-slate-500">{t("modals.request.allCovered")}</p>
      )}
      {missing.length > 0 && selected && (
        <>
          <p className="mb-3 text-xs text-slate-500">{t("modals.request.pickSeasons")}</p>
          <div className="scrollbar-thin max-h-[50vh] space-y-1.5 overflow-y-auto">
            {seasons.map((s) => {
              const covered = s.status !== null && COVERED_STATUSES.has(s.status);
              const checked = selected.has(s.seasonNumber);
              return covered ? (
                <div
                  key={s.seasonNumber}
                  className="flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/5 px-3 py-2 text-sm text-slate-500"
                >
                  <span>
                    {s.name} <span className="text-xs text-slate-600">({s.episodeCount} ép.)</span>
                  </span>
                  <span className="text-xs">
                    {s.status === 5 ? t("common.available") : t("modals.request.alreadyRequested")}
                  </span>
                </div>
              ) : (
                <label
                  key={s.seasonNumber}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white hover:bg-white/10"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleSeason(s.seasonNumber)}
                    className="accent-accent-500"
                  />
                  {s.name} <span className="text-xs text-slate-500">({s.episodeCount} ép.)</span>
                </label>
              );
            })}
          </div>
          <div className="mt-4 flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 rounded-xl border border-white/10 py-2 text-sm text-slate-400 transition-colors hover:text-white"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={() => submit([...selected])}
              disabled={submitting || selected.size === 0}
              className="btn-primary flex-1 justify-center disabled:opacity-40"
            >
              {submitting ? "…" : hasCovered ? t("modals.request.requestMore") : t("common.request")}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
