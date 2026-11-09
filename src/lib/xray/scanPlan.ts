/**
 * L'ordre dans lequel la bibliothèque est analysée en fond (DECISIONS.md §138, « Le planificateur de la bibliothèque ») — des fonctions pures,
 * sans un appel : `scanSources.ts` lit Jellyfin, Radarr et Sonarr, `scheduler.ts` commande.
 *
 * Trois paliers, dans l'ordre (consigne du propriétaire, 09/11/2026) :
 * 1. **Ce qu'on regarde** : pour chaque compte, les films de « Reprendre » et, pour chaque série en
 *    cours (« Reprendre » + « À suivre »), l'épisode en cours ou suivant et les quatre d'après — cinq
 *    épisodes. Classés par rang dans les listes puis par distance à l'épisode en cours : l'épisode que
 *    chacun va lancer passe avant le cinquième d'une autre série.
 * 2. **Les arrivées** : ce qui est entré dans la bibliothèque depuis `NEW_WINDOW_MS`, le plus récent
 *    d'abord — une file continue, chaque relecture du plan y fait entrer les nouveaux imports.
 * 3. **Le reste** : films et épisodes, du plus récent au plus ancien.
 *
 * **La date d'entrée vient de Radarr et Sonarr** (`movieFile.dateAdded`, `episodeFile.dateAdded`), pas
 * de Jellyfin : sur cette installation, `DateCreated` est la date de la migration de stockage pour
 * 2 015 éléments (19/08/2026), puis de chaque relecture de dossier (mesuré le 09/11/2026 : 712 le
 * 05/10, 585 le 25/10). Un élément que ni Radarr ni Sonarr ne revendique garde la date de Jellyfin — le
 * seul repli, et le seul cas où elle sert à dire « arrivé récemment ». FileFlows, qui réencode en place,
 * ne change pas la date d'import (vérifié le 13/10/2026) : un fichier réencodé ne remonte pas au palier
 * 2 ; c'est la relecture lente de l'`ETag` (`scheduler.ts`) qui le voit.
 *
 * **Écartés** : l'animation (genre « Animation » ou « Anime » chez Jellyfin, Radarr — TMDB — ou Sonarr),
 * où un modèle de visages réels ne reconnaît personne. L'absence de distribution TMDB ne se sait qu'au
 * moment de commander (`castOf`) : l'élément est alors écarté à ce moment-là.
 */

/**
 * `0` : la liste de priorité de l'administrateur (un film, ou une série entière, choisis à la main —
 * `scheduler.ts`, `prioritizeTitle`), au-dessus de tout, commandée en `normal` et nourrie même pendant
 * une lecture. Jamais produit par `buildPlan` : une relecture du plan ne le retire pas.
 */
export type ScanTier = 0 | 1 | 2 | 3;
export const SCAN_TIERS: readonly ScanTier[] = [0, 1, 2, 3];
/** Les paliers que le plan calcule lui-même. */
export const PLAN_TIERS: readonly ScanTier[] = [1, 2, 3];

/**
 * Les épisodes d'une série dans l'ordre de la liste de priorité : saison par saison, épisode par épisode,
 * les spéciaux (saison 0) à la fin ; un épisode sans numéro après les autres, dans l'ordre reçu.
 */
