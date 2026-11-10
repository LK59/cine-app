import { randomUUID } from "node:crypto";
import { jellyfin, type JellyfinMediaSource, type JellyfinMediaStream } from "@/lib/clients/jellyfin";
import { xray, xrayConfigured, type XraySubsyncItem } from "@/lib/clients/xray";
import { cachedJellyfinMoviesAdmin, cachedJellyfinSeriesAdmin } from "@/lib/server-cache";
import { generatedForDirect } from "@/lib/subtitleGen/direct";
import { TEXT_SUBTITLE_FORMATS } from "@/lib/subtitleGen/source";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { logError } from "@/lib/logger";
import { taskLog } from "@/lib/taskLog";
import {
  allJobs,
  allRows,
  decide,
  failJob,
  finishJob,
  jobsForItems,
  passSummary,
  pendingJobs,
  recordJob,
  recordMeasurement,
  rowsForItems,
  rowsForSeries,
  type ItemMeta,
  type JobRow,
  type SyncRow,
} from "./store";
import {
  AFFECTED_VERDICTS,
  type SyncAction,
  type SyncCounts,
  type SyncDecideScope,
  type SyncFilter,
  type SyncItemView,
  type SyncScanScope,
  type SyncSeasonView,
  type SyncSeriesPayload,
  type SyncSeriesView,
  type SyncTrackView,
  type SyncTreePayload,
} from "./types";

/**
 * La page Configuration → Synchro des sous-titres, côté serveur (DECISIONS.md §141).
 *
 * **Rien sans un clic.** Une mesure part au service seulement par `launchScan` (le bouton « Scanner ») ; les
 * résultats ne sont relus que **tant qu'une mesure demandée n'est pas revenue** (`pullPending`, toutes les 20 s
 * par un minuteur qui s'arrête de lui-même, et à chaque lecture de la page) ; une correction ne s'applique que par
 * `decideScope` (« Recaler »). Le planificateur des acteurs à l'écran n'en sait rien.
 */

const BATCH = 40;
const ETAG_TTL_MS = 5 * 60_000;
const PULL_EVERY_MS = 20_000;
const PULL_MIN_GAP_MS = 4_000;

/** L'état du module sur `globalThis` : les routes et leurs copies du module partagent le minuteur (CLAUDE.md, server-cache). */
interface State {
  timer: ReturnType<typeof setInterval> | null;
  lastPull: number;
  pulling: Promise<void> | null;
  etags: Map<string, { etag: string | null; at: number }>;
}
const KEY = Symbol.for("cine-app.subtitleSync");
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { timer: null, lastPull: 0, pulling: null, etags: new Map() });
}

type StreamsItem = Awaited<ReturnType<typeof jellyfin.getItemsWithStreams>>[number];

function metaOf(item: StreamsItem): ItemMeta {
  const episode = item.Type === "Episode";
  const code = episode && item.ParentIndexNumber != null && item.IndexNumber != null
    ? ` S${String(item.ParentIndexNumber).padStart(2, "0")}E${String(item.IndexNumber).padStart(2, "0")}`
    : "";
  return {
    itemKind: episode ? "Episode" : "Movie",
    itemTitle: episode ? `${item.SeriesName ?? ""}${code}${item.Name ? ` · ${item.Name}` : ""}`.trim() : item.ProductionYear ? `${item.Name} (${item.ProductionYear})` : (item.Name ?? item.Id),
    seriesId: episode ? (item.SeriesId?.toLowerCase() ?? null) : null,
    seriesTitle: episode ? (item.SeriesName ?? null) : null,
    season: episode ? (item.ParentIndexNumber ?? null) : null,
    episode: episode ? (item.IndexNumber ?? null) : null,
  };
}

