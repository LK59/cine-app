"use client";

import { useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { Check, ChevronDown, ChevronRight, Loader2, RotateCcw, ScanSearch, X } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { ErrorState } from "@/components/StateViews";
import type {
  SyncAction,
  SyncCounts,
  SyncFilter,
  SyncItemView,
  SyncSeasonView,
  SyncSeriesPayload,
  SyncSeriesView,
  SyncTrackView,
  SyncTreePayload,
  SyncVerdict,
} from "@/lib/subtitleSync/types";

/**
 * Configuration → Synchro des sous-titres (DECISIONS.md §141) : les films et les séries, ce que la mesure dit de
 * chaque piste de sous-titres texte (décalage, dérive, confiance, verdict) et ce que l'administrateur en a décidé.
 *
 * **Rien sans un clic ici** : « Scanner » commande la mesure (au service des acteurs à l'écran, en fond, à basse
 * priorité), « Recaler » applique une correction — à l'affichage, jamais sur le disque —, « Refuser » l'écarte,
 * « Rétablir » revient à la mesure. Une saison, une série ou un film entier ne recale que les mesures fiables d'un
 * décalage ou d'une dérive ; une piste seule, toute mesure qui a un décalage. Relue toutes les cinq secondes tant
 * qu'une mesure demandée n'est pas revenue, sinon au calme.
 */

type T = ReturnType<typeof useT>;
const TREE = (filter: SyncFilter) => `/api/admin/subsync?filter=${filter}`;
const SERIES = (filter: SyncFilter, id: string) => `/api/admin/subsync?filter=${filter}&series=${id}`;
const FILTERS: SyncFilter[] = ["affected", "measured", "all"];

/** Les verdicts du service, en clés de traduction (ASCII). */
export const VERDICT_KEY: Record<SyncVerdict, string> = {
  ok: "ok",
  "décalé": "shifted",
  "dérive": "drift",
  incertain: "uncertain",
  montage: "edit",
  image: "image",
  "peu-de-répliques": "fewCues",
  erreur: "error",
};

const VERDICT_TONE: Partial<Record<SyncVerdict, string>> = {
  "décalé": "bg-warning/20 text-warning",
  "dérive": "bg-warning/20 text-warning",
  montage: "bg-danger/20 text-danger",
  ok: "bg-white/10 text-muted",
};

/** « +2,44 s » — le décalage d'une mesure, signé, au centième. */
export function fmtOffset(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const v = Math.round(seconds * 100) / 100;
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} s`;
}

/** La dérive : le rapport de cadences qu'elle est (« 25→23.976 »), ou l'échelle en ppm faute de nom ; rien pour 1. */
export function fmtDrift(scale: number | null, label: string | null): string | null {
  if (scale === null || scale === 1) return null;
  if (label && label !== "1") return label;
  return `${Math.round((scale - 1) * 1e6)} ppm`;
}

function trackName(track: SyncTrackView, t: T): string {
  const lang = track.language ? track.language.toUpperCase() : "?";
  const marks = [track.forced ? t("subSync.track.forced") : null, track.hi ? t("subSync.track.hi") : null, track.kind === "external" ? t("subSync.track.external") : null]
    .filter(Boolean)
    .join(" · ");
  return `${lang}${track.title ? ` — ${track.title}` : ""}${marks ? ` (${marks})` : ""}`;
}

function CountsLine({ c, t }: { c: SyncCounts; t: T }) {
  return (
    <span className="text-xs text-muted">
      {t("subSync.counts", { measured: c.measured, affected: c.affected, applied: c.applied })}
      {c.pending > 0 && <> · {t("subSync.pendingShort", { n: c.pending })}</>}
    </span>
  );
}

interface Gestures {
  scan: (body: Record<string, unknown>) => void;
  decide: (body: Record<string, unknown>, action: SyncAction) => void;
  busy: string | null;
}

function Actions({ id, scanBody, decideBody, g, t, canApply = true }: { id: string; scanBody?: Record<string, unknown>; decideBody: Record<string, unknown>; g: Gestures; t: T; canApply?: boolean }) {
  const disabled = g.busy !== null;
  const btn = "flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-xs hover:bg-white/20 disabled:opacity-50";
  return (
    <span className="flex shrink-0 flex-wrap gap-1.5">
      {g.busy === id && <Loader2 className="h-4 w-4 animate-spin text-subtle" aria-hidden />}
      {scanBody && (
        <button type="button" className={btn} disabled={disabled} onClick={() => g.scan(scanBody)} data-testid="subsync-scan">
          <ScanSearch className="h-3 w-3" aria-hidden />
          {t("subSync.scan")}
        </button>
      )}
      {canApply && (
        <button type="button" className={btn} disabled={disabled} onClick={() => g.decide(decideBody, "apply")} data-testid="subsync-apply">
          <Check className="h-3 w-3" aria-hidden />
          {t("subSync.apply")}
        </button>
      )}
      <button type="button" className={btn} disabled={disabled} onClick={() => g.decide(decideBody, "reject")} data-testid="subsync-reject">
        <X className="h-3 w-3" aria-hidden />
        {t("subSync.reject")}
      </button>
    </span>
  );
}

function TrackLine({ itemId, track, g, t }: { itemId: string; track: SyncTrackView; g: Gestures; t: T }) {
  const drift = fmtDrift(track.scale, track.scaleLabel);
  const body = { scope: "track", itemId, trackKey: track.trackKey };
  const measurable = track.offset !== null && track.verdict !== "image";
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-xs" data-testid="subsync-track">
      <div className="min-w-0 space-y-0.5">
        <p className="truncate font-medium text-white">{trackName(track, t)}</p>
        <p className="text-muted">
          <span className={`mr-1.5 rounded px-1.5 py-0.5 ${VERDICT_TONE[track.verdict] ?? "bg-white/5 text-muted"}`}>{t(`subSync.verdict.${VERDICT_KEY[track.verdict] ?? "error"}`)}</span>
          {measurable && <>{t("subSync.offset", { v: fmtOffset(track.offset) })}</>}
          {drift && <> · {t("subSync.drift", { v: drift })}</>}
          {track.confidence && measurable && <> · {t(`subSync.confidence.${track.confidence}`)}</>}
          {" · "}
          {t(`subSync.status.${track.status}`)}
          {track.stale && <span className="ml-1.5 text-warning">{t("subSync.stale")}</span>}
        </p>
      </div>
      {track.verdict !== "image" && (
        <span className="flex shrink-0 gap-1.5">
          {measurable && track.status !== "applied" && !track.stale && (
            <button type="button" className="rounded-full bg-white/10 px-2.5 py-1 hover:bg-white/20 disabled:opacity-50" disabled={g.busy !== null} onClick={() => g.decide(body, "apply")}>
              {t("subSync.apply")}
            </button>
          )}
          {track.status !== "rejected" && (
            <button type="button" className="rounded-full bg-white/10 px-2.5 py-1 hover:bg-white/20 disabled:opacity-50" disabled={g.busy !== null} onClick={() => g.decide(body, "reject")}>
              {t("subSync.reject")}
            </button>
          )}
          {track.status !== "measured" && (
            <button type="button" className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 hover:bg-white/20 disabled:opacity-50" disabled={g.busy !== null} onClick={() => g.decide(body, "reset")}>
              <RotateCcw className="h-3 w-3" aria-hidden />
              {t("subSync.reset")}
            </button>
          )}
        </span>
      )}
    </li>
  );
}

function ItemRow({ item, g, t }: { item: SyncItemView; g: Gestures; t: T }) {
  return (
    <li className="py-2" data-testid="subsync-item">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{item.title}</p>
          {item.job?.state === "queued" && <p className="text-xs text-muted">{t("subSync.job.queued")}</p>}
          {item.job?.state === "failed" && <p className="text-xs text-warning">{t("subSync.job.failed", { error: item.job.error ?? "?" })}</p>}
        </div>
        <Actions id={item.itemId} scanBody={{ scope: "item", itemId: item.itemId }} decideBody={{ scope: "item", itemId: item.itemId }} g={g} t={t} canApply={item.tracks.length > 0} />
      </div>
      {item.tracks.length > 0 && (
        <ul className="mt-1 divide-y divide-white/5 border-l border-white/10 pl-3">
          {item.tracks.map((track) => (
            <TrackLine key={track.trackKey} itemId={item.itemId} track={track} g={g} t={t} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SeasonBlock({ seriesId, season, g, t }: { seriesId: string; season: SyncSeasonView; g: Gestures; t: T }) {
  const [open, setOpen] = useState(false);
  const scope = season.season === null ? null : { scope: "season", seriesId, season: season.season };
  return (
    <li className="py-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="flex min-w-0 items-center gap-1 text-left text-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
          <span className="font-medium">{season.season === null ? t("subSync.specials") : t("subSync.season", { n: season.season })}</span>
          <span className="ml-2">
            <CountsLine c={season.counts} t={t} />
          </span>
        </button>
        {scope && <Actions id={`${seriesId}:${season.season}`} scanBody={scope} decideBody={scope} g={g} t={t} />}
      </div>
      {open && (
        <ul className="ml-5 divide-y divide-white/5">
          {(season.episodes ?? []).map((item) => (
            <ItemRow key={item.itemId} item={item} g={g} t={t} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SeriesBlock({ series, filter, g, t }: { series: SyncSeriesView; filter: SyncFilter; g: Gestures; t: T }) {
  const [open, setOpen] = useState(false);
  const { data } = useSWR<SyncSeriesPayload>(open ? SERIES(filter, series.seriesId) : null, fetcher);
  const scope = { scope: "series", seriesId: series.seriesId };
  return (
    <li className="py-2" data-testid="subsync-series">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="flex min-w-0 items-center gap-1 text-left" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? <ChevronDown className="h-4 w-4 shrink-0" aria-hidden /> : <ChevronRight className="h-4 w-4 shrink-0" aria-hidden />}
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{series.title}</span>
            <CountsLine c={series.counts} t={t} />
          </span>
        </button>
        <Actions id={series.seriesId} scanBody={scope} decideBody={scope} g={g} t={t} />
      </div>
      {open &&
        (data ? (
          data.seasons.length ? (
            <ul className="ml-5 divide-y divide-white/5">
              {data.seasons.map((season) => (
                <SeasonBlock key={String(season.season)} seriesId={series.seriesId} season={season} g={g} t={t} />
              ))}
            </ul>
          ) : (
            <p className="ml-5 text-xs text-muted">{t("subSync.none")}</p>
          )
        ) : (
          <Loader2 className="ml-5 h-4 w-4 animate-spin text-subtle" />
        ))}
    </li>
  );
}

export function SubtitleSyncCard() {
  const t = useT();
  const toast = useToast();
  const { mutate: mutateAny } = useSWRConfig();
  const [filter, setFilter] = useState<SyncFilter>("affected");
  const { data, error, mutate } = useSWR<SyncTreePayload>(TREE(filter), fetcher, {
    refreshInterval: (latest) => (latest && latest.pending > 0 ? 5000 : 0),
  });
  const [busy, setBusy] = useState<string | null>(null);

  if (!data && error) return <ErrorState message={t("common.error")} onRetry={() => void mutate()} />;
  if (!data) return <Loader2 className="animate-spin text-subtle" />;
  if (!data.configured) return <p className="text-sm text-muted" data-testid="subsync-off">{t("subSync.off")}</p>;

  const refresh = async () => {
    await mutate();
    // Les épisodes ouverts d'une série se relisent aussi.
    await mutateAny((key) => typeof key === "string" && key.startsWith("/api/admin/subsync?"));
  };

  const post = async (url: string, body: Record<string, unknown>, id: string) => {
    setBusy(id);
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    setBusy(null);
    const answer = res?.ok ? ((await res.json().catch(() => null)) as { queued?: number; failed?: number; changed?: number } | null) : null;
    await refresh();
    return answer;
  };

  const g: Gestures = {
    busy,
    scan: (body) => {
      void post("/api/admin/subsync/scan", body, String(body.itemId ?? body.seriesId ?? "movies")).then((a) => {
        if (a && typeof a.queued === "number") toast.success(t("subSync.scanned", { n: a.queued }));
        else toast.error(t("subSync.actionFailed"));
      });
    },
    decide: (body, action) => {
      void post("/api/admin/subsync/decide", { ...body, action }, String(body.trackKey ?? body.itemId ?? body.seriesId ?? "movies")).then((a) => {
        if (a && typeof a.changed === "number") toast.success(t("subSync.changed", { n: a.changed }));
        else toast.error(t("subSync.actionFailed"));
      });
    },
  };

  const movieIds = data.movies.map((m) => m.itemId).slice(0, 500);
  const empty = data.movies.length === 0 && data.series.length === 0;

  return (
    <section className="space-y-4" data-testid="subsync-card">
      <div className="rounded-2xl bg-white/[0.04] p-4">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("subSync.filterLabel")}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              className={`rounded-full px-3 py-1 text-xs ${filter === f ? "bg-white font-semibold text-black" : "bg-white/10"}`}
              onClick={() => setFilter(f)}
            >
              {t(`subSync.filter.${f}`)}
            </button>
          ))}
        </div>
        <p className="mt-3 text-sm">
          <CountsLine c={data.totals} t={t} />
        </p>
        {data.pending > 0 && (
          <p className="mt-1 flex items-center gap-2 text-sm text-muted" data-testid="subsync-pending">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t("subSync.pending", { n: data.pending })}
          </p>
        )}
        {data.unavailable && <p className="mt-2 text-sm text-warning">{t("subSync.unavailable")}</p>}
        <p className="mt-2 text-xs text-muted">{t("subSync.imageNote")}</p>
      </div>

      {empty && <p className="text-sm text-muted">{t("subSync.none")}</p>}

      {data.movies.length > 0 && (
        <div className="rounded-2xl bg-white/[0.04] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-base font-semibold">{t("subSync.movies", { n: data.movies.length })}</h2>
            <Actions id="movies" scanBody={{ scope: "movies", itemIds: movieIds }} decideBody={{ scope: "movies", itemIds: movieIds }} g={g} t={t} />
          </div>
          <ul className="mt-2 divide-y divide-white/10">
            {data.movies.map((item) => (
              <ItemRow key={item.itemId} item={item} g={g} t={t} />
            ))}
          </ul>
        </div>
      )}

      {data.series.length > 0 && (
        <div className="rounded-2xl bg-white/[0.04] p-4">
          <h2 className="text-base font-semibold">{t("subSync.series", { n: data.series.length })}</h2>
          <ul className="mt-2 divide-y divide-white/10">
            {data.series.map((series) => (
              <SeriesBlock key={series.seriesId} series={series} filter={filter} g={g} t={t} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
