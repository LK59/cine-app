import { tmdb, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { withPersistentCache } from "@/lib/server-cache";

// Resolves a TMDB title-treatment "logo" (a transparent wordmark image, not a poster/backdrop)
// for the home hero — falls back to plain text in the hero itself when this is null (not every
// title has one uploaded to TMDB). Cached a full week: unlike a rating, a logo essentially never
// changes once uploaded, so there's no value in re-checking it often.
export async function getTitleLogo(tmdbId: number, mediaType: "movie" | "series"): Promise<string | null> {
  if (!tmdb.isEnabled()) return null;
  return withPersistentCache(`tmdb:logo:${mediaType}:${tmdbId}`, 7 * 24 * 3600_000, async () => {
    const images = mediaType === "movie" ? await tmdb.getMovieImages(tmdbId) : await tmdb.getTvImages(tmdbId);
    const logos = images.logos ?? [];
    if (logos.length === 0) return null;

    // Prefer French (this app's default locale), then English, then language-neutral
    // (iso_639_1: null — often still has legible text baked in), then just take whatever
    // exists rather than show nothing.
    const byLang = (lang: string | null) => logos.filter((l) => l.iso_639_1 === lang);
    const pool = byLang("fr").length > 0 ? byLang("fr") : byLang("en").length > 0 ? byLang("en") : byLang(null).length > 0 ? byLang(null) : logos;
    const best = [...pool].sort((a, b) => b.vote_average - a.vote_average)[0];
    return best ? `${TMDB_IMAGE_BASE}/w500${best.file_path}` : null;
  }).catch(() => null);
}
