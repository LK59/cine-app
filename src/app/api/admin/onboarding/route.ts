import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { onboardingDb } from "@/lib/db";
import { jellyfin } from "@/lib/clients/jellyfin";
import { config } from "@/lib/config";

/**
 * L'écran d'accueil, vu de la gestion : qui l'a à faire, et le reproposer.
 *
 * La liste des comptes est celle de Jellyfin — plus le compte local — et non celle de la table,
 * qui ne connaît que ceux à qui on l'a déjà proposé. Administrateur seulement : la lecture
 * donne la liste des comptes, et `proxy.ts` ne filtre que les écritures.
 */
async function requireAdmin(req: NextRequest) {
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  return session?.role === "admin" ? session : null;
}

async function accountNames(): Promise<string[]> {
  const users = await jellyfin.getUsers().catch(() => [] as { Name: string }[]);
  return [...new Set([...users.map((u) => u.Name), config.app.adminUser])].sort((a, b) => a.localeCompare(b));
}

export async function GET(req: NextRequest) {
  if (!(await requireAdmin(req))) return NextResponse.json({ error: "Réservé à l'administrateur" }, { status: 403 });
  const flags = onboardingDb.all();
  const accounts = (await accountNames()).map((name) => ({ name, pending: flags.get(name) === true }));
  return NextResponse.json({ accounts });
}

export async function PUT(req: NextRequest) {
  if (!(await requireAdmin(req))) return NextResponse.json({ error: "Réservé à l'administrateur" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { user?: unknown; all?: unknown; pending?: unknown } | null;
  if (!body || typeof body.pending !== "boolean") return NextResponse.json({ error: "Requête invalide" }, { status: 400 });
  const names = await accountNames();
  if (body.all === true) {
    for (const name of names) onboardingDb.setPending(name, body.pending);
  } else if (typeof body.user === "string" && names.includes(body.user)) {
    onboardingDb.setPending(body.user, body.pending);
  } else {
    return NextResponse.json({ error: "Compte inconnu" }, { status: 400 });
  }
  const flags = onboardingDb.all();
  return NextResponse.json({ accounts: names.map((name) => ({ name, pending: flags.get(name) === true })) });
}
