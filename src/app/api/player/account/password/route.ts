import { NextRequest, NextResponse } from "next/server";
import { errorBody } from "@/lib/apiErrorCodes";
import { jellyfin } from "@/lib/clients/jellyfin";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { withErrorHandling } from "@/lib/api-helpers";
import { HttpError } from "@/lib/http";

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
    return NextResponse.json(errorBody("Compte Jellyfin requis", "jellyfin_account_required"), { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
  const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";

  if (!currentPassword || !newPassword) {
    return NextResponse.json(errorBody("Mot de passe actuel et nouveau requis", "password_required"), { status: 400 });
  }
  if (newPassword.length < MIN_LENGTH) {
    return NextResponse.json(errorBody(`Le mot de passe doit faire au moins ${MIN_LENGTH} caractères`, "password_too_short"), { status: 400 });
  }
  if (newPassword === currentPassword) {
    return NextResponse.json(errorBody("Le nouveau mot de passe est identique à l'actuel", "same_password"), { status: 400 });
  }

  return withErrorHandling(async () => {
    await jellyfin.changePassword(session.jfId!, session.jfToken!, currentPassword, newPassword).catch((err: unknown) => {
      // Jellyfin répond 403 à un mot de passe actuel faux (401 : le jeton lui-même est refusé, ce
      // qui n'est pas la même chose). Le message reste le sien pour le journal ; l'écran dit le code.
      if (err instanceof HttpError && err.status === 403) err.code = "wrong_password";
      throw err;
    });
    return { ok: true };
  }, "player-password");
}
