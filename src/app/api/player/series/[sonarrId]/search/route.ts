import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { sonarr } from "@/lib/clients/sonarr";
import { invalidateKey } from "@/lib/server-cache";
import { withErrorHandling } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

/**
 * Demander un épisode ou une saison qui manque.
 *
 * Ce n'est pas une demande Jellyseerr : la série est déjà dans la bibliothèque, il n'y a rien à
 * ajouter — il manque des fichiers. Le geste juste est donc la recherche automatique de Sonarr,
 * exactement celle que déclenche la loupe de sa propre interface, sur l'épisode ou la saison
 * désignés.
 *
 * C'est la seule écriture vers Sonarr qu'un compte non administrateur peut déclencher (voir la
 * liste blanche de `proxy.ts`), et elle est volontairement étroite : elle ne sait que chercher.
 * Elle n'ajoute rien, ne supprime rien, ne change aucun réglage — au pire, elle fait travailler
 * les indexeurs pour rien.
 *
 * L'épisode est mis sous surveillance au passage : Sonarr ne récupère pas ce qu'il ne surveille
 * pas, et une demande qui ne rapporte rien est pire qu'un bouton absent.
 */
export async function POST(req: NextRequest, props: { params: Promise<{ sonarrId: string }> }) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  const seriesId = Number.parseInt((await props.params).sonarrId, 10);
  if (!Number.isFinite(seriesId) || seriesId <= 0) {
    return NextResponse.json({ error: "Série introuvable" }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const episodeId = Number(body?.episodeId);
  const seasonNumber = Number(body?.seasonNumber);
  const wantsEpisode = Number.isFinite(episodeId) && episodeId > 0;
  const wantsSeason = Number.isFinite(seasonNumber) && seasonNumber > 0;

  if (!wantsEpisode && !wantsSeason) {
    return NextResponse.json({ error: "Indique un épisode ou une saison" }, { status: 400 });
  }

  return withErrorHandling(async () => {
    const episodes = await sonarr.getEpisodes(seriesId);
    // La cible, telle que Sonarr la connaît : c'est elle qui dit ce qui est diffusé et ce qui
    // manque, pas ce que le client a bien voulu envoyer.
    // Uniquement ce qui manque, dans les deux cas : cette route sert à combler des trous, pas à
    // relancer une recherche sur un épisode qu'on possède déjà.
    const targets = episodes.filter(
      (e) => !e.hasFile && (wantsEpisode ? e.id === episodeId : e.seasonNumber === seasonNumber)
    );
    if (targets.length === 0) {
      return { ok: true, searched: 0 };
    }

    const now = Date.now();
    const airable = targets.filter((e) => {
      const date = e.airDateUtc || e.airDate;
      if (!date) return false;
      const time = Date.parse(date);
      return Number.isNaN(time) || time <= now;
    });
    if (airable.length === 0) {
      return { ok: true, searched: 0 };
    }

    await Promise.all(
      airable
        .filter((e) => !e.monitored)
        .map((e) => sonarr.updateEpisode(e.id, { ...e, monitored: true }).catch(() => null))
    );

    // Une commande pour la saison entière quand c'est une saison : Sonarr y applique ses propres
    // règles de lot (une version complète plutôt que douze fichiers séparés).
    if (wantsSeason) await sonarr.triggerSearch(seriesId, seasonNumber);
    else await sonarr.triggerEpisodeSearch(airable.map((e) => e.id));

    // La surveillance vient de changer : la prochaine lecture de la liste doit la voir.
    invalidateKey(`sonarr:episodes:${seriesId}`);
    return { ok: true, searched: airable.length };
  }, "player-series-search");
}
