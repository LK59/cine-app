import { NextRequest, NextResponse } from "next/server";
import { adminOnly } from "@/lib/activity/adminOnly";
import { logAdminAction } from "@/lib/logger";
import {
  LOGIN_BACKGROUND_MAX_BYTES,
  loginBackground,
  removeLoginBackground,
  saveLoginBackground,
  setLoginBackgroundDim,
} from "@/lib/loginBackground";

export const dynamic = "force-dynamic";

/**
 * Configuration → Administration → Écran de connexion (DECISIONS §199) : l'image en place, l'envoi d'une
 * nouvelle (formulaire, champ `image`), le voile (`PATCH { dim }`) et le retrait. Administrateur seulement.
 */
export async function GET(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  return NextResponse.json({ background: loginBackground() }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > LOGIN_BACKGROUND_MAX_BYTES + 64 * 1024) return NextResponse.json({ error: "tooLarge" }, { status: 413 });
  const form = await req.formData().catch(() => null);
  const file = form?.get("image");
  if (!file || typeof file === "string") return NextResponse.json({ error: "notImage" }, { status: 400 });
  const saved = await saveLoginBackground(Buffer.from(await file.arrayBuffer()), file.name);
  if (typeof saved === "string") return NextResponse.json({ error: saved }, { status: saved === "tooLarge" ? 413 : 400 });
  logAdminAction(session.jfUser ?? session.u, "login-background", { action: "set", v: saved.v, bytes: file.size });
  return NextResponse.json({ background: saved }, { headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  const body = (await req.json().catch(() => null)) as { dim?: unknown } | null;
  const updated = setLoginBackgroundDim(body?.dim);
  if (!updated) return NextResponse.json({ error: "absent" }, { status: 409 });
  return NextResponse.json({ background: updated }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: NextRequest) {
  const session = await adminOnly(req);
  if (session instanceof NextResponse) return session;
  removeLoginBackground();
  logAdminAction(session.jfUser ?? session.u, "login-background", { action: "remove" });
  return NextResponse.json({ background: null }, { headers: { "Cache-Control": "no-store" } });
}
