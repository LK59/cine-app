import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const GALLERY_DIR = "/app/gallery/clara";

// In-memory thumbnail cache: filename → compressed Buffer
const thumbCache = new Map<string, Buffer>();

async function buildThumb(filepath: string, filename: string): Promise<Buffer | null> {
  const cached = thumbCache.get(filename);
  if (cached) return cached;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sharp = require("sharp") as (input: string) => {
      resize(opts: { width: number; withoutEnlargement: boolean }): { jpeg(opts: { quality: number }): { toBuffer(): Promise<Buffer> } };
    };
    const buf = await sharp(filepath)
      .resize({ width: 400, withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();
    thumbCache.set(filename, buf);
    return buf;
  } catch {
    return null;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: { filename: string } },
) {
  // Sanitize: use basename to strip any path traversal attempts
  const filename = path.basename(params.filename);
  if (!filename || filename !== params.filename) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const filepath = path.join(GALLERY_DIR, filename);
  if (!fs.existsSync(filepath)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const ext = path.extname(filename).toLowerCase();
  const isThumb = req.nextUrl.searchParams.get("thumb") === "1";

  if (isThumb) {
    const buf = await buildThumb(filepath, filename);
    if (buf) {
      return new NextResponse(buf, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=604800, immutable",
        },
      });
    }
    // Fallback to full image if sharp fails
  }

  // Streaming full-quality image
  const stat = fs.statSync(filepath);
  const ct = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const buf = fs.readFileSync(filepath);
  return new NextResponse(buf, {
    headers: {
      "Content-Type": ct,
      "Content-Length": String(stat.size),
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}
