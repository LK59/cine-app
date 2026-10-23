import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { addressChange } from "@/lib/activity/addressChange";
import { jellyfin, type JellyfinUser } from "@/lib/clients/jellyfin";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

/**
 * Le changement d'adresse, compte par compte (DECISIONS.md §119) : l'administrateur seul — la vue
 * dit qui ouvre l'application, quand, et sur quel genre d'appareil. Sans nouvelle adresse annoncée,
 * `newHost: null` et rien d'autre : la vue ne s'affiche pas, aucun journal n'est lu.
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const raw = config.news.laternaAddress;
  if (!raw) return NextResponse.json(addressChange([], raw));
  // Les comptes du foyer (`getUsers` écarte ceux des liens de partage, §112) ; un compte désactivé
  // n'ouvrira plus rien — il resterait « jamais ouvert » pour toujours en haut de la liste.
  const users = await jellyfin.getUsers().catch(() => [] as JellyfinUser[]);
  const names = users.filter((u) => u.Policy?.IsDisabled !== true).map((u) => u.Name);
  return NextResponse.json(addressChange(names, raw));
}