export function seriesOrder<T extends EpisodeRef>(episodes: readonly T[]): T[] {
  const key = (e: EpisodeRef) => {
    const season = numbered(e.ParentIndexNumber) ? (e.ParentIndexNumber === 0 ? 100_000 : e.ParentIndexNumber) : 200_000;
    const episode = numbered(e.IndexNumber) ? e.IndexNumber : 100_000;
    return season * 1_000_000 + episode;
  };
  return episodes
    .map((e, i) => ({ e, i, k: key(e) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.e);
}

/** Ce qui compte comme « arrivé récemment » : deux semaines. */
export const NEW_WINDOW_MS = 14 * 24 * 3600_000;
/** Les épisodes d'une série en cours, en comptant celui qu'on regarde ou qu'on va regarder. */
export const EPISODES_AHEAD = 5;

export interface PlannedItem {
  itemId: string;
  tier: ScanTier;
  kind: "Movie" | "Episode";
  title: string;
  seriesId: string | null;
  /** Durée selon Jellyfin (`RunTimeTicks`), en secondes — 0 inconnue. */
  durationS: number;
  /** Date d'entrée (ms) : Radarr/Sonarr, sinon Jellyfin. */
  importedAt: number;
  /** L'ordre dans le palier, croissant. */
  rank: number;
  /** `animation` : compté à part, jamais commandé. */
  excluded: "animation" | null;
}

/** Un élément de la bibliothèque tel que les sources le décrivent. */
export interface LibraryEntry {
  itemId: string;
  kind: "Movie" | "Episode";
  title: string;
  seriesId: string | null;
  durationS: number;
  /** Date d'import Radarr/Sonarr (ms), ou `null` si aucun ne revendique ce fichier. */
  importedAt: number | null;
  /** `DateCreated` de Jellyfin (ms) — le repli. */
  createdAt: number | null;
  animation: boolean;
}

/** Une liste « Reprendre » ou « À suivre » d'un compte, dans son ordre. */
export interface WatchingEntry {
  itemId: string;
  kind: "Movie" | "Episode";
  seriesId: string | null;
}

export interface EpisodeRef {
  Id: string;
  ParentIndexNumber?: number | null;
  IndexNumber?: number | null;
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();

/** Les noms du genre selon les langues où Jellyfin, TMDB et TVDB l'écrivent. */
const ANIMATION_GENRES = new Set(["animation", "anime", "animes", "animacion", "zeichentrick", "dessin anime", "dessins animes"]);

export function isAnimationGenre(genres: readonly (string | null | undefined)[] | null | undefined): boolean {
  return (genres ?? []).some((g) => typeof g === "string" && ANIMATION_GENRES.has(fold(g)));
}

const numbered = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;

/**
 * L'épisode `anchorId` et ceux qui le suivent, `count` en tout — la chaîne de `nextEpisodeAfter`
 * (saisons à la suite, spéciaux entre eux).
 */
export function episodesFrom(episodes: readonly EpisodeRef[], anchorId: string, count = EPISODES_AHEAD): string[] {
  const all = episodes.filter((e) => numbered(e.ParentIndexNumber) && numbered(e.IndexNumber));
  const anchor = all.find((e) => e.Id === anchorId);
  if (!anchor) return [];
  const specials = anchor.ParentIndexNumber === 0;
  const chain = all
    .filter((e) => (e.ParentIndexNumber === 0) === specials)
    .sort((a, b) => a.ParentIndexNumber! - b.ParentIndexNumber! || a.IndexNumber! - b.IndexNumber!);
  const at = chain.findIndex((e) => e.Id === anchorId);
  return chain.slice(at, at + count).map((e) => e.Id);
}

/**
 * Le palier 1 : chaque liste de compte (« Reprendre » puis « À suivre »), jointe, sans doublon. Rend
 * `itemId → rang`. Le rang croise la distance à l'épisode en cours (le cinquième épisode passe après
 * tous les premiers) et l'ordre des listes.
 */
export function watchingRanks(
  lists: readonly (readonly WatchingEntry[])[],
  episodesOf: (seriesId: string) => readonly EpisodeRef[] | undefined,
): Map<string, number> {
  const ranks = new Map<string, number>();
  const put = (id: string, rank: number) => {
    const known = ranks.get(id);
    if (known === undefined || rank < known) ranks.set(id, rank);
  };
  const seenSeries = new Set<string>();
  // Les listes de tous les comptes, entrelacées : le premier titre de chacun avant le deuxième de quiconque.
  const longest = Math.max(0, ...lists.map((l) => l.length));
  let slot = 0;
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const entry = list[i];
      if (!entry) continue;
      slot++;
      if (entry.kind === "Movie") {
        put(entry.itemId, slot);
        continue;
      }
      if (!entry.seriesId) {
        put(entry.itemId, slot);
        continue;
      }
      // Une série déjà vue plus haut (un autre compte, ou « Reprendre » puis « À suivre ») : son ancre
      // compte quand même — deux comptes peuvent être à deux endroits de la même série.
      const key = `${entry.seriesId}:${entry.itemId}`;
      if (seenSeries.has(key)) continue;
      seenSeries.add(key);
      const chain = episodesOf(entry.seriesId);
      const ids = chain ? episodesFrom(chain, entry.itemId) : [];
      if (ids.length === 0) {
        put(entry.itemId, slot);
        continue;
      }
      ids.forEach((id, distance) => put(id, distance * 10_000 + slot));
    }
  }
  return ranks;
}

/** Le plan entier : chaque élément de la bibliothèque, son palier et son rang. */
export function buildPlan(library: readonly LibraryEntry[], watching: Map<string, number>, now: number): PlannedItem[] {
  const out: PlannedItem[] = [];
  const dated = library.map((e) => ({ e, at: e.importedAt ?? e.createdAt ?? 0 }));
  // Du plus récent au plus ancien, puis par identifiant : un ordre stable d'une relecture à l'autre.
  dated.sort((a, b) => b.at - a.at || (a.e.itemId < b.e.itemId ? -1 : 1));
  let rank = 0;
  for (const { e, at } of dated) {
    rank++;
    const watchRank = watching.get(e.itemId);
    const tier: ScanTier = watchRank !== undefined ? 1 : at > 0 && now - at <= NEW_WINDOW_MS ? 2 : 3;
    out.push({
      itemId: e.itemId,
      tier,
      kind: e.kind,
      title: e.title,
      seriesId: e.seriesId,
      durationS: e.durationS,
      importedAt: at,
      rank: tier === 1 ? watchRank! : rank,
      excluded: e.animation ? "animation" : null,
    });
  }
  return out;
}

/** Deux durées « égales » : à une seconde près (consigne du propriétaire, 09/11/2026). */
export const SAME_DURATION_TOLERANCE_S = 1;

export function sameDuration(a: number | null | undefined, b: number | null | undefined): boolean {
  return typeof a === "number" && typeof b === "number" && a > 0 && b > 0 && Math.abs(a - b) <= SAME_DURATION_TOLERANCE_S;
}

/**
 * La vitesse d'analyse (× temps réel) mesurée sur les éléments finis : durée analysée sur temps de
 * calcul, en somme — un épisode de dix minutes ne pèse pas autant qu'un film de trois heures.
 */
export function analysisSpeed(samples: readonly { durationS: number; computeS: number }[]): number | null {
  let media = 0;
  let compute = 0;
  for (const s of samples) {
    if (s.durationS > 0 && s.computeS > 0) {
      media += s.durationS;
      compute += s.computeS;
    }
  }
  return compute > 0 ? media / compute : null;
}

/** Le temps restant (s) pour `remainingS` secondes de vidéo à `speed` × temps réel ; `null` sans mesure. */
export function etaSeconds(remainingS: number, speed: number | null): number | null {
  if (remainingS <= 0) return 0;
  if (!speed || speed <= 0) return null;
  return Math.round(remainingS / speed);
}

/**
 * Les seuls dossiers analysés (consigne du propriétaire, 09/11/2026) : ceux des films et des séries tels
 * que Jellyfin les voit — jamais les téléchargements, les seeds, les livres ni un autre dossier, même si
 * Jellyfin en listait un élément. Relevé ce jour-là : 920 films sous `/media/movies`, 9 398 épisodes
 * sous `/media/tv` ; les livres sont sous `/media/books` et `/media/books-packs`. Une autre installation
 * règle les siens par `XRAY_LIBRARY_ROOTS` (liste séparée par des virgules), relue à chaque appel.
 */
export const DEFAULT_LIBRARY_ROOTS = ["/media/movies", "/media/tv"] as const;

export function libraryRoots(): string[] {
  const raw = process.env.XRAY_LIBRARY_ROOTS?.trim();
  const roots = raw ? raw.split(",") : [...DEFAULT_LIBRARY_ROOTS];
  return roots.map((r) => r.trim().replace(/\/+$/, "")).filter((r) => r.startsWith("/") && r.length > 1);
}

/**
 * Le fichier est-il sous l'un des dossiers permis ? Un chemin relatif, un segment `..` ou `.`, ou un
 * dossier voisin au nom qui commence pareil (`/media/movies-seeds`) ne passent pas.
 */
export function isLibraryPath(path: string | null | undefined, roots: readonly string[] = libraryRoots()): boolean {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) return false;
  if (path.split("/").some((seg) => seg === ".." || seg === ".")) return false;
  return roots.some((root) => path.startsWith(`${root}/`) && path.length > root.length + 1);
}
