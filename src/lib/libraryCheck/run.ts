import { execFile } from "node:child_process";
import { taskLog } from "@/lib/taskLog";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { serviceConfigured } from "@/lib/serviceConfigured";
import {
  cachedJellyfinMoviesAdmin,
  cachedJellyfinSeriesAdmin,
  cachedMovies,
  cachedSeries,
  cachedSonarrEpisodeTexts,
  withPersistentCache,
} from "@/lib/server-cache";
import { jellyfin } from "@/lib/clients/jellyfin";
import { tmdb } from "@/lib/clients/tmdb";
import { matchMovies, matchSeries, jellyfinOnlyMovies, jellyfinOnlySeries } from "@/lib/catalogueMembers";
import { seasonText } from "@/lib/episodeFallback";
import { mapInBatches, yieldToLoop } from "@/lib/inBatches";
import { MEDIA_ROOT, MOVIES_PATH, TV_PATH } from "@/lib/media-paths";
import { logError } from "@/lib/logger";
import { asJellyfinWitness } from "@/lib/jellyfinBreaker";
import { analyseLibrary, hardlinkPairs, type CheckDeps } from "./analyse";
import { episodeTextTrustDb, libraryCheckDb, LIBRARY_CHECK_VERSION } from "./store";
import type { LibraryCheckResult, LibraryCheckStatus, SourceState, TmdbFacts } from "./types";

const execFileAsync = promisify(execFile);

/**
 * Le contrôle de la bibliothèque, lancé à la demande (« Analyser ») ou de lui-même quand le dernier
 * résultat a plus d'un jour (DECISIONS.md §90). Une seule analyse à la fois ; elle ne bloque jamais la
 * boucle — les séries par lots de quatre, une respiration entre deux lots — et n'écrit nulle part
 * ailleurs que dans sa propre table.
 *
 * Mesuré le 14/10/2026 sur cette bibliothèque (≈ 800 films, 200 séries) : voir §90.
 */

const FRESH_MS = 24 * 3600_000;
const TMDB_FACTS_TTL_MS = 14 * 24 * 3600_000;

interface RunState {
  running: Promise<void> | null;
  startedAt: number | null;
  progress: { step: string; done: number; total: number } | null;
  error: { at: number; message: string } | null;
}
const state: RunState = { running: null, startedAt: null, progress: null, error: null };

export function libraryCheckStatus(): LibraryCheckStatus {
  const result = libraryCheckDb.get();
  return {
    running: state.running !== null,
    startedAt: state.startedAt,
    progress: state.progress,
    error: state.error && (!result || state.error.at > result.computedAt) ? state.error.message : null,
    result,
    trusted: episodeTextTrustDb.all().map(({ sonarrId, title, createdAt }) => ({ sonarrId, title, createdAt })),
  };
}

/** Lance une analyse si aucune ne tourne. Rend la promesse de celle qui tourne (pour les tests). */
export function startLibraryCheck(): Promise<void> {
  if (state.running) return state.running;
  state.startedAt = Date.now();
  state.progress = { step: "load", done: 0, total: 0 };
  taskLog("contrôle bibliothèque", "analyse lancée");
  // En témoin du coupe-circuit (§92) : quatre appels lourds en parallèle sur un Jellyfin occupé
  // dépassaient leur délai ensemble et ouvraient la panne pour tout le cinéma (relecture du 14/10/2026).
  state.running = asJellyfinWitness(runOnce)
    .then((result) => {
      libraryCheckDb.set(result);
      state.error = null;
      taskLog("contrôle bibliothèque", "analyse terminée", { s: state.startedAt ? Math.round((Date.now() - state.startedAt) / 1000) : null });
    })
    .catch((err: unknown) => {
      state.error = { at: Date.now(), message: err instanceof Error ? err.message : String(err) };
      logError("library-check", err);
    })
    .finally(() => {
      state.running = null;
      state.progress = null;
      state.startedAt = null;
    });
  return state.running;
}

/** Le résultat a plus d'un jour, ou n'existe pas : une analyse part en arrière-plan. */
export function refreshLibraryCheckIfStale(now = Date.now()): void {
  if (state.running || state.error && now - state.error.at < 3600_000) return;
  const result = libraryCheckDb.get();
  if (!result || now - result.computedAt > FRESH_MS) void startLibraryCheck();
}

// ─── Les questions à TMDB : des projections, gardées deux semaines ───────────

const yearOf = (date: string | undefined) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);

const tmdbDeps: Pick<CheckDeps, "movieFacts" | "tvFacts" | "seasonTitles"> = {
  movieFacts: (tmdbId) =>
    withPersistentCache(`tmdb:check-facts:v1:movie:${tmdbId}`, TMDB_FACTS_TTL_MS, async (): Promise<TmdbFacts> => {
      const m = await tmdb.getMovie(tmdbId);
      return { tmdbId, title: m.title ?? null, year: yearOf(m.release_date), runtime: m.runtime ?? null };
    }),
  tvFacts: (tmdbId) =>
    withPersistentCache(`tmdb:check-facts:v1:tv:${tmdbId}`, TMDB_FACTS_TTL_MS, async (): Promise<TmdbFacts> => {
      const t = await tmdb.getTv(tmdbId);
      const seasons: Record<string, number> = {};
      for (const s of t.seasons ?? []) if (s.season_number > 0) seasons[String(s.season_number)] = s.episode_count;
      return { tmdbId, title: t.name ?? null, year: yearOf(t.first_air_date), runtime: null, seasons };
    }),
  // Les mêmes saisons que la fiche relit (`seasonText`, une semaine sur le disque) : français, puis anglais.
  seasonTitles: async (tmdbId, season) => {
    const [fr, en] = await Promise.all([seasonText(tmdbId, season, "fr-FR").catch(() => null), seasonText(tmdbId, season, "en-US").catch(() => null)]);
    const out = new Map<number, string[]>();
    for (const source of [fr, en]) {
      for (const [n, e] of source ?? []) if (e.name) out.set(n, [...(out.get(n) ?? []), e.name]);
    }
    return out;
  },
};

