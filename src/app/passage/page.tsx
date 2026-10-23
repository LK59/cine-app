import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { PassageEntry } from "@/components/passage/PassageEntry";
import { APP_NAME } from "@/lib/appBuild";

/**
 * L'arrivée du passage sur la nouvelle adresse — `/passage#t=<jeton>` (DECISIONS.md §119).
 *
 * Publique (`PUBLIC_PATHS`) : on y arrive sans session. Le jeton est dans le fragment, que ni le
 * proxy ni aucun journal ne reçoivent ; la page le lit, l'efface de l'adresse et l'échange par un
 * POST de même origine. Sans jeton valable, elle propose le code de passage ; connecté ou non, elle
 * dit comment poser l'application sur l'écran d'accueil.
 */
export const metadata: Metadata = { title: APP_NAME, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function PassagePage() {
  const session = await verifySessionFull((await cookies()).get(SESSION_COOKIE)?.value).catch(() => null);
  return <PassageEntry signedIn={!!session && session.role !== "share"} />;
}
