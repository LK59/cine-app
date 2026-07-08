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
  const src = `https://cine.kakol.fr/api/gallery/clara/${encodeURIComponent(file)}`;

  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clara Galle</title>
<link rel="icon" href="https://cine.kakol.fr/api/gallery/clara/favicon.jpeg">
<meta property="og:title" content="Clara Galle">
<meta property="og:description" content="Une photo au hasard parmi la galerie Clara Galle — actualisez pour en voir une autre.">
<meta property="og:image" content="https://cine.kakol.fr/api/gallery/clara/clarabanner.jpg">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Clara Galle">
<meta name="twitter:image" content="https://cine.kakol.fr/api/gallery/clara/clarabanner.jpg">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; background: #000; }
  img { display: block; width: 100%; height: 100%; object-fit: contain; cursor: pointer; }
</style>
</head>
<body>
<img src="${src}" onclick="location.reload()" title="Cliquer pour une autre photo" />
</body>
</html>`;

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
