import { NextRequest, NextResponse } from "next/server";
import { loginBackground, loginBackgroundBytes } from "@/lib/loginBackground";
import { lengthHeader } from "@/lib/responseFraming";

export const dynamic = "force-dynamic";

/**
 * L'image de fond des écrans de connexion (DECISIONS §199), **sans session** (`PUBLIC_PATHS`) : la page de
 * connexion la montre avant que quiconque soit connecté. Une seule image, choisie par l'administrateur —
 * rien d'autre n'est servi d'ici.
 *
 * Sans image, `204` et non `404` : une absence attendue n'est jamais un 404 (CrowdSec, 29/10/2026). Avec
 * `?v=` égal à la version en place, la réponse est immuable — une nouvelle image change d'adresse.
 */
export async function GET(req: NextRequest) {
  const meta = loginBackground();
  const bytes = meta ? loginBackgroundBytes() : null;
  if (!meta || !bytes) return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  const etag = `"${meta.v}"`;
  const pinned = req.nextUrl.searchParams.get("v") === meta.v;
  const headers: Record<string, string> = {
    "Content-Type": "image/webp",
    ETag: etag,
    "Cache-Control": pinned ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
    "X-Content-Type-Options": "nosniff",
  };
  if (req.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });
  return new NextResponse(new Uint8Array(bytes), { status: 200, headers: { ...headers, ...lengthHeader(bytes.byteLength) } });
}
