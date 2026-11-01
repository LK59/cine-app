// Le masquage des demandes pour un compte (01/11/2026) — lecture des sources et recopie dans Jellyfin.
// Les règles sont dans `rules.ts`.
//
// Toutes les cinq minutes, et juste après chaque geste de l'écran : les demandes Jellyseerr et la
// bibliothèque Jellyfin sont relues, l'automatique décide pour les nouvelles demandes, puis chaque titre
// dont le tag ne dit pas la décision est corrigé dans Jellyfin, et le tag est (re)bloqué sur le compte
// visé — sur lui seul. Un tag effacé par une actualisation de métadonnées revient au passage suivant.
//
// L'écriture d'un titre passe par sa fiche entière (`GET /Items/<id>`, puis `POST /Items/<id>` avec les
// tags changés) : c'est ce que fait l'interface de Jellyfin. Vérifié le 01/11/2026 qu'un aller-retour
// sans changement ne modifie rien d'autre que l'`Etag`. Les bibliothèques n'enregistrent aucune
// métadonnée à côté des fichiers (pas de NFO) : rien n'est écrit dans les dossiers des médias.

import { config } from "@/lib/config";
import { requestHideDb } from "@/lib/db";
import { fetchJson, upstreamSignal, UPSTREAM_TIMEOUT_MS } from "@/lib/http";
import { jellyfin, type JellyfinItem } from "@/lib/clients/jellyfin";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { jellyfinFetch } from "@/lib/jellyfinBreaker";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { invalidateJellyfinLibrary } from "@/lib/server-cache";
import { forgetBlockedTags } from "@/lib/blockedTags";
import { taskLog, taskError } from "@/lib/taskLog";
import { logError } from "@/lib/logger";
import {
  autoChanges,
  buildView,
  hiddenKeys,
  nameSet,
  retag,
  summarize,
  titleKey,
  type HideRequest,
  type LibraryTitle,
  type ViewItem,
} from "./rules";

const INTERVAL_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 90_000;
const AUTO_SINCE = "autoSince";

interface RawRequest {
  createdAt?: string;
  type?: string;
  media?: { tmdbId?: number; tvdbId?: number | null; mediaType?: string };
  requestedBy?: { displayName?: string; username?: string; jellyfinUsername?: string; jellyfinUserId?: string } | null;
}

interface JellyfinUser {
  Id?: string;
  Name?: string;
  Policy?: { IsAdministrator?: boolean; IsDisabled?: boolean; BlockedTags?: string[] | null } & Record<string, unknown>;
}

export interface SyncReport {
  at: number;
  hidden: number;
  shown: number;
  failed: number;
  error: string | null;
}

/**
 * L'état du passage, sur `globalThis` : la tâche part d'`instrumentation.ts` et l'écran le lit depuis
 * une route, deux copies de ce module (voir CLAUDE.md, `server-cache.ts`).
 */
interface Shared {
  running: Promise<SyncReport> | null;
  again: boolean;
  last: SyncReport | null;
  started: boolean;
}
const shared: Shared = ((globalThis as Record<symbol, unknown>)[Symbol.for("cine-app.requestHide")] ??= {
  running: null,
  again: false,
  last: null,
  started: false,
}) as Shared;

function jfHeaders(): Record<string, string> {
  return { ...jellyfinAuthHeaders(config.jellyfin.apiKey), "Content-Type": "application/json" };
}

