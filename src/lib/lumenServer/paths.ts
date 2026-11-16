// Le chemin d'un fichier de Jellyfin, lu dans ce conteneur.
//
// Jellyfin voit la bibliothèque sous `/media`, ce conteneur sous `/mnt/media/video` (2-serveur.md
// §2.1) : la même arborescence montée deux fois sous deux noms. Codée en dur, la traduction
// marcherait ici et nulle part ailleurs — d'où un réglage de déploiement, `LUMEN_PATH_MAP`, relu à
// chaque appel (règle de config.ts, DECISIONS.md §48), vide par défaut : sans lui, aucune lecture
// directe, et l'étape 3 prend le relais Jellyfin.
//
// Les garde-fous sont ici, une fois : un chemin hors des racines déclarées, un `..`, un octet nul ou
// un lien symbolique qui sortirait de la racine ne donnent rien. Le droit de l'account à voir le titre
// (`assertVisible`) se vérifie avant, à la route ; ceci ne décide que de *où* lire.
//
// Fil principal seulement : importe la configuration (et donc la base des réglages).

import { realpath } from "node:fs/promises";
import { config } from "@/lib/config";

export interface PathMapping {
  /** La racine telle que Jellyfin l'écrit (`/media`). */
  from: string;
  /** La même, dans ce conteneur (`/mnt/media/video`). */
  to: string;
}

/** `/media=/mnt/media/video;/autre=/ailleurs` → paires, les malformées ignorées. Pur. */
export function parsePathMap(raw: string): PathMapping[] {
  const out: PathMapping[] = [];
  for (const pair of raw.split(";")) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    const from = trimSlash(pair.slice(0, at).trim());
    const to = trimSlash(pair.slice(at + 1).trim());
    if (!from.startsWith("/") || !to.startsWith("/")) continue;
    out.push({ from, to });
  }
  // La racine la plus longue d'abord : `/media/tv` passe avant `/media` s'ils sont déclarés tous deux.
  return out.sort((a, b) => b.from.length - a.from.length);
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/**
 * Le chemin local d'un chemin Jellyfin selon `mappings`, sans toucher au disque — ou null : hors des
 * racines, `..`, octet nul, chemin relatif. Pur, pour les tests ; `lumenLocalPath` y ajoute le disque.
 */
export function mapJellyfinPath(jellyfinPath: string, mappings: PathMapping[]): { path: string; root: string } | null {
  if (!jellyfinPath.startsWith("/") || jellyfinPath.includes("\0")) return null;
  if (jellyfinPath.split("/").some((part) => part === ".." || part === ".")) return null;
  for (const { from, to } of mappings) {
    if (jellyfinPath === from) return null; // la racine elle-même n'est pas un fichier
    if (!jellyfinPath.startsWith(`${from}/`)) continue;
    return { path: `${to}${jellyfinPath.slice(from.length)}`, root: to };
  }
  return null;
}

/**
 * Le chemin local réel d'un fichier de Jellyfin, ou null : réglage vide, chemin hors des racines, ou
 * fichier introuvable ici. Le chemin réel (`realpath`, liens suivis) doit rester sous la racine réelle :
 * un lien symbolique posé dans la bibliothèque ne mène pas ailleurs.
 */
export async function lumenLocalPath(jellyfinPath: string, raw: string = config.lumen.pathMap): Promise<string | null> {
  const mapped = mapJellyfinPath(jellyfinPath, parsePathMap(raw));
  if (!mapped) return null;
  try {
    const [real, root] = await Promise.all([realpath(mapped.path), realpath(mapped.root)]);
    return real.startsWith(`${root}/`) ? real : null;
  } catch {
    // Introuvable ou illisible ici (installation sans médias montés, `EACCES`) : le relais Jellyfin.
    return null;
  }
}