/** Les fichiers texte à côté du film, sans ceux que l'application a fait générer (§69 : datés sur ce son-ci déjà). */
export function externalsToMeasure(itemId: string, source: JellyfinMediaSource): { path: string; language: string | null; title: string | null; forced: boolean; hi: boolean }[] {
  const streams: JellyfinMediaStream[] = source.MediaStreams ?? [];
  const ours = generatedForDirect(itemId, source, streams).ours;
  return streams
    .filter((s) => s.Type === "Subtitle" && s.IsExternal && !!s.Path && TEXT_SUBTITLE_FORMATS.has((s.Codec ?? "").toLowerCase()) && !ours.has(s.Index))
    .map((s) => ({ path: s.Path!, language: s.Language ?? null, title: s.Title ?? null, forced: s.IsForced === true, hi: s.IsHearingImpaired === true }));
}

async function readItems(itemIds: readonly string[]): Promise<StreamsItem[]> {
  const out: StreamsItem[] = [];
  for (let i = 0; i < itemIds.length; i += BATCH) out.push(...(await jellyfin.getItemsWithStreams(itemIds.slice(i, i + BATCH))));
  const now = Date.now();
  for (const item of out) state().etags.set(item.Id.toLowerCase(), { etag: item.MediaSources?.[0]?.ETag ?? null, at: now });
  return out;
}

/** La version actuelle de ces fichiers (`ETag`), gardée cinq minutes ; `fresh` relit tout. */
async function currentEtags(itemIds: readonly string[], fresh = false): Promise<Map<string, string | null>> {
  const st = state();
  const now = Date.now();
  const missing = itemIds.filter((id) => {
    const known = st.etags.get(id);
    return fresh || !known || now - known.at > ETAG_TTL_MS;
  });
  if (missing.length) {
    try {
      await readItems(missing);
    } catch (error) {
      logError("subtitle-sync/etags", error, { items: missing.length });
    }
  }
  if (st.etags.size > 20_000) st.etags.clear();
  return new Map(itemIds.map((id) => [id, st.etags.get(id)?.etag ?? null]));
}

/** Les éléments d'une portée : un élément, une saison, une série (dans l'ordre des épisodes), une liste de films. */
async function resolveScope(scope: SyncScanScope): Promise<string[]> {
  if (scope.scope === "item") return [scope.itemId.toLowerCase()];
  if (scope.scope === "movies") return scope.itemIds.map((id) => id.toLowerCase());
  const episodes = (await jellyfin.getEpisodesAdmin(scope.seriesId)).filter(
    (e) => isJellyfinId(e.Id) && (e as { LocationType?: string }).LocationType !== "Virtual" && (scope.scope === "series" || e.ParentIndexNumber === scope.season),
  );
  episodes.sort((a, b) => (a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0) || (a.IndexNumber ?? 0) - (b.IndexNumber ?? 0));
  return episodes.map((e) => e.Id.toLowerCase());
}

const SCOPE_LIMIT = 1000;

/**
 * « Scanner » : commande au service la mesure de chaque élément de la portée, et la note. Rend combien sont
 * partis, combien ont été refusés (fichier inconnu de Jellyfin, service qui refuse) — le détail va à `server.log`.
 */
export async function launchScan(scope: SyncScanScope, by: string): Promise<{ queued: number; failed: number; passId: string }> {
  const ids = (await resolveScope(scope)).slice(0, SCOPE_LIMIT);
  const passId = randomUUID();
  let queued = 0;
  let failed = 0;
  const items = await readItems(ids);
  const byId = new Map(items.map((i) => [i.Id.toLowerCase(), i]));
  for (const id of ids) {
    const item = byId.get(id);
    const source = item?.MediaSources?.[0];
    if (!item || !source?.Path || !source.ETag) {
      failed++;
      continue;
    }
    const meta = metaOf(item);
    try {
      await xray.subsyncEnqueue({ itemId: id, path: source.Path, etag: source.ETag, priority: "low", externals: externalsToMeasure(id, source) });
      recordJob(id, source.ETag, passId, by, meta);
      queued++;
    } catch (error) {
      failed++;
      logError("subtitle-sync/scan", error, { itemId: id });
    }
  }
  taskLog("synchro des sous-titres", `mesure demandée · ${queued} élément${queued > 1 ? "s" : ""}`, {
    portée: scope.scope,
    refusés: failed || undefined,
    par: by,
  });
  if (queued > 0) ensurePuller();
  return { queued, failed, passId };
}