async function readUsers(): Promise<JellyfinUser[]> {
  const res = await jellyfinFetch(`${config.jellyfin.url}/Users`, { headers: jfHeaders(), signal: upstreamSignal(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET /Users : HTTP ${res.status}`);
  const body = (await res.json()) as unknown;
  return Array.isArray(body) ? (body as JellyfinUser[]) : [];
}

/** Toutes les demandes, page par page (535 le 01/11/2026). */
async function readRequests(): Promise<RawRequest[]> {
  const out: RawRequest[] = [];
  const take = 100;
  for (let skip = 0; skip < 20_000; skip += take) {
    const page = await fetchJson<{ results?: RawRequest[]; pageInfo?: { results?: number } }>(
      `${config.jellyseerr.url}/api/v1/request?filter=all&take=${take}&skip=${skip}&sort=added`,
      { headers: { "X-Api-Key": config.jellyseerr.apiKey } },
      15_000,
    );
    const results = page.results ?? [];
    out.push(...results);
    if (results.length < take || skip + take >= (page.pageInfo?.results ?? 0)) break;
  }
  return out;
}

interface Sources {
  requests: HideRequest[];
  library: LibraryTitle[];
  target: JellyfinUser | null;
  adminId: string | null;
}

async function readSources(): Promise<Sources> {
  const tag = config.requestHide.tag;
  const keep = nameSet(config.requestHide.keep);
  const [users, raw, movies, series] = await Promise.all([readUsers(), readRequests(), jellyfin.getAllMoviesAdmin(), jellyfin.getAllSeriesAdmin()]);
  // Un compte gardé se reconnaît à son identifiant Jellyfin, ou à défaut à l'un de ses noms dans Jellyseerr.
  const idOf = (id: string) => id.replace(/-/g, "").toLowerCase();
  const keepIds = new Set(users.filter((u) => u.Id && u.Name && keep.has(u.Name.toLowerCase())).map((u) => idOf(u.Id as string)));
  const target = users.find((u) => (u.Name ?? "").toLowerCase() === config.requestHide.account.toLowerCase()) ?? null;
  const adminId = users.find((u) => u.Policy?.IsAdministrator && !u.Policy?.IsDisabled)?.Id ?? null;

  const tvdbToKey = new Map<string, string>();
  const requests: HideRequest[] = [];
  for (const r of raw) {
    const kind = r.type === "movie" ? "movie" : r.type === "tv" ? "series" : null;
    if (!kind) continue;
    const key = titleKey(kind, r.media?.tmdbId);
    if (!key) continue;
    if (kind === "series" && r.media?.tvdbId) tvdbToKey.set(String(r.media.tvdbId), key);
    const by = r.requestedBy;
    // Une demande dont l'auteur a disparu de Jellyseerr ne dit pas qui la voulait : elle ne rend pas un
    // titre candidat (comme un ajout direct dans Radarr/Sonarr).
    if (!by) continue;
    const names = [by.jellyfinUsername, by.username, by.displayName].filter((n): n is string => !!n);
    const kept = (!!by.jellyfinUserId && keepIds.has(idOf(by.jellyfinUserId))) || names.some((n) => keep.has(n.toLowerCase()));
    requests.push({ key, createdAt: Date.parse(r.createdAt ?? "") || 0, requester: by.jellyfinUsername || by.displayName || by.username || "?", kept });
  }

  const library: LibraryTitle[] = [];
  const add = (item: JellyfinItem, kind: "movie" | "series") => {
    const key =
      titleKey(kind, item.ProviderIds?.Tmdb) ?? (kind === "series" && item.ProviderIds?.Tvdb ? (tvdbToKey.get(item.ProviderIds.Tvdb) ?? titleKey(kind, null, item.ProviderIds.Tvdb)) : null);
    if (!key || !item.Id) return;
    library.push({
      key,
      jfId: item.Id,
      kind,
      name: item.Name ?? "",
      year: item.ProductionYear ?? null,
      imageTag: item.ImageTags?.Primary ?? null,
      tagged: (item.Tags ?? []).some((t) => t.toLowerCase() === tag.toLowerCase()),
    });
  };
  for (const m of movies) add(m, "movie");
  for (const s of series) add(s, "series");
  return { requests, library, target, adminId };
}

/** Le tag bloqué sur le compte visé — et sur lui seul : aucun autre compte n'est touché. */
async function ensureBlocked(target: JellyfinUser): Promise<void> {
  const tag = config.requestHide.tag;
  if (!target.Id || !target.Policy) return;
  const current = (target.Policy.BlockedTags ?? []).filter((t): t is string => typeof t === "string");
  if (current.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
  const res = await jellyfinFetch(`${config.jellyfin.url}/Users/${jellyfinIdSegment(target.Id)}/Policy`, {
    method: "POST",
    headers: jfHeaders(),
    body: JSON.stringify({ ...target.Policy, BlockedTags: [...current, tag] }),
    signal: upstreamSignal(UPSTREAM_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`POST /Users/…/Policy : HTTP ${res.status}`);
  forgetBlockedTags();
  taskLog("masquage", "tag bloqué sur le compte", { compte: target.Name, tag });
}

/** Le tag posé ou retiré sur un titre, par sa fiche entière. */
async function writeTag(adminId: string, jfId: string, want: boolean): Promise<boolean> {
  const base = `${config.jellyfin.url}/Items/${jellyfinIdSegment(jfId)}`;
  const res = await jellyfinFetch(`${base}?userId=${jellyfinIdSegment(adminId)}`, { headers: jfHeaders(), signal: upstreamSignal(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET /Items/… : HTTP ${res.status}`);
  const item = (await res.json()) as { Tags?: string[] } & Record<string, unknown>;
  const tags = retag(item.Tags, config.requestHide.tag, want);
  if (!tags) return false;
  // Ce que la mise à jour ne lit pas, et que Jellyfin ne sait pas relire : renvoyé tel quel, le champ
  // des aperçus (`Trickplay`) d'un film fait échouer la requête (HTTP 500, vu le 01/11/2026). Sans ces
  // quatre champs, l'aller-retour ne change toujours que l'`Etag`.
  const { Trickplay: _t, MediaSources: _m, MediaStreams: _s, Chapters: _c, ...rest } = item;
  const post = await jellyfinFetch(base, {
    method: "POST",
    headers: jfHeaders(),
    body: JSON.stringify({ ...rest, Tags: tags }),
    signal: upstreamSignal(UPSTREAM_TIMEOUT_MS),
  });
  if (!post.ok) throw new Error(`POST /Items/… : HTTP ${post.status}`);
  return true;
}

function autoSince(): number | null {
  const v = Number(requestHideDb.meta(AUTO_SINCE));
  return Number.isFinite(v) && v > 0 ? v : null;
}

async function syncOnce(): Promise<SyncReport> {
  const report: SyncReport = { at: Date.now(), hidden: 0, shown: 0, failed: 0, error: null };
  try {
    const { requests, library, target, adminId } = await readSources();
    if (!target) throw new Error(`compte « ${config.requestHide.account} » introuvable dans Jellyfin`);
    if (!adminId) throw new Error("aucun administrateur Jellyfin pour lire les fiches");

    const summaries = summarize(requests);
    const titles = new Map(library.map((t) => [t.key, t.name]));
    const { hide, drop } = autoChanges(summaries, requestHideDb.all(), autoSince());
    if (hide.length) requestHideDb.set(hide.map((key) => ({ key, state: "hidden", source: "auto", title: titles.get(key) ?? null })));
    if (drop.length) requestHideDb.remove(drop);

    await ensureBlocked(target);

    const hidden = hiddenKeys(requestHideDb.all());
    for (const t of library) {
      const want = hidden.has(t.key);
      if (t.tagged === want) continue;
      try {
        if (await writeTag(adminId, t.jfId, want)) {
          if (want) report.hidden++;
          else report.shown++;
        }
      } catch (err) {
        report.failed++;
        logError("request-hide.write", err, { item: t.jfId, name: t.name });
      }
    }
    if (report.hidden || report.shown) {
      // Le cinéma relit les listes et leurs tags : le compte visé ne voit plus ces titres ici non plus.
      invalidateJellyfinLibrary();
      taskLog("masquage", "liste recopiée dans Jellyfin", { compte: target.Name, masqués: report.hidden, rendus: report.shown, échecs: report.failed || undefined });
    }
    if (hide.length) taskLog("masquage", "nouvelles demandes masquées", { compte: target.Name, titres: hide.length });
  } catch (err) {
    report.error = err instanceof Error ? err.message : String(err);
    taskError("masquage", "passage manqué", { erreur: report.error });
    logError("request-hide.sync", err);
  }
  shared.last = report;
  return report;
}

/** Un passage à la fois ; un geste pendant un passage en relance un juste après. */
export function syncRequestHide(): Promise<SyncReport> {
  if (!config.requestHide.enabled) return Promise.resolve({ at: Date.now(), hidden: 0, shown: 0, failed: 0, error: "coupé" });
  if (shared.running) {
    shared.again = true;
    return shared.running;
  }
  const run = (async () => {
    let report = await syncOnce();
    while (shared.again) {
      shared.again = false;
      report = await syncOnce();
    }
    return report;
  })().finally(() => {
    shared.running = null;
  });
  shared.running = run;
  return run;
}

export interface RequestHideView {
  account: string;
  keep: string[];
  tag: string;
  autoSince: number | null;
  syncing: boolean;
  last: SyncReport | null;
  items: ViewItem[];
}

export async function requestHideView(): Promise<RequestHideView> {
  const { requests, library } = await readSources();
  return {
    account: config.requestHide.account,
    keep: [...nameSet(config.requestHide.keep)],
    tag: config.requestHide.tag,
    autoSince: autoSince(),
    syncing: shared.running !== null,
    last: shared.last,
    items: buildView(library, summarize(requests), requestHideDb.all()),
  };
}

/** Les gestes de l'écran. Masquer et rendre visible sont des décisions à la main : l'automatique n'y revient pas. */
export function decide(keys: readonly string[], state: "hidden" | "shown", titles: ReadonlyMap<string, string> = new Map()): void {
  requestHideDb.set(keys.map((key) => ({ key, state, source: "manual" as const, title: titles.get(key) ?? null })));
}

/**
 * Allumé, l'automatique vaut pour les demandes faites à partir de cet instant ; rallumé après une coupure,
 * il repart de ce nouvel instant — ce qui a été demandé entre-temps attend dans « À trier ».
 */
export function setAuto(on: boolean, now = Date.now()): void {
  if (on && autoSince() !== null) return;
  requestHideDb.setMeta(AUTO_SINCE, on ? String(now) : null);
}

export function startRequestHideCron(): void {
  if (shared.started) return;
  shared.started = true;
  const run = () => {
    if (!config.requestHide.enabled) return;
    void syncRequestHide();
  };
  const startup = setTimeout(run, STARTUP_DELAY_MS);
  startup.unref?.();
  const interval = setInterval(run, INTERVAL_MS);
  interval.unref?.();
}