// ─── e. Les liens physiques ──────────────────────────────────────────────────

/**
 * Les fichiers vidéo à plusieurs liens sous les dossiers des films et des séries — un seul processus
 * `find` (BusyBox : pas de `-printf`, d'où `stat`), environ une seconde ici pour 7 900 fichiers.
 * Les seeds ne sont pas parcourus : un lien vers eux est le fonctionnement normal.
 */
async function readHardlinks(): Promise<{ folders: [string, string]; files: number }[] | null> {
  const roots = [MOVIES_PATH, TV_PATH].filter((p) => existsSync(p));
  if (roots.length === 0) return null;
  const video = ["mkv", "mp4", "m4v", "avi", "ts", "webm", "mov"].flatMap((ext, i) => (i === 0 ? [] : ["-o"]).concat(["-iname", `*.${ext}`]));
  const { stdout } = await execFileAsync("find", [...roots, "-type", "f", "-links", "+1", "(", ...video, ")", "-exec", "stat", "-c", "%d:%i\t%n", "{}", "+"], {
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  }).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? "" }));
  return hardlinkPairs(stdout, roots.map((prefix) => ({ prefix, label: path.relative(MEDIA_ROOT, prefix) || path.basename(prefix) })));
}

// ─── Une analyse ─────────────────────────────────────────────────────────────

async function runOnce(): Promise<LibraryCheckResult> {
  const started = Date.now();
  const configured = { radarr: serviceConfigured("radarr"), sonarr: serviceConfigured("sonarr") };
  const [movies, series, jfMovies, jfSeries] = await Promise.all([
    cachedMovies().catch(() => null),
    cachedSeries().catch(() => null),
    cachedJellyfinMoviesAdmin().catch(() => null),
    cachedJellyfinSeriesAdmin().catch(() => null),
  ]);
  if (!jfMovies || !jfSeries) throw new Error("Jellyfin ne répond pas");

  // La règle du catalogue, telle quelle (`catalogueMembers`) : Radarr/Sonarr en panne, rien de « Jellyfin seul » de ce côté.
  const matchedMovies = movies ? matchMovies(movies, jfMovies) : [];
  const matchedSeries = series ? matchSeries(series, jfSeries) : [];
  const onlyMovies = movies ? jellyfinOnlyMovies(jfMovies, matchedMovies) : [];
  const onlySeries = series ? await jellyfinOnlySeries(jfSeries, matchedSeries) : [];
  await yieldToLoop();

  state.progress = { step: "episodes", done: 0, total: matchedSeries.length };
  const seriesData = new Map<number, { attached: Awaited<ReturnType<typeof cachedSonarrEpisodeTexts>>; episodes: Awaited<ReturnType<typeof jellyfin.getEpisodesAdmin>> }>();
  let done = 0;
  await mapInBatches(matchedSeries, 4, async ({ s, jfItem }) => {
    const [attached, episodes] = await Promise.all([cachedSonarrEpisodeTexts(s.id).catch(() => null), jellyfin.getEpisodesAdmin(jfItem.Id).catch(() => null)]);
    if (attached && episodes) seriesData.set(s.id, { attached, episodes });
    state.progress = { step: "episodes", done: ++done, total: matchedSeries.length };
  });

  state.progress = { step: "hardlinks", done: 0, total: 0 };
  const hardlinks = await readHardlinks().catch(() => null);

  const tmdbOn = serviceConfigured("tmdb");
  const deps: CheckDeps = {
    ...(tmdbOn ? tmdbDeps : { movieFacts: async () => null, tvFacts: async () => null, seasonTitles: async () => new Map() }),
    progress: async (step, d, total) => {
      state.progress = { step, done: d, total };
      await yieldToLoop();
    },
  };
  const { findings, counts } = await analyseLibrary(
    {
      configured,
      movies,
      series,
      matchedMovies,
      matchedSeries,
      onlyMovies,
      onlySeries,
      seriesData,
      hardlinks,
      trusted: new Set(episodeTextTrustDb.all().map((t) => t.sonarrId)),
    },
    deps
  );

  const source = (isConfigured: boolean, value: unknown): SourceState => (!isConfigured ? "unconfigured" : value ? "ok" : "down");
  return {
    version: LIBRARY_CHECK_VERSION,
    computedAt: Date.now(),
    durationMs: Date.now() - started,
    sources: {
      radarr: source(configured.radarr, movies),
      sonarr: source(configured.sonarr, series),
      jellyfin: "ok",
      tmdb: tmdbOn ? "ok" : "unconfigured",
      media: hardlinks ? "ok" : "absent",
    },
    counts,
    findings,
  };
}
