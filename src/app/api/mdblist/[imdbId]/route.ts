import { NextRequest, NextResponse } from "next/server";
import { withPersistentCache } from "@/lib/server-cache";
import { createRateLimiter } from "@/lib/rateLimiter";
import { getClientIp } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const mdblistRateLimit = createRateLimiter(60, 60_000);

export interface MdbRatings {
  imdb: number | null;        // 0–100, display as /10 (÷10)
  tomatoes: number | null;    // 0–100 %
  tomatoesAudience: number | null;
  metacritic: number | null;  // 0–100
  metacriticUser: number | null;
  letterboxd: number | null;  // 0–100, display as /5 (÷20)
  trakt: number | null;       // 0–100 %
  tmdb: number | null;        // 0–100 %
}

const IMDB_RE = /^tt\d{6,8}$/;

async function fetchRatings(imdbId: string): Promise<MdbRatings> {
  const key = process.env.MDBLIST_API_KEY;
  if (!key) throw new Error("no key");
  const res = await fetch(`https://mdblist.com/api/?apikey=${key}&i=${imdbId}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`mdblist ${res.status}`);
  const data = await res.json();
  const map: Record<string, number | null> = {};
  for (const r of data.ratings ?? []) {
    if (typeof r.score === "number") map[r.source] = r.score;
  }
  return {
    imdb:             map["imdb"]             ?? null,
    tomatoes:         map["tomatoes"]         ?? null,
    tomatoesAudience: map["tomatoesaudience"] ?? null,
    metacritic:       map["metacritic"]       ?? null,
    metacriticUser:   map["metacriticuser"]   ?? null,
    letterboxd:       map["letterboxd"]       ?? null,
    trakt:            map["trakt"]            ?? null,
    tmdb:             map["tmdb"]             ?? null,
  };
}

export async function GET(req: NextRequest, props: { params: Promise<{ imdbId: string }> }) {
  const params = await props.params;
  const ip = getClientIp(req);
  if (!mdblistRateLimit(ip)) {
    return NextResponse.json({ ratings: null }, { status: 429 });
  }
  const { imdbId } = params;
  if (!IMDB_RE.test(imdbId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  if (!process.env.MDBLIST_API_KEY) {
    return NextResponse.json({ ratings: null });
  }
  try {
    // Une semaine, sur disque. Gardées un jour en mémoire seulement, ces notes étaient perdues à
    // chaque déploiement — plusieurs par jour — et chaque fiche rouverte coûtait une requête d'un
    // quota limité à mille (23/09/2026). Une note Rotten Tomatoes ne bouge pas en une semaine.
    const ratings = await withPersistentCache(`mdblist:${imdbId}`, 7 * 24 * 3600_000, () => fetchRatings(imdbId));
    return NextResponse.json({ ratings });
  } catch {
    return NextResponse.json({ ratings: null });
  }
}
