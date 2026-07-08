import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const GALLERY_DIR = "/app/gallery/clara";
const EXCLUDE = new Set(["clarabanner.jpg"]);

export const dynamic = "force-dynamic";

export async function GET() {
  const files = fs.readdirSync(GALLERY_DIR).filter((f) => !EXCLUDE.has(f));
  if (!files.length) return new NextResponse("No photos", { status: 404 });

  const file = files[Math.floor(Math.random() * files.length)];
  const filepath = path.join(GALLERY_DIR, file);
  const ext = path.extname(file).toLowerCase();
  const ct = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";

  return new NextResponse(fs.readFileSync(filepath), {
    headers: {
      "Content-Type": ct,
      "Cache-Control": "no-store",
    },
  });
}
