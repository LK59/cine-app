import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { PipTest } from "@/components/pipTest/PipTest";

/**
 * La page de test « image dans l'image » (16/11/2026) — `PipTest.tsx` dit pourquoi elle existe.
 * Administrateur seul ; ouverte depuis le panneau Compte (groupe administrateur), en navigation simple
 * pour rester dans l'application posée sur l'écran d'accueil.
 */
export const metadata: Metadata = { title: "Picture in Picture test", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function PipTestPage() {
  const session = await verifySessionFull((await cookies()).get(SESSION_COOKIE)?.value).catch(() => null);
  if (!session || session.role !== "admin") redirect("/");
  return <PipTest />;
}
