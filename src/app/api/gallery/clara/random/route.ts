import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const GALLERY_DIR = "/app/gallery/clara";
const EXCLUDE = new Set(["clarabanner.jpg", "favicon.jpeg"]);
const BASE = "https://cine.kakol.fr/api/gallery/clara/";

export const dynamic = "force-dynamic";

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function GET() {
  const raw = fs.readdirSync(GALLERY_DIR).filter((f) => !EXCLUDE.has(f));
  if (!raw.length) return new NextResponse("No photos", { status: 404 });

  const files = shuffle(raw);
  const urls = JSON.stringify(files.map((f) => BASE + encodeURIComponent(f)));
  const first = BASE + encodeURIComponent(files[0]);
  const second = files.length > 1 ? BASE + encodeURIComponent(files[1]) : first;

  const html = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clara Galle</title>
<link rel="icon" href="${BASE}favicon.jpeg">
<meta property="og:title" content="Clara Galle">
<meta property="og:description" content="Une photo au hasard parmi la galerie Clara Galle — cliquez pour en voir une autre.">
<meta property="og:image" content="${BASE}clarabanner.jpg">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Clara Galle">
<meta name="twitter:image" content="${BASE}clarabanner.jpg">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
  #wrap { position: relative; width: 100%; height: 100%; cursor: pointer; }
  .photo {
    position: absolute; inset: 0;
    width: 100%; height: 100%;
    object-fit: contain;
    transition: opacity 0.45s ease;
  }
</style>
</head>
<body>
<div id="wrap">
  <img class="photo" id="a" src="${first}" style="opacity:1">
  <img class="photo" id="b" src="${second}" style="opacity:0">
</div>
<script>
  const urls = ${urls};
  let idx = 0;
  let front = document.getElementById('a');
  let back  = document.getElementById('b');
  let busy  = false;

  function doSwap() {
    busy = true;
    front.style.opacity = '0';
    back.style.opacity  = '1';
    const tmp = front; front = back; back = tmp;

    setTimeout(() => {
      idx = (idx + 1) % urls.length;
      const preload = (idx + 1) % urls.length;
      back.src = urls[preload];
      back.style.opacity = '0';
      busy = false;
    }, 460);
  }

  document.getElementById('wrap').addEventListener('click', () => {
    if (busy) return;
    if (back.complete && back.naturalWidth) {
      doSwap();
    } else {
      back.onload = () => { back.onload = null; doSwap(); };
    }
  });
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
