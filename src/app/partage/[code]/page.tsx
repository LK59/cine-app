import type { Metadata } from "next";
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { isShareCode, sharesDb } from "@/lib/share/store";
import { ShareRedeemForm } from "@/components/shareGuest/ShareRedeemForm";
import { ShareTitleView } from "@/components/shareGuest/ShareTitleView";

/**
 * La page d'un lien de partage (DECISIONS.md §112) — `/partage/<code>`.
 *
 * Publique (`PUBLIC_PATHS`) : sans session de ce lien, elle demande le mot de passe, et ne dit rien
 * du titre — ni nom, ni affiche, ni même si le code existe : la même phrase neutre pour tous. Avec la
 * session de **ce** lien, elle est la fiche du titre, et la seule page que cette session peut voir
 * (`shareGate` y ramène toute autre adresse).
 *
 * Une session de partage d'un autre lien, ou un compte du foyer, reçoit le formulaire : entrer ce code
 * remplacera sa session sur cet appareil, et le formulaire prévient un compte du foyer avant.
 */
export const metadata: Metadata = { title: "Cine App", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function SharePage({ params }: { params: Promise<{ code: string }> }) {
  const code = (await params).code.toLowerCase();
  const session = await verifySessionFull((await cookies()).get(SESSION_COOKIE)?.value).catch(() => null);
  const share = session?.role === "share" ? sharesDb.get(session.sh ?? "") : null;
  if (share && share.code === code) return <ShareTitleView />;
  return <ShareRedeemForm code={isShareCode(code) ? code : null} household={!!session && session.role !== "share"} />;
}
