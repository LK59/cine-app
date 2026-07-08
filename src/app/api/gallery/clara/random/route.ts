import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const GALLERY_DIR = "/app/gallery/clara";
const EXCLUDE = new Set(["clarabanner.jpg", "favicon.jpeg"]);

export const dynamic = "force-dynamic";

export async function GET() {
  const files = fs.readdirSync(GALLERY_DIR).filter((f) => !EXCLUDE.has(f));
  if (!files.length) return new NextResponse("No photos", { status: 404 });

  const file = files[Math.floor(Math.random() * files.length)];
  const src = `https://cine.kakol.fr/api/gallery/clara/${encodeURIComponent(file)}`;

  // Pick a different file for preload
  const nextFile = files.filter((f) => f !== file)[Math.floor(Math.random() * (files.length - 1))];
  const nextSrc = `https://cine.kakol.fr/api/gallery/clara/${encodeURIComponent(nextFile)}`;

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
  html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
  #wrap { position: relative; width: 100%; height: 100%; }
  img {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    object-fit: contain;
    cursor: pointer;
    transition: opacity 0.4s ease;
  }
  #current { opacity: 1; }
  #next { opacity: 0; pointer-events: none; }
</style>
</head>
<body>
<div id="wrap">
  <img id="current" src="${src}" />
  <img id="next" src="${nextSrc}" />
</div>
<script>
  const current = document.getElementById('current');
  const next = document.getElementById('next');
  let busy = false;

  function swap() {
    if (busy || !next.complete || !next.naturalWidth) {
      location.reload();
      return;
    }
    busy = true;
    current.style.opacity = '0';
    next.style.opacity = '1';
    next.style.pointerEvents = 'auto';
    current.style.pointerEvents = 'none';

    setTimeout(() => {
      // After fade, preload a new next image via the random endpoint
      fetch('/').then(r => r.text()).then(html => {
        const m = html.match(/id="current" src="([^"]+)"/);
        if (m) {
          const old = current;
          // shift: next becomes current, old becomes next for new image
          old.style.opacity = '0';
          old.src = m[1];
          old.style.pointerEvents = 'none';
          next.id = 'current';
          old.id = 'next';
          busy = false;
        } else {
          location.reload();
        }
      }).catch(() => location.reload());
    }, 420);
  }

  document.getElementById('wrap').addEventListener('click', swap);
</script>
</body>
</html>`;

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
