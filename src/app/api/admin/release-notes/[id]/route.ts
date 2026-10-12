import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { newsDb } from "@/lib/news/store";
import { pageBody } from "@/lib/news/admin";

export const dynamic = "force-dynamic";

function idOf(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Modifier une page — brouillon ou publiée : corriger ne republie rien et ne réarme personne. */
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const id = idOf((await params).id);
  if (id === null) return NextResponse.json({ error: "Page inconnue" }, { status: 404 });
  const body = pageBody(await req.json().catch(() => null));
  if (!body) return NextResponse.json({ error: "Une version et un contenu en français sont nécessaires" }, { status: 400 });
  if (!newsDb.update(id, body.version, body.content)) return NextResponse.json({ error: "Page inconnue" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

/** Supprimer une page. Publiée, elle disparaît de la fenêtre et de Compte → Nouveautés. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const id = idOf((await params).id);
  if (id === null || !newsDb.remove(id)) return NextResponse.json({ error: "Page inconnue" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
