import { NextRequest, NextResponse } from "next/server";
import { createTmdbClient, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { getTmdbLocale } from "@/lib/i18n";
import { withCache, TTL } from "@/lib/server-cache";

export interface EnrichedPersonData {
  photos: string[];          // TMDb profile image URLs (w342)
  instagram: string | null;  // full URL or null
  imdb: string | null;       // full URL or null
  wikipedia: string | null;  // full URL or null
  wikiBio: string | null;    // Wikipedia extract in FR (or EN fallback)
}

async function fetchWikipediaBio(name: string, wikidataId: string | null): Promise<{ bio: string | null; url: string | null }> {
  // Try French Wikipedia first using the person's name directly
  const tryLang = async (lang: string, title: string) => {
    try {
      const res = await fetch(
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
        { signal: AbortSignal.timeout(4000) }
      );
      if (!res.ok) return null;
      const data = await res.json() as { extract?: string; content_urls?: { desktop?: { page?: string } }; type?: string };
      if (data.type === "disambiguation" || !data.extract) return null;
      return { bio: data.extract, url: data.content_urls?.desktop?.page ?? null };
    } catch { return null; }
  };

  // If we have a Wikidata ID, resolve it to a Wikipedia page title (more precise)
  if (wikidataId) {
    try {
      const wdRes = await fetch(
        `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${wikidataId}&format=json&props=sitelinks&origin=*`,
        { signal: AbortSignal.timeout(3000) }
      );
      if (wdRes.ok) {
        const wdData = await wdRes.json() as { entities?: Record<string, { sitelinks?: Record<string, { title: string }> }> };
        const entity = wdData.entities?.[wikidataId];
        const frTitle = entity?.sitelinks?.frwiki?.title;
        const enTitle = entity?.sitelinks?.enwiki?.title;
        if (frTitle) {
          const result = await tryLang("fr", frTitle);
          if (result) return result;
        }
        if (enTitle) {
          const result = await tryLang("en", enTitle);
          if (result) return result;
        }
      }
    } catch { /* fall through */ }
  }

  // Fallback: search by name
  const frResult = await tryLang("fr", name);
  if (frResult) return frResult;
  return await tryLang("en", name) ?? { bio: null, url: null };
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const tmdb = createTmdbClient(getTmdbLocale(req.cookies.get("cine-lang")?.value));
  const personId = Number(params.id);
  if (!personId || !tmdb.isEnabled()) {
    return NextResponse.json<EnrichedPersonData>({ photos: [], instagram: null, imdb: null, wikipedia: null, wikiBio: null });
  }

  const cacheKey = `enriched:person:${personId}`;
  const data = await withCache<EnrichedPersonData>(cacheKey, TTL.VERY_LONG, async () => {
    const [imagesData, externalIds, personDetails] = await Promise.all([
      tmdb.getPersonImages(personId).catch(() => null),
      tmdb.getPersonExternalIds(personId).catch(() => null),
      tmdb.getPersonDetails(personId).catch(() => null),
    ]);

    const photos = (imagesData?.profiles ?? [])
      .sort((a, b) => b.vote_average - a.vote_average)
      .slice(0, 12)
      .map((p) => `${TMDB_IMAGE_BASE}/w342${p.file_path}`);

    const instagram = externalIds?.instagram_id
      ? `https://www.instagram.com/${externalIds.instagram_id}/`
      : null;
    const imdb = externalIds?.imdb_id
      ? `https://www.imdb.com/name/${externalIds.imdb_id}`
      : null;

    const { bio: wikiBio, url: wikipedia } = await fetchWikipediaBio(
      personDetails?.name ?? "",
      externalIds?.wikidata_id ?? null
    );

    return { photos, instagram, imdb, wikipedia, wikiBio };
  });

  return NextResponse.json(data);
}
