import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { configuredServices } from "@/lib/services";
import { passageTarget } from "@/lib/passage/target";

/**
 * Ce que l'interface a besoin de savoir avant d'afficher quoi que ce soit.
 *
 * `configured` ne porte que des booléens : jamais une adresse, jamais une clé. Il dit ce qui est
 * branché, pour que l'interface cesse de proposer des pages qui ne peuvent que rater — un service
 * absent est une configuration, pas une panne, et les deux ne se disent pas de la même façon.
 */
export async function GET(req: NextRequest) {
  // Ce qui est branché ne regarde que les personnes connectées : sans session, la liste disait à
  // n'importe qui qu'un client BitTorrent et Jackett tournaient derrière (audit du 26/09/2026).
  // L'interface tient une absence pour « branché » (`useConfiguredServices`), et l'écran de
  // connexion n'en a pas besoin.
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  return NextResponse.json({
    defaultLang: config.app.language,
    playerEnabled: config.player.enabled,
    // Whether there is a server-side player to hand a difficult file to. The interface needs it
    // before it mounts a player at all — which of the two it mounts depends on it — and before it
    // offers the account option that selects it.
    playerServerFallback: config.player.serverFallback,
    // Le téléchargement hors ligne (bêta) : le bouton des fiches et le gestionnaire n'existent qu'avec lui.
    // Et pour ce compte-ci : administrateurs seulement tant que l'installation ne l'a pas ouvert à tous.
    offlineDownloads: config.player.offlineDownloads && (config.player.offlineDownloadsForEveryone || session?.role === "admin"),
    // L'option « Livres » (DECISIONS.md §127) : l'entrée de l'accueil n'existe qu'avec elle. Pour tout
    // compte du foyer ; jamais pour un lien de partage, qui ne sort pas de son titre (§112).
    booksEnabled: config.books?.enabled === true && session?.role !== "share",
    // La disposition de l'accueil, réglée par l'exploitant (DECISIONS.md §52).
    homeContinueHero: config.home.continueHero,
    // La nouvelle adresse du passage (DECISIONS.md §119), nom d'hôte seul : la page de connexion y
    // propose le code de passage. Publique comme la page Nouveautés qui l'annonce à tous les comptes.
    passageHost: passageTarget(config.news?.laternaAddress)?.host ?? null,
    ...(session ? { configured: configuredServices(config) } : {}),
  });
}
