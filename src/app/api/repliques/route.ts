import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { createRateLimiter } from "@/lib/rateLimiter";
import { blockedTagsOf, carriesBlockedTag } from "@/lib/blockedTags";
import { cachedJellyfinMoviesAdmin } from "@/lib/server-cache";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { logError } from "@/lib/logger";
import { dialogueIndexHasLines, searchDialogue } from "@/lib/repliques/search";

/**
 * Chercher une réplique dans les films (DECISIONS.md §88).
 *
 * Sans `q` : la recherche existe-t-elle ? (option active **et** index non vide) — la section et la
 * puce « Répliques » n'apparaissent qu'à cette condition. Avec `q` : les films dont une réplique
 * répond, quelques répliques chacun ; avec `film` en plus, toutes celles d'un film (« voir plus »).
 *
 * Un film qu'un tag bloqué cache au compte n'apparaît jamais : il est retiré **dans la requête**
 * (§54), comme le catalogue le retire de ses réponses — l'écran ne le filtre qu'en second.
 * Une borne par compte, la même que la recherche des titres : 120 par minute.
 */
export const dynamic = "force-dynamic";

const allowed = createRateLimiter(120, 60_000);
const MAX_QUERY = 200;

export async function GET(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const headers = { "Cache-Control": "private, no-store" };
  if (!config.repliques.enabled) return NextResponse.json({ available: false }, { headers });
  let available = false;
  try {
    available = dialogueIndexHasLines();
  } catch (error) {
    logError("repliques.search", error);
  }
  const q = (req.nextUrl.searchParams.get("q") ?? "").slice(0, MAX_QUERY).trim();
  if (!available || !q) return NextResponse.json({ available }, { headers });
  if (!allowed(session.jfId ?? session.u ?? "anonyme")) {
    return NextResponse.json({ available, error: "Trop de recherches, réessayez dans une minute." }, { status: 429, headers });
  }
  const film = req.nextUrl.searchParams.get("film");
  if (film !== null && !isJellyfinId(film)) return NextResponse.json({ error: "invalid" }, { status: 400 });

  const blocked = session.jfId ? await blockedTagsOf(session.jfId) : [];
  const hidden: string[] = [];
  if (blocked.length > 0) {
    const items = await cachedJellyfinMoviesAdmin().catch(() => null);
    // Jellyfin muet alors que le compte a des tags bloqués : rien plutôt qu'un titre caché.
    if (!items) return NextResponse.json({ available, terms: [], prefixes: [], films: [] }, { headers });
    for (const item of items) if (carriesBlockedTag(item.Tags, blocked)) hidden.push(item.Id);
  }
  if (film && hidden.includes(film)) return NextResponse.json({ available, terms: [], prefixes: [], films: [] }, { headers });

  try {
    const result = searchDialogue(q, film ? { hidden, itemId: film, perFilm: 30, films: 1 } : { hidden });
    return NextResponse.json({ available, ...result }, { headers });
  } catch (error) {
    // Une requête que FTS5 refuse (syntaxe) ne doit pas devenir une panne de la recherche.
    logError("repliques.search", error, { q });
    return NextResponse.json({ available, terms: [], prefixes: [], films: [] }, { headers });
  }
}
