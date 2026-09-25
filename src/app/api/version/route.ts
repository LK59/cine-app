import { NextResponse } from "next/server";
import { APP_BUILD } from "@/lib/appBuild";

export const dynamic = "force-dynamic";

/**
 * Le build que le serveur sert. Un onglet le compare au sien pour savoir s'il est périmé — voir
 * `staleBuild.ts`. Jamais mis en cache : c'est précisément la réponse qui change à un déploiement.
 */
export function GET() {
  return NextResponse.json({ build: APP_BUILD }, { headers: { "Cache-Control": "no-store" } });
}
