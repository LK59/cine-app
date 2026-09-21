import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import fs from "fs";

export const dynamic = "force-dynamic";

export async function GET() {
  // Option fermée : rien à lister, et rien qui dise qu'il y aurait quelque chose.
  if (!config.gallery.clara) return NextResponse.json({ files: [] }, { status: 404 });
  const dir = "/app/gallery/clara";
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f))
      .sort();
    return NextResponse.json({ files });
  } catch {
    return NextResponse.json({ files: [] });
  }
}
