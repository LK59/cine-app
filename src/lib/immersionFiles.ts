import fs from "fs";
import path from "path";
import { Readable } from "stream";
import { NextResponse } from "next/server";
import { encodedBodyHeaders, framingAvailable, lengthHeader } from "@/lib/responseFraming";

/**
 * Les fichiers du mode « Immersion » (`immersion/` à la racine du dépôt, `immersion/PROGRESS.md`).
 *
 * C'est un projet à part, construit par sa propre étape du `Dockerfile` et posé dans l'image sous
 * `immersion-dist/`. L'application ne fait que servir ce dossier : la page par
 * `src/app/immersion/route.ts`, ses fichiers par `src/app/api/immersion/[...path]/route.ts`.
 *
 * Pourquoi des routes, et pas `public/immersion/` : le service worker recopie dans son cache tout
 * GET hors `/api/` qui n'est ni une image ni une page (`public/sw.js`, « network-first for
 * everything else »), et ce cache n'est jamais purgé — des dizaines de mégaoctets de textures y
 * seraient restés en double. Sous `/api/`, le worker ne touche à rien. Et une route passe par le
 * proxy : sans session, rien n'est servi.
 *
 * Sans le dossier (développement, tests, image construite sans cette étape), tout répond 404.
 */
export function immersionDir(): string {
  // Lu à chaque appel, comme le reste de la configuration : jamais copié dans une constante.
  return process.env.IMMERSION_DIST || path.join(process.cwd(), "immersion-dist");
}

/** Les seuls types servis : ce que le build produit. Une extension inconnue n'existe pas. */
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".ktx2": "image/ktx2",
  ".hdr": "application/octet-stream",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
};

/**
 * Le chemin du fichier demandé, ou `null` s'il sort du dossier ou n'est pas d'un type servi.
 *
 * Chaque segment est vérifié un par un plutôt que le chemin résolu seul : `..`, un segment vide, un
 * nom caché ou un séparateur glissé dans un segment (`%2F`, `\`) n'ont rien à faire ici, et les
 * refuser à la lecture évite de dépendre de ce que `path.resolve` en ferait.
 */
export function immersionFilePath(segments: readonly string[]): string | null {
  if (segments.length === 0 || segments.length > 8) return null;
  for (const segment of segments) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(segment)) return null;
  }
  if (!TYPES[path.extname(segments[segments.length - 1]).toLowerCase()]) return null;
  const root = path.resolve(immersionDir());
  const file = path.resolve(root, ...segments);
  return file.startsWith(root + path.sep) ? file : null;
}

function notFound(): NextResponse {
  return NextResponse.json({ error: "introuvable" }, { status: 404, headers: { "Cache-Control": "no-store" } });
}

/**
 * Sert un fichier du build.
 *
 * - **Cache** : `immutable` pour ce que Vite nomme par son contenu (`assets/…-<hash>.js`) et pour
 *   une adresse qui porte la version des assets (`?v=`) ; une simple revalidation (`ETag`) pour le
 *   reste ; jamais gardé pour la page elle-même (`html`), qui nomme les fichiers du build courant.
 *   `private` partout : ces réponses sont derrière une session.
 * - **Compression** : le build pose un `.br` à côté des fichiers texte. Il n'est servi que si le
 *   serveur de démarrage peut l'étiqueter (`framingAvailable`, DECISIONS.md §131) — une route n'écrit
 *   jamais `Content-Encoding` elle-même.
 */
export async function serveImmersionFile(req: Request, segments: readonly string[], opts: { html?: boolean } = {}): Promise<NextResponse> {
  const file = immersionFilePath(segments);
  if (!file) return notFound();
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    return notFound();
  }
  if (!stat.isFile()) return notFound();

  const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  const versioned = new URL(req.url).searchParams.has("v") || /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(segments[segments.length - 1]);
  const headers: Record<string, string> = {
    "Content-Type": TYPES[path.extname(file).toLowerCase()],
    "Cache-Control": opts.html ? "no-store" : versioned ? "private, max-age=31536000, immutable" : "private, max-age=0, must-revalidate",
    ETag: etag,
    Vary: "Accept-Encoding",
    "X-Content-Type-Options": "nosniff",
  };
  if (!opts.html && req.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });

  let served = file;
  let size = stat.size;
  if (framingAvailable() && /\bbr\b/.test(req.headers.get("accept-encoding") ?? "")) {
    const compressed = await fs.promises.stat(file + ".br").catch(() => null);
    if (compressed?.isFile()) {
      served = file + ".br";
      size = compressed.size;
      Object.assign(headers, encodedBodyHeaders("br", size));
    }
  }
  if (served === file) Object.assign(headers, lengthHeader(size));

  // Lu en flux, borné à la taille mesurée : `createReadStream({ end })` ne rend jamais plus, ce que
  // le serveur de démarrage vérifie contre la longueur déclarée.
  const stream = size > 0 ? fs.createReadStream(served, { start: 0, end: size - 1 }) : Readable.from([]);
  return new NextResponse(Readable.toWeb(stream) as ReadableStream<Uint8Array>, { status: 200, headers });
}
