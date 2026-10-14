import fs from "node:fs/promises";
import path from "node:path";
import { radarr, type RadarrMovie } from "@/lib/clients/radarr";
import { cachedJellyfinMoviesAdmin, cachedMovies } from "@/lib/server-cache";
import { matchMovies } from "@/lib/catalogueMembers";
import { MOVIES_PATH } from "@/lib/media-paths";

/**
 * Les films à indexer et où les lire dans le conteneur (DECISIONS.md §88).
 *
 * **Les films de la bibliothèque, et rien d'autre** : ceux que le cinéma montre (`matchMovies` — un
 * fichier chez Radarr *et* son élément Jellyfin), lus au chemin que Radarr leur donne, ramené sous
 * `MOVIES_PATH`. C'est la règle que les statistiques de stockage appliquent déjà (`libraryKey`) :
 * Radarr voit ses films sous sa propre racine (`/media/movies/…`), le conteneur sous la sienne ; seul
 * ce qui suit la racine — `<dossier du film>/<fichier>` — est commun. Jamais les copies en partage
 * (seeds, cross-seed) ni les téléchargements : ils ne sont pas sous la racine des films.
 */

export interface LibraryFilm {
  itemId: string;
  radarrId: number;
  title: string;
  /** Le fichier vu du conteneur. */
  file: string;
  originalLanguage: string | null;
}

/** Le chemin d'un film dans le conteneur, d'après Radarr — `null` s'il n'a pas de fichier. */
export function containerPathOf(movie: Pick<RadarrMovie, "path" | "movieFile">, moviesRoot = MOVIES_PATH): string | null {
  if (!movie.path || !movie.movieFile?.relativePath) return null;
  const folder = path.basename(movie.path.replace(/[\\/]+$/, ""));
  const relative = movie.movieFile.relativePath.replace(/\\/g, "/");
  // Un chemin relatif qui remonte (« ../ ») sortirait de la racine : jamais suivi.
  if (!folder || relative.split("/").includes("..")) return null;
  return path.join(moviesRoot, folder, relative);
}

export async function libraryFilms(): Promise<LibraryFilm[]> {
  const [movies, jellyfinMovies] = await Promise.all([cachedMovies(), cachedJellyfinMoviesAdmin()]);
  const out: LibraryFilm[] = [];
  for (const { m, jfItem } of matchMovies(movies, jellyfinMovies)) {
    const file = containerPathOf(m);
    if (!file) continue;
    out.push({ itemId: jfItem.Id, radarrId: m.id, title: m.title, file, originalLanguage: m.originalLanguage?.name ?? null });
  }
  // L'ordre des dossiers : la tête du disque avance dans un sens, et la progression se lit dans l'ordre alphabétique.
  return out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

export type MountProblem = "not-mounted" | "unreadable" | "no-radarr" | "no-films" | "files-missing";

export interface MountCheck {
  ok: boolean;
  problem: MountProblem | null;
  /** La racine des films dans le conteneur (`MOVIES_PATH`). */
  moviesPath: string;
  /** Les dossiers racines de Radarr, tels qu'il les voit. */
  rootFolders: string[];
  /** Combien de films de l'échantillon ont été trouvés à leur chemin. */
  sample: { checked: number; found: number };
}

const SAMPLE = 5;

/**
 * Le dossier des films est-il monté et lisible ? L'option ne s'active qu'à cette condition : la
 * racine existe et se lit, Radarr répond, et un échantillon de films se trouve bien au chemin
 * déduit. Lu à chaque ouverture de la page et avant chaque passe — jamais gardé.
 */
export async function checkMoviesMount(
  deps: { movies?: () => Promise<RadarrMovie[]>; rootFolders?: () => Promise<string[]>; moviesPath?: string } = {},
): Promise<MountCheck> {
  const moviesPath = deps.moviesPath ?? MOVIES_PATH;
  const base: MountCheck = { ok: false, problem: null, moviesPath, rootFolders: [], sample: { checked: 0, found: 0 } };
  try {
    const stat = await fs.stat(moviesPath);
    if (!stat.isDirectory()) return { ...base, problem: "not-mounted" };
  } catch {
    return { ...base, problem: "not-mounted" };
  }
  try {
    await fs.access(moviesPath, fs.constants.R_OK | fs.constants.X_OK);
    await fs.readdir(moviesPath);
  } catch {
    return { ...base, problem: "unreadable" };
  }
  let movies: RadarrMovie[];
  let rootFolders: string[] = [];
  try {
    [movies, rootFolders] = await Promise.all([
      (deps.movies ?? (() => cachedMovies()))(),
      (deps.rootFolders ?? (async () => ((await radarr.getRootFolders()) as { path?: string }[]).map((f) => f.path ?? "").filter(Boolean)))().catch(() => [] as string[]),
    ]);
  } catch {
    return { ...base, problem: "no-radarr" };
  }
  const withFile = movies.filter((m) => m.hasFile && m.movieFile?.relativePath && m.path);
  if (withFile.length === 0) return { ...base, rootFolders, problem: "no-films" };
  // Réparti sur toute la liste plutôt que les premiers : un dossier racine sur deux monté se verrait.
  const step = Math.max(1, Math.floor(withFile.length / SAMPLE));
  const sample = withFile.filter((_, i) => i % step === 0).slice(0, SAMPLE);
  let found = 0;
  for (const movie of sample) {
    const file = containerPathOf(movie, moviesPath);
    if (!file) continue;
    try {
      const handle = await fs.open(file, "r");
      await handle.close();
      found++;
    } catch {
      /* absent ou illisible */
    }
  }
  const check = { ...base, rootFolders, sample: { checked: sample.length, found } };
  return found > 0 ? { ...check, ok: true } : { ...check, problem: "files-missing" };
}
