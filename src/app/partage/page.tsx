import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { ShareRedeemForm } from "@/components/shareGuest/ShareRedeemForm";
import { APP_NAME } from "@/lib/appBuild";

/**
 * « J'ai un code de partage » (DECISIONS.md §112) : le code et le mot de passe d'un lien, tapés à la
 * main — le bouton discret de la page de connexion mène ici. Publique (`PUBLIC_PATHS`).
 *
 * Hors du groupe `(player)`, dont la coquille exige une session et lance le catalogue avec le HTML.
 */
export const metadata: Metadata = { title: APP_NAME, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function ShareEntryPage() {
  const session = await verifySessionFull((await cookies()).get(SESSION_COOKIE)?.value).catch(() => null);
  return <ShareRedeemForm code={null} household={!!session && session.role !== "share"} />;
}
