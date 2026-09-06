import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { configuredServices } from "@/lib/services";

/**
 * Ce que l'interface a besoin de savoir avant d'afficher quoi que ce soit.
 *
 * `configured` ne porte que des booléens : jamais une adresse, jamais une clé. Il dit ce qui est
 * branché, pour que l'interface cesse de proposer des pages qui ne peuvent que rater — un service
 * absent est une configuration, pas une panne, et les deux ne se disent pas de la même façon.
 */
export async function GET() {
  return NextResponse.json({
    defaultLang: config.app.language,
    playerEnabled: config.player.enabled,
    configured: configuredServices(config),
  });
}
