import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { config } from "@/lib/config";
import { configuredServices } from "@/lib/services";

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
    // L'option galerie : lue au démarrage du serveur, et non plus figée dans l'image.
    claraGallery: config.gallery.clara,
    ...(session ? { configured: configuredServices(config) } : {}),
  });
}
