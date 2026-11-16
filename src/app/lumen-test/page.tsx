import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { LumenTest } from "@/components/lumenTest/LumenTest";

/**
 * La page de banc de Lumen serveur (étape 3b, 16/11/2026) — `LumenTest.tsx` dit pourquoi elle existe.
 * Administrateur seul, comme les routes `/api/lumen/…` qu'elle lit (le proxy et chaque route le
 * revérifient de leur côté) ; ouverte depuis le panneau Compte, groupe administrateur, en navigation
 * simple pour rester dans l'application posée sur l'écran d'accueil.
 */
export const metadata: Metadata = { title: "Banc Lumen serveur", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function LumenTestPage() {
  const session = await verifySessionFull((await cookies()).get(SESSION_COOKIE)?.value).catch(() => null);
  if (!session || session.role !== "admin") redirect("/");
  return <LumenTest />;
}
