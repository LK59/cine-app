import fs from "node:fs/promises";
import path from "node:path";
import { cachedMovies, cachedSeries } from "@/lib/server-cache";
import { MOVIES_PATH, TV_PATH } from "@/lib/media-paths";
import { isVideoName } from "./scan";
import type { IntegrityKind } from "./store";

/**
 * Les fichiers vidéo de la bibliothèque, vus du conteneur (DECISIONS.md §93) : sous la racine des
 * films et sous celle des séries — jamais les téléchargements ni les copies en partage, qui n'y sont
 * pas. Le disque est la vérité de ce qui existe ; Radarr et Sonarr ne donnent que le nom et la page
 * où remplacer le fichier, rapprochés par le **dossier** (la règle de `containerPathOf`, §88). Sans
 * eux, ou hors d'eux, le nom du dossier.
 *
 * Écartés : les fichiers cachés (`.xxx.mkv` — les temporaires que FileFlows prendrait lui-même, et
 * tout ce qu'un outil écrit avant de renommer), les extensions de fichiers en cours (`.part`,
 * `.tmp`, `.fftemp`, `.!qB`), et tout fichier modifié il y a moins de `SETTLE_MS` : en cours
 * d'écriture, il serait relu à moitié — il le sera à la passe suivante.
 */

export const SETTLE_MS = 10 * 60_000;
const TEMP_NAME = /\.(part|partial|tmp|temp|fftemp|!qb|crdownload)$/i;
const MAX_DEPTH = 3;

export interface LibraryFile {
  path: string;
  size: number;
  mtimeMs: number;
  kind: IntegrityKind;
  title: string;
  serviceId: number | null;
}

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Un nom à relire ? Ni caché, ni temporaire, et un fichier vidéo. */
export function wantedName(name: string): boolean {
  return !name.startsWith(".") && !TEMP_NAME.test(name) && isVideoName(name);
}

/** « S02E01 » lu dans un nom de fichier d'épisode, s'il y en a un. */
function episodeTag(name: string): string | null {
  const m = /S(\d{1,3})E(\d{1,3})/i.exec(name);
  return m ? `S${m[1].padStart(2, "0")}E${m[2].padStart(2, "0")}` : null;
}

async function walk(root: string, depth: number, out: { file: string; top: string }[], top: string | null, seen: { n: number }): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (++seen.n % 200 === 0) await yieldToLoop();
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) await walk(full, depth + 1, out, top ?? entry.name, seen);
    } else if (entry.isFile() && top !== null && wantedName(entry.name)) {
      out.push({ file: full, top });
    }
  }
}

export async function libraryFiles(
  deps: { moviesPath?: string; tvPath?: string; now?: number; movies?: typeof cachedMovies; series?: typeof cachedSeries } = {}
): Promise<{ files: LibraryFile[]; settling: number }> {
  const now = deps.now ?? Date.now();
  const [movies, series] = await Promise.all([
    (deps.movies ?? cachedMovies)().catch(() => []),
    (deps.series ?? cachedSeries)().catch(() => []),
  ]);
  const movieByFolder = new Map<string, { id: number; title: string; year?: number }>();
  for (const m of movies) if (m.path) movieByFolder.set(path.basename(m.path.replace(/[\\/]+$/, "")), { id: m.id, title: m.title, year: m.year });
  const seriesByFolder = new Map<string, { id: number; title: string }>();
  for (const s of series) if (s.path) seriesByFolder.set(path.basename(s.path.replace(/[\\/]+$/, "")), { id: s.id, title: s.title });

  const files: LibraryFile[] = [];
  let settling = 0;
  for (const [root, kind] of [
    [deps.moviesPath ?? MOVIES_PATH, "movie"],
    [deps.tvPath ?? TV_PATH, "episode"],
  ] as const) {
    const found: { file: string; top: string }[] = [];
    await walk(root, 0, found, null, { n: 0 });
    for (const { file, top } of found) {
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        continue;
      }
      if (now - stat.mtimeMs < SETTLE_MS) {
        settling++;
        continue;
      }
      let title: string;
      let serviceId: number | null;
      if (kind === "movie") {
        const movie = movieByFolder.get(top);
        title = movie ? `${movie.title}${movie.year ? ` (${movie.year})` : ""}` : top;
        serviceId = movie?.id ?? null;
      } else {
        const show = seriesByFolder.get(top);
        const tag = episodeTag(path.basename(file));
        title = `${show?.title ?? top}${tag ? ` — ${tag}` : ` — ${path.basename(file)}`}`;
        serviceId = show?.id ?? null;
      }
      files.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs, kind, title, serviceId });
    }
  }
  // L'ordre des dossiers : la progression se lit, et la tête de lecture avance dans un sens.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, settling };
}
