import { NextRequest, NextResponse } from "next/server";
import { jellyfin } from "@/lib/clients/jellyfin";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { withErrorHandling } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const MIN_LENGTH = 8;

/**
 * Changer son mot de passe.
 *
 * L'identité vit chez Jellyfin — la connexion de cette application s'y adosse — donc le
 * changement s'y fait aussi, avec le jeton de la personne et son mot de passe actuel. Rien n'est
 * stocké ici, et la clé d'administration n'est pas utilisée : une session volée ne doit pas
 * suffire à prendre un compte.
 */
export async function POST(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.jfId || !session.jfToken) {
    return NextResponse.json({ error: "Compte Jellyfin requis" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: "Mot de passe actuel et nouveau requis" }, { status: 400 });
  }
  if (newPassword.length < MIN_LENGTH) {
    return NextResponse.json({ error: `Le mot de passe doit faire au moins ${MIN_LENGTH} caractères` }, { status: 400 });
  }
  if (newPassword === currentPassword) {
    return NextResponse.json({ error: "Le nouveau mot de passe est identique à l'actuel" }, { status: 400 });
  }

  return withErrorHandling(async () => {
    await jellyfin.changePassword(session.jfId!, session.jfToken!, currentPassword, newPassword);
    return { ok: true };
  }, "player-password");
}