/** Relit au service les mesures demandées et pas encore revenues. Sans attente, rien n'est demandé. */
export async function pullPending(force = false): Promise<void> {
  const st = state();
  if (st.pulling) return st.pulling;
  if (!force && Date.now() - st.lastPull < PULL_MIN_GAP_MS) return;
  st.pulling = (async () => {
    st.lastPull = Date.now();
    const jobs = pendingJobs();
    if (jobs.length === 0 || !xrayConfigured()) return;
    const passes = new Set<string>();
    for (let i = 0; i < jobs.length; i += 200) {
      const chunk = jobs.slice(i, i + 200);
      let answers: XraySubsyncItem[];
      try {
        answers = await xray.subsyncResults(chunk.map((j) => j.item_id));
      } catch (error) {
        logError("subtitle-sync/pull", error, { items: chunk.length });
        return;
      }
      const byId = new Map(answers.map((a) => [a.itemId.toLowerCase(), a]));
      for (const job of chunk) {
        const a = byId.get(job.item_id);
        if (!a) continue;
        try {
          if (a.status === "done" && a.resultEtag === job.media_etag) {
            recordMeasurement(job.item_id, job.media_etag, jobMeta(job), a.speechSource ?? null, a.version ?? null, a.tracks ?? []);
            finishJob(job.item_id);
            passes.add(job.pass_id);
          } else if (a.status === "failed" || a.status === "unknown" || (a.status === "done" && a.resultEtag !== job.media_etag)) {
            // Le service a échoué, ne connaît pas l'ordre (base effacée), ou a mesuré un autre fichier : la page le dit.
            failJob(job.item_id, a.error ?? (a.status === "unknown" ? "inconnu du service" : "autre version du fichier"));
            passes.add(job.pass_id);
          }
        } catch (error) {
          logError("subtitle-sync/record", error, { itemId: job.item_id });
        }
      }
    }
    for (const passId of passes) {
      const summary = passSummary(passId);
      if (!summary) continue;
      const v = summary.byVerdict;
      taskLog("synchro des sous-titres", `passe terminée · ${summary.items} élément${summary.items > 1 ? "s" : ""}, ${summary.tracks} pistes`, {
        décalés: v["décalé"] || undefined,
        dérives: v["dérive"] || undefined,
        montages: v["montage"] || undefined,
        incertains: v["incertain"] || undefined,
        ok: v.ok || undefined,
        échecs: summary.failed || undefined,
      });
    }
  })().finally(() => {
    st.pulling = null;
  });
  return st.pulling;
}

function jobMeta(job: JobRow): ItemMeta {
  return {
    itemKind: job.item_kind === "Episode" ? "Episode" : "Movie",
    itemTitle: job.item_title ?? job.item_id,
    seriesId: job.series_id,
    seriesTitle: job.series_title,
    season: job.season,
    episode: job.episode,
  };
}

/** Le minuteur des relectures : il ne tourne que pendant qu'une mesure demandée attend, et s'arrête seul. */
export function ensurePuller(): void {
  const st = state();
  if (st.timer) return;
  st.timer = setInterval(() => {
    if (pendingJobs().length === 0) {
      clearInterval(st.timer!);
      st.timer = null;
      return;
    }
    void pullPending(true).catch((error) => logError("subtitle-sync/pull", error));
  }, PULL_EVERY_MS);
  (st.timer as { unref?: () => void }).unref?.();
}

// ─── La vue ──────────────────────────────────────────────────────────────────

