import { NextRequest, NextResponse } from "next/server";
import { createTmdbClient, TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { getTmdbLocale, LOCALES } from "@/lib/i18n";
import { withPersistentCache } from "@/lib/server-cache";

export interface EnrichedPersonData {
  photos: string[];          // TMDb profile image URLs (w342)
  instagram: string | null;  // full URL or null
  imdb: string | null;       // full URL or null
  wikipedia: string | null;  // full URL or null
  wikiBio: string | null;    // Wikipedia extract in FR (or EN fallback)
}

function wikiLangOrder(locale: string): string[] {
  if (locale.startsWith("es")) return ["es", "en", "fr"];
  if (locale.startsWith("en")) return ["en", "fr"];
  if (locale.startsWith("de")) return ["de", "en", "fr"];
  return ["fr", "en"];
}

async function fetchWikipediaBio(
  name: string,
  wikidataId: string | null,
  locale: string,
  outcome: { failed: boolean } = { failed: false }
): Promise<{ bio: string | null; url: string | null }> {
  const langOrder = wikiLangOrder(locale);

  const tryLang = async (lang: string, title: string) => {
    try {
      const res = await fetch(
        `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
        { signal: AbortSignal.timeout(4000) }
      );
      // Une page absente (404) est une réponse ; une erreur de serveur ou une coupure n'en est pas
      // une, et ne doit pas finir gardée une semaine comme « pas de biographie ».
      if (!res.ok) {
        if (res.status >= 500 || res.status === 429) outcome.failed = true;
        return null;
      }
      const data = await res.json() as { extract?: string; content_urls?: { desktop?: { page?: string } }; type?: string };
      if (data.type === "disambiguation" || !data.extract) return null;
      return { bio: data.extract, url: data.content_urls?.desktop?.page ?? null };
    } catch { outcome.failed = true; return null; }
  };

  // If we have a Wikidata ID, resolve titles for all target languages at once
  if (wikidataId) {
    try {
      const wdRes = await fetch(
        `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${wikidataId}&format=json&props=sitelinks&origin=*`,
        { signal: AbortSignal.timeout(3000) }
      );
      if (wdRes.ok) {
        const wdData = await wdRes.json() as { entities?: Record<string, { sitelinks?: Record<string, { title: string }> }> };
        const sitelinks = wdData.entities?.[wikidataId]?.sitelinks ?? {};
        for (const lang of langOrder) {
          const title = sitelinks[`${lang}wiki`]?.title;
          if (title) {
            const result = await tryLang(lang, title);
            if (result) return result;
          }
        }
      }
    } catch { /* fall through */ }
  }

  // Fallback: search by name in locale order
  for (const lang of langOrder) {
    const result = await tryLang(lang, name);
    if (result) return result;
  }
  return { bio: null, url: null };
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  // Une langue connue ou le français : la valeur du cookie entre dans la clé de cache, et une
  // valeur libre permettait de fabriquer autant d'entrées — et d'appels à TMDB — qu'on voulait.
  const cookieLang = req.cookies.get("cine-lang")?.value ?? "fr";
  const rawLang = (LOCALES as string[]).includes(cookieLang) ? cookieLang : "fr";
  const tmdb = createTmdbClient(getTmdbLocale(rawLang));
  const personId = Number(params.id);
  if (!personId || !tmdb.isEnabled()) {
    return NextResponse.json<EnrichedPersonData>({ photos: [], instagram: null, imdb: null, wikipedia: null, wikiBio: null });
  }

  const cacheKey = `enriched:person:${personId}:${rawLang}`;
  // Une semaine, sur disque (dix minutes en mémoire avant le 23/09/2026 : perdues à chaque
  // déploiement). Le moindre échec — une des trois réponses de TMDB, ou Wikipédia injoignable —
  // n'est pas gardé : une réponse partielle l'aurait été une semaine, une fiche sans photos ou
  // sans biographie parce qu'un appel avait échoué ce jour-là.
  const data = await withPersistentCache<EnrichedPersonData>(cacheKey, 7 * 24 * 3600_000, async () => {
    const [imagesData, externalIds, personDetails] = await Promise.all([
      tmdb.getPersonImages(personId),
      tmdb.getPersonExternalIds(personId),
      tmdb.getPersonDetails(personId),
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

    const wiki = { failed: false };
    const { bio: wikiBio, url: wikipedia } = await fetchWikipediaBio(
      personDetails?.name ?? "",
      externalIds?.wikidata_id ?? null,
      rawLang,
      wiki
    );
    if (!wikiBio && wiki.failed) throw new Error("Wikipédia injoignable");

    return { photos, instagram, imdb, wikipedia, wikiBio };
  }).catch((): EnrichedPersonData => ({ photos: [], instagram: null, imdb: null, wikipedia: null, wikiBio: null }));

  return NextResponse.json(data);
}
