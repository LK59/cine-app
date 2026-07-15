import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const GALLERY_DIR = "/app/gallery/clara";
const THUMB_DIR = "/app/data/thumbs/clara";

// Prevent concurrent generation of the same thumbnail
const generating = new Set<string>();

async function getOrBuildThumb(filepath: string, thumbPath: string): Promise<boolean> {
  if (fs.existsSync(thumbPath)) return true;
  if (generating.has(thumbPath)) return false; // being built by another request — caller falls back to full image

  generating.add(thumbPath);
  try {
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    const sharp = require("sharp");
    const tmpPath = thumbPath + ".tmp";
    await sharp(filepath)
      .resize({ width: 400, withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toFile(tmpPath);
    fs.renameSync(tmpPath, thumbPath);
    return true;
  } catch {
    return false;
  } finally {
    generating.delete(thumbPath);
  }
}

export async function GET(req: NextRequest, props: { params: Promise<{ filename: string }> }) {
  const params = await props.params;
  const filename = path.basename(params.filename);
  if (!filename || filename !== params.filename) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const filepath = path.join(GALLERY_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const isThumb = req.nextUrl.searchParams.get("thumb") === "1";

  if (isThumb) {
    const thumbName = filename.replace(/\.[^.]+$/, ".jpg");
    const thumbPath = path.join(THUMB_DIR, thumbName);
    const ok = await getOrBuildThumb(filepath, thumbPath);
    if (ok) {
      return new NextResponse(fs.readFileSync(thumbPath), {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=604800, immutable",
        },
      });
    }
    // Fall through to full image if thumb unavailable
  }

  const ext = path.extname(filename).toLowerCase();
  const ct = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return new NextResponse(fs.readFileSync(filepath), {
    headers: {
      "Content-Type": ct,
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}