function trackView(r: SyncRow, current: string | null | undefined): SyncTrackView {
  return {
    trackKey: r.track_key,
    kind: r.kind,
    codec: r.codec,
    language: r.language,
    title: r.title,
    forced: !!r.forced,
    hi: !!r.hi,
    offset: r.offset_s,
    scale: r.scale,
    scaleLabel: r.scale_label,
    z: r.z,
    madMs: r.mad_ms,
    windows: r.windows,
    inliers: r.inliers,
    maxErrorS: r.max_error_s,
    confidence: r.confidence,
    verdict: r.verdict,
    reliable: !!r.reliable,
    status: r.status,
    measuredAt: r.measured_at,
    decidedAt: r.decided_at,
    decidedBy: r.decided_by,
    stale: current === undefined ? null : current === null ? null : current !== r.media_etag,
  };
}

const emptyCounts = (): SyncCounts => ({ items: 0, measured: 0, affected: 0, applied: 0, pending: 0 });

function addItem(c: SyncCounts, rows: SyncRow[], job: JobRow | undefined): void {
  c.items++;
  if (rows.length) c.measured++;
  if (rows.some((r) => AFFECTED_VERDICTS.includes(r.verdict))) c.affected++;
  if (rows.some((r) => r.status === "applied")) c.applied++;
  if (job?.state === "queued") c.pending++;
}

function keepItem(filter: SyncFilter, rows: SyncRow[], job: JobRow | undefined): boolean {
  if (filter === "all") return true;
  if (job?.state === "queued" || job?.state === "failed") return true;
  if (filter === "measured") return rows.length > 0;
  return rows.some((r) => AFFECTED_VERDICTS.includes(r.verdict) || r.status === "applied");
}

function itemView(itemId: string, base: { kind: "Movie" | "Episode"; title: string; season: number | null; episode: number | null }, rows: SyncRow[], job: JobRow | undefined, etags: Map<string, string | null> | null): SyncItemView {
  return {
    itemId,
    ...base,
    job: job ? { state: job.state, error: job.error, launchedAt: job.launched_at } : null,
    tracks: rows
      .sort((a, b) => (a.kind === b.kind ? (a.stream_index ?? 0) - (b.stream_index ?? 0) || a.track_key.localeCompare(b.track_key) : a.kind === "embedded" ? -1 : 1))
      .map((r) => trackView(r, etags ? etags.get(itemId) : undefined)),
  };
}

function group<T>(list: T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const t of list) {
    const k = key(t);
    const l = out.get(k);
    if (l) l.push(t);
    else out.set(k, [t]);
  }
  return out;
}

