import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { hiddenTmdbKeysFor } from "@/lib/blockedTags";
import { catalogueMembers } from "@/lib/catalogueMembers";
import { createTmdbClient, tmdb } from "@/lib/clients/tmdb";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";
import { createRateLimiter } from "@/lib/rateLimiter";
import { aiDailyRefund, aiDailyTake } from "@/lib/aiFeatures";
import { LOCALE_COOKIE, getTmdbLocale, type Locale } from "@/lib/i18n";
import { logError } from "@/lib/logger";
import { logDescribeSearch } from "@/lib/eventLogs";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { makeEntry, searchLibraryIndex } from "@/lib/searchLibraryIndex";
import { describedTitles, describeSearchAvailable, findOnTmdb } from "@/lib/describeSearch";
import { looksLikeDescription } from "@/lib/describeQuery";
import type { UnifiedSearchResult } from "@/app/api/search/route";

export const dynamic = "force-dynamic";

/**
 * La recherche par description (`describeSearch.ts`).
 *
 * Sans `q` : `{ available }`, ce que l'écran lit une fois pour savoir s'il doit essayer. Avec `q` :
 * les titres reconnus, en cartes de recherche ordinaires (`makeEntry`, la même règle « dans la
 * bibliothèque / à demander » que `/api/search`), sans ce que les tags bloqués du compte lui cachent
 * — filtré après le cache, comme la recherche ordinaire (§54). Le texte du modèle ne sort jamais
 * d'ici : seulement des titres retrouvés dans TMDB.
 *
 * Une borne par compte : chaque phrase nouvelle est un appel payant. Trente par minute laisse taper
 * en paix et arrête une boucle. Depuis le 11/11/2026, aussi la borne journalière commune à tous les appels payants
 * du compte (`aiDailyTake`) : prise avant, rendue quand le cache a répondu sans le modèle.
 *
 * Chaque phrase laisse une ligne dans `recherche.log` (`logDescribeSearch`) : compte, mots, délai,
 * cache ou modèle, résultats — jamais la phrase.
 */
const describeAllowed = createRateLimiter(30, 60_000);
const SEARCH_JELLYFIN_WAIT_MS = 1500;
/** Une phrase, pas un texte : la borne de `/api/search`. */
const MAX_QUERY_LENGTH = 200;

export async function GET(req: NextRequest) {
  const available = describeSearchAvailable();
  const q = (req.nextUrl.searchParams.get("q") ?? "").slice(0, MAX_QUERY_LENGTH).trim();
  if (!q || !available) return NextResponse.json({ available, results: [] });
  // La même règle que l'écran : une frappe qui n'est pas une description ne coûte rien.
  if (!looksLikeDescription(q)) return NextResponse.json({ available, results: [] });

  const started = Date.now();
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  const who = { user: session?.jfUser ?? session?.u ?? "anonyme", device: requestDeviceLabel(req), words: q.split(/\s+/).length };
  const account = session?.jfId ?? session?.u ?? "anonyme";
  if (!describeAllowed(account)) {
    logDescribeSearch({ ...who, status: "limite", ms: Date.now() - started });
    return NextResponse.json({ available, results: [] }, { status: 429 });
  }

  const rawLang = req.cookies.get(LOCALE_COOKIE)?.value ?? "";
  const locale: Locale = rawLang === "en" || rawLang === "es" || rawLang === "de" ? rawLang : "fr";
  const tmdbLocale = getTmdbLocale(locale);
  const client = tmdbLocale === "fr-FR" ? tmdb : createTmdbClient(tmdbLocale);
  if (!client.isEnabled()) return NextResponse.json({ available, results: [] });
  if (!aiDailyTake(account)) {
    logDescribeSearch({ ...who, status: "limite", ms: Date.now() - started });
    return NextResponse.json({ available, results: [] }, { status: 429 });
  }

  let titles;
  let modelMs: number | undefined;
  try {
    titles = await describedTitles(q, (ms) => {
      modelMs = ms;
    });
  } catch (error) {
    // Une panne n'est pas rendue à la borne du jour : l'appel a pu être facturé.
    logError("describe-search", error);
    logDescribeSearch({ ...who, status: "erreur", ms: Date.now() - started });
    return NextResponse.json({ available, results: [] }, { status: 502 });
  }

  // Servie par le cache, sans le modèle : rien n'a coûté, la place du jour est rendue.
  if (modelMs === undefined) aiDailyRefund(account);

  const [hits, movies, series, members] = await Promise.all([
    Promise.all(titles.map((t) => findOnTmdb(t, client, tmdbLocale).catch(() => null))),
    cachedMovies().catch(() => []),
    cachedSeries().catch(() => []),
    catalogueMembers({ jellyfinWaitMs: SEARCH_JELLYFIN_WAIT_MS }),
  ]);
  const index = searchLibraryIndex(movies, series, members);
  const hidden = await hiddenTmdbKeysFor(session?.jfId);

  const seen = new Set<string>();
  const results: UnifiedSearchResult[] = [];
  hits.forEach((hit, i) => {
    if (!hit) return;
    const type = titles[i].type;
    const key = `${type}:${hit.id}`;
    if (seen.has(key) || hidden.has(key)) return;
    seen.add(key);
    results.push(makeEntry(hit, type, index.radarrByTmdb, index.sonarrByTmdb, "tmdb", index.playable));
  });
  logDescribeSearch({
    ...who,
    status: "ok",
    ms: Date.now() - started,
    ...(modelMs === undefined ? {} : { modelMs }),
    titles: titles.length,
    results: results.length,
    inLibrary: results.filter((r) => r.inLibrary).length,
  });
  return NextResponse.json({ available, results });
}
