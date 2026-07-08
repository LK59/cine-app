import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const GALLERY_DIR = "/app/gallery/clara";
const EXCLUDE = new Set(["clarabanner.jpg"]);

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const files = fs.readdirSync(GALLERY_DIR).filter((f) => !EXCLUDE.has(f));
  if (!files.length) return new NextResponse("No photos", { status: 404 });

  const file = files[Math.floor(Math.random() * files.length)];
  const base = new URL(req.url);
  base.pathname = `/api/gallery/clara/${encodeURIComponent(file)}`;
  base.search = "";

  return NextResponse.redirect(base, { status: 302 });
}