/** L'arbre : les films, puis les séries avec leurs saisons et leurs compteurs. Les épisodes se lisent série par série (`seriesView`). */
export async function treeView(filter: SyncFilter): Promise<SyncTreePayload> {
  if (!xrayConfigured()) return { configured: false, filter, totals: emptyCounts(), pending: 0, movies: [], series: [] };
  if (pendingJobs().length) {
    await pullPending().catch(() => undefined);
    ensurePuller();
  }
  const rows = allRows();
  const jobs = allJobs();
  const rowsBy = group(rows, (r) => r.item_id);
  const jobBy = new Map(jobs.map((j) => [j.item_id, j]));
  const totals = emptyCounts();

  // Les films : ceux de la bibliothèque (filtre « Tout »), ou ceux qui ont une mesure ou une demande.
  const movieBase = new Map<string, { title: string }>();
  for (const r of rows) if (r.item_kind === "Movie") movieBase.set(r.item_id, { title: r.item_title ?? r.item_id });
  for (const j of jobs) if (j.item_kind === "Movie") movieBase.set(j.item_id, { title: j.item_title ?? j.item_id });
  let library: { id: string; title: string }[] = [];
  let seriesLibrary: { id: string; title: string }[] = [];
  let unavailable = false;
  if (filter === "all") {
    try {
      const [movies, series] = await Promise.all([cachedJellyfinMoviesAdmin(), cachedJellyfinSeriesAdmin()]);
      library = movies.filter((m) => isJellyfinId(m.Id)).map((m) => ({ id: m.Id.toLowerCase(), title: m.ProductionYear ? `${m.Name} (${m.ProductionYear})` : m.Name }));
      seriesLibrary = series.filter((s) => isJellyfinId(s.Id)).map((s) => ({ id: s.Id.toLowerCase(), title: s.Name }));
    } catch (error) {
      unavailable = true;
      logError("subtitle-sync/library", error);
    }
    for (const m of library) if (!movieBase.has(m.id)) movieBase.set(m.id, { title: m.title });
  }
  const shownMovies = [...movieBase.entries()].filter(([id]) => keepItem(filter, rowsBy.get(id) ?? [], jobBy.get(id)));
  const etags = await currentEtags(shownMovies.filter(([id]) => rowsBy.has(id)).map(([id]) => id));
  const movies: SyncItemView[] = shownMovies
    .map(([id, b]) => {
      const r = rowsBy.get(id) ?? [];
      addItem(totals, r, jobBy.get(id));
      return itemView(id, { kind: "Movie", title: b.title, season: null, episode: null }, r, jobBy.get(id), etags);
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  // Les séries : compteurs par saison, d'après les mesures et les demandes.
  const seriesTitle = new Map<string, string>();
  for (const s of seriesLibrary) seriesTitle.set(s.id, s.title);
  const perSeries = new Map<string, Map<string, Map<string, { rows: SyncRow[]; job?: JobRow }>>>();
  const slot = (sid: string, season: number | null, itemId: string) => {
    let s = perSeries.get(sid);
    if (!s) perSeries.set(sid, (s = new Map()));
    const k = season === null ? "" : String(season);
    let items = s.get(k);
    if (!items) s.set(k, (items = new Map()));
    let it = items.get(itemId);
    if (!it) items.set(itemId, (it = { rows: [] }));
    return it;
  };
  for (const r of rows) {
    if (r.item_kind !== "Episode" || !r.series_id) continue;
    if (r.series_title) seriesTitle.set(r.series_id, r.series_title);
    slot(r.series_id, r.season, r.item_id).rows.push(r);
  }
  for (const j of jobs) {
    if (j.item_kind !== "Episode" || !j.series_id) continue;
    if (j.series_title && !seriesTitle.has(j.series_id)) seriesTitle.set(j.series_id, j.series_title);
    slot(j.series_id, j.season, j.item_id).job = j;
  }
  const series: SyncSeriesView[] = [];
  const ids = new Set([...perSeries.keys(), ...(filter === "all" ? seriesLibrary.map((s) => s.id) : [])]);
  for (const sid of ids) {
    const counts = emptyCounts();
    const seasons: SyncSeasonView[] = [];
    let kept = filter === "all";
    for (const [k, items] of [...(perSeries.get(sid) ?? new Map<string, Map<string, { rows: SyncRow[]; job?: JobRow }>>()).entries()].sort((a, b) => Number(a[0] || 0) - Number(b[0] || 0))) {
      const sc = emptyCounts();
      for (const it of items.values()) {
        addItem(sc, it.rows, it.job);
        addItem(counts, it.rows, it.job);
        addItem(totals, it.rows, it.job);
        if (keepItem(filter, it.rows, it.job)) kept = true;
      }
      seasons.push({ season: k === "" ? null : Number(k), counts: sc });
    }
    if (!kept) continue;
    series.push({ seriesId: sid, title: seriesTitle.get(sid) ?? sid, counts, seasons });
  }
  series.sort((a, b) => b.counts.affected - a.counts.affected || a.title.localeCompare(b.title));
  return { configured: true, ...(unavailable ? { unavailable } : {}), filter, totals, pending: jobs.filter((j) => j.state === "queued").length, movies, series };
}

/** Les épisodes d'une série, saison par saison — tous ceux de la bibliothèque (filtre « Tout »), ou ceux mesurés. */
export async function seriesView(seriesId: string, filter: SyncFilter): Promise<SyncSeriesPayload> {
  if (!xrayConfigured()) return { configured: false, seriesId, seasons: [] };
  const sid = seriesId.toLowerCase();
  const rows = rowsForSeries(sid);
  const rowsBy = group(rows, (r) => r.item_id);
  const base = new Map<string, { title: string; season: number | null; episode: number | null }>();
  for (const r of rows) base.set(r.item_id, { title: r.item_title ?? r.item_id, season: r.season, episode: r.episode });
  try {
    const episodes = await jellyfin.getEpisodesAdmin(sid);
    for (const e of episodes) {
      if (!isJellyfinId(e.Id) || (e as { LocationType?: string }).LocationType === "Virtual") continue;
      const id = e.Id.toLowerCase();
      const code = e.ParentIndexNumber != null && e.IndexNumber != null ? `S${String(e.ParentIndexNumber).padStart(2, "0")}E${String(e.IndexNumber).padStart(2, "0")}` : "";
      base.set(id, { title: `${code}${e.Name ? ` · ${e.Name}` : ""}`.trim() || e.Name, season: e.ParentIndexNumber ?? null, episode: e.IndexNumber ?? null });
    }
  } catch (error) {
    logError("subtitle-sync/series", error, { seriesId: sid });
  }
  const jobBy = new Map(jobsForItems([...base.keys()]).map((j) => [j.item_id, j]));
  const kept = [...base.entries()].filter(([id]) => keepItem(filter, rowsBy.get(id) ?? [], jobBy.get(id)));
  const etags = await currentEtags(kept.filter(([id]) => rowsBy.has(id)).map(([id]) => id));
  const bySeason = new Map<string, SyncItemView[]>();
  for (const [id, b] of kept) {
    const view = itemView(id, { kind: "Episode", ...b }, rowsBy.get(id) ?? [], jobBy.get(id), etags);
    const k = b.season === null ? "" : String(b.season);
    const list = bySeason.get(k);
    if (list) list.push(view);
    else bySeason.set(k, [view]);
  }
  const seasons: SyncSeasonView[] = [...bySeason.entries()]
    .sort((a, b) => Number(a[0] || 0) - Number(b[0] || 0))
    .map(([k, episodes]) => {
      const counts = emptyCounts();
      for (const e of episodes) addItem(counts, rowsBy.get(e.itemId) ?? [], jobBy.get(e.itemId));
      episodes.sort((a, b) => (a.episode ?? 0) - (b.episode ?? 0));
      return { season: k === "" ? null : Number(k), counts, episodes };
    });
  return { configured: true, seriesId: sid, seasons };
}

/**
 * « Recaler » / « Refuser » / « Rétablir » sur une portée. Une saison, une série, un élément entier ou une liste de
 * films n'applique que des mesures fiables d'un décalage ou d'une dérive ; une piste seule, toute mesure qui a un
 * décalage (l'administrateur l'a regardée). Jamais une mesure périmée : la version du fichier est relue chez
 * Jellyfin au moment de décider.
 */
export async function decideScope(scope: SyncDecideScope, action: SyncAction, by: string): Promise<number> {
  let rows: SyncRow[];
  if (scope.scope === "track") {
    rows = rowsForItems([scope.itemId]).filter((r) => r.track_key === scope.trackKey);
  } else if (scope.scope === "series" || scope.scope === "season") {
    rows = rowsForSeries(scope.seriesId).filter((r) => scope.scope === "series" || r.season === scope.season);
  } else {
    rows = rowsForItems(scope.scope === "item" ? [scope.itemId] : scope.itemIds);
  }
  const etags = action === "apply" ? await currentEtags([...new Set(rows.map((r) => r.item_id))], true) : new Map<string, string | null>();
  const changed = decide(rows, action, by, { strict: scope.scope !== "track", currentEtag: (id) => etags.get(id) });
  taskLog("synchro des sous-titres", `${action === "apply" ? "recalé" : action === "reject" ? "refusé" : "rétabli"} · ${changed} piste${changed > 1 ? "s" : ""}`, {
    portée: scope.scope,
    par: by,
  });
  return changed;
}
