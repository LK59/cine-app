import { NextResponse } from "next/server";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";

export const dynamic = "force-dynamic";

function langCategory(audioLangs: string): "vf" | "vfvo" | "vo" | "other" {
  if (!audioLangs) return "other";
  const hasFre = audioLangs.includes("fre");
  const hasEng = audioLangs.includes("eng");
  if (hasFre && hasEng) return "vfvo";
  if (hasFre) return "vf";
  if (hasEng) return "vo";
  return "other";
}

function codecCategory(codec: string): "hevc" | "h264" | "other" {
  const c = codec.toLowerCase();
  if (c.includes("265") || c === "hevc") return "hevc";
  if (c.includes("264")) return "h264";
  return "other";
}

export interface LibraryStats {
  movies: { total: number; withFile: number };
  series: { total: number; totalEpisodes: number; episodesWithFile: number };
  quality: Record<string, number>;
  languages: { vf: number; vfvo: number; vo: number; other: number };
  codecs: { hevc: number; h264: number; other: number };
  hdr: number;
  monthlyMovies: Record<string, number>;
  monthlySeries: Record<string, number>;
  genres: Record<string, number>;
  decades: Record<string, number>;
}

export async function GET() {
  const [movies, series] = await Promise.all([
    cachedMovies().catch(() => []),
    cachedSeries().catch(() => []),
  ]);

  const quality: Record<string, number> = {};
  const monthlyMovies: Record<string, number> = {};
  const languages = { vf: 0, vfvo: 0, vo: 0, other: 0 };
  const codecs = { hevc: 0, h264: 0, other: 0 };
  let hdr = 0;
  let moviesWithFile = 0;

  for (const m of movies) {
    if (m.hasFile) moviesWithFile++;
    const mf = m.movieFile;
    const mi = mf?.mediaInfo;
    const q = mf?.quality?.quality?.name;
    if (q) quality[q] = (quality[q] ?? 0) + 1;
    if (mi) {
      const cat = langCategory(mi.audioLanguages ?? "");
      languages[cat]++;
      const cc = codecCategory(mi.videoCodec ?? "");
      codecs[cc]++;
      if (mi.videoHdr || (mi.videoDynamicRange ?? "").toLowerCase().includes("hdr")) hdr++;
    }
    if (m.added && m.added > "2000") {
      const key = m.added.slice(0, 7);
      monthlyMovies[key] = (monthlyMovies[key] ?? 0) + 1;
    }
  }

  const monthlySeries: Record<string, number> = {};
  let totalEpisodes = 0;
  let episodesWithFile = 0;

  for (const s of series) {
    totalEpisodes += s.statistics?.episodeCount ?? 0;
    episodesWithFile += s.statistics?.episodeFileCount ?? 0;
    if (s.added && s.added > "2000") {
      const key = s.added.slice(0, 7);
      monthlySeries[key] = (monthlySeries[key] ?? 0) + 1;
    }
  }

  const genres: Record<string, number> = {};
  for (const m of movies) {
    for (const g of m.genres ?? []) genres[g] = (genres[g] ?? 0) + 1;
  }
  for (const s of series) {
    for (const g of s.genres ?? []) genres[g] = (genres[g] ?? 0) + 1;
  }

  const decades: Record<string, number> = {};
  for (const m of movies) {
    if (m.year && m.year > 1900) {
      const decade = `${Math.floor(m.year / 10) * 10}s`;
      decades[decade] = (decades[decade] ?? 0) + 1;
    }
  }
  for (const s of series) {
    if (s.year && s.year > 1900) {
      const decade = `${Math.floor(s.year / 10) * 10}s`;
      decades[decade] = (decades[decade] ?? 0) + 1;
    }
  }

  const stats: LibraryStats = {
    movies: { total: movies.length, withFile: moviesWithFile },
    series: { total: series.length, totalEpisodes, episodesWithFile },
    quality,
    languages,
    codecs,
    hdr,
    monthlyMovies,
    monthlySeries,
    genres,
    decades,
  };

  return NextResponse.json(stats);
}
