// The curated rails Cinema Mode leads with, before the per-genre rows.
//
// A library grouped by genre alphabetically is a catalogue; what makes a Netflix home feel like a
// home is a handful of rails with an *intention* — what just arrived, what's best, what you said
// you'd watch. All three come from data this app already has (Radarr/Sonarr's `added`, the IMDb
// rating it already caches, the watchlist in SQLite), so none of this costs a new integration.
//
// Shared by both cinema routes and both clients so a movie rail and a series rail can never
// disagree on what "recently added" means.

export interface RailItem {
  imdbRating: string | null;
  addedAt: string | null;
}

/** Ce qu'il faut d'un titre pour lui trouver un thème : son année et ses genres. */
export interface ThemedItem extends RailItem {
  year?: number | null;
  genres?: string[];
}

// How recent counts as "new" on a card badge. A month is long enough that a title you added and
// forgot about still announces itself, short enough that the badge stays meaningful.
export const NEW_BADGE_DAYS = 30;

const DAY_MS = 86_400_000;

// Radarr/Sonarr use this sentinel for "never" — parsing it yields a date in year 1, which would
// sort and compare as an extremely old (but valid) timestamp rather than as missing.
function addedTime(addedAt: string | null): number | null {
  if (!addedAt || addedAt.startsWith("0001-01-01")) return null;
  const t = new Date(addedAt).getTime();
  return Number.isFinite(t) ? t : null;
}

export function isRecentlyAdded(addedAt: string | null, now: number = Date.now()): boolean {
  const t = addedTime(addedAt);
  return t !== null && now - t <= NEW_BADGE_DAYS * DAY_MS;
}

export function recentlyAddedRail<T extends RailItem>(items: T[], limit = 20): T[] {
  return items
    .filter((i) => addedTime(i.addedAt) !== null)
    .sort((a, b) => addedTime(b.addedAt)! - addedTime(a.addedAt)!)
    .slice(0, limit);
}

function rating(item: RailItem): number {
  const n = item.imdbRating ? Number.parseFloat(item.imdbRating) : NaN;
  return Number.isFinite(n) ? n : 0;
}

// The numbered rail. Netflix ranks by popularity, which nothing here measures; the honest local
// equivalent is "the best-rated things you actually own", with recency breaking ties so the rail
// still moves as the library grows. Titles with no rating are left out rather than ranked at 0 —
// a rail of ten unrated items would be a worse answer than a shorter one.
export function top10Rail<T extends RailItem>(items: T[]): T[] {
  return items
    .filter((i) => rating(i) > 0)
    .sort((a, b) => {
      const diff = rating(b) - rating(a);
      if (diff !== 0) return diff;
      return (addedTime(b.addedAt) ?? 0) - (addedTime(a.addedAt) ?? 0);
    })
    .slice(0, 10);
}

// The rows map repeats a title once per genre and omits any title with no genre at all, so
// "everything in the payload" means the union of every list it carries, de-duplicated.
export function uniqueById<T>(items: T[], id: (item: T) => number): T[] {
  const byId = new Map<number, T>();
  for (const item of items) byId.set(id(item), item);
  return [...byId.values()];
}

// ─── Le top 10 du jour ────────────────────────────────────────────────────────

/**
 * Ce que le palmarès du jour classe.
 *
 * Un genre tel que la bibliothèque le nomme — les rangées l'affichent déjà ainsi, sans le
 * traduire —, ou une décennie, qui elle se dit dans la langue de qui lit.
 */
export type Top10Theme =
  | { kind: "genre"; genre: string }
  | { kind: "decade"; decade: number }
  | { kind: "genreDecade"; genre: string; decade: number };

export interface DailyTop10<T> {
  /** Null quand rien n'est assez fourni : on retombe alors sur le palmarès de toute la collection. */
  theme: Top10Theme | null;
  items: T[];
}

/** En dessous, « top 10 » serait un mensonge : mieux vaut ne pas proposer ce thème du tout. */
const THEME_MIN = 10;

/**
 * Combien de jours d'affilée un titre peut tenir l'affiche avant d'être mis au repos.
 *
 * Un très bon film appartient à plusieurs genres et à une décennie : il entre donc dans beaucoup de
 * tranches, et sans cette borne il reviendrait presque tous les jours. Le palmarès finirait par
 * ressembler à ce qu'il remplace — une liste figée.
 */
const MAX_STREAK = 3;

/**
 * Une graine stable tirée d'une chaîne — ici la date du jour.
 *
 * Il ne s'agit pas de brouiller quoi que ce soit, seulement d'obtenir *le même* nombre pour tout
 * le monde et toute la journée. Un tirage au hasard changerait à chaque revalidation : la charge
 * utile est en cache deux minutes, et la rangée clignoterait sans raison visible.
 */
function seedFrom(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** La date d'un instant, en jour civil — c'est l'unité à laquelle le thème change. */
export function dayKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function decadeOf(year: number | null | undefined): number | null {
  return typeof year === "number" && year > 1800 ? Math.floor(year / 10) * 10 : null;
}

/** Les thèmes que cette collection peut réellement porter, dans un ordre qui ne dépend pas du hasard. */
function eligibleThemes<T extends ThemedItem>(items: T[]): Top10Theme[] {
  const rated = items.filter((i) => rating(i) > 0);
  const byGenre = new Map<string, number>();
  const byDecade = new Map<number, number>();
  for (const item of rated) {
    for (const genre of item.genres ?? []) byGenre.set(genre, (byGenre.get(genre) ?? 0) + 1);
    const decade = decadeOf(item.year);
    if (decade !== null) byDecade.set(decade, (byDecade.get(decade) ?? 0) + 1);
  }
  // Triés par nom et par année : l'ordre doit être le même d'un serveur à l'autre et d'un jour à
  // l'autre, sans quoi la graine ne désignerait pas le même thème.
  // Les tranches croisées — « comédies des années 2000 » — comptées à part : elles sont bien plus
  // nombreuses que les autres et la plupart n'ont pas dix titres. Seules celles qui les ont entrent.
  const byPair = new Map<string, number>();
  for (const item of rated) {
    const decade = decadeOf(item.year);
    if (decade === null) continue;
    for (const genre of item.genres ?? []) {
      const key = `${genre}|${decade}`;
      byPair.set(key, (byPair.get(key) ?? 0) + 1);
    }
  }

  const genres: Top10Theme[] = [...byGenre.entries()]
    .filter(([, n]) => n >= THEME_MIN)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([genre]) => ({ kind: "genre", genre }));
  const decades: Top10Theme[] = [...byDecade.entries()]
    .filter(([, n]) => n >= THEME_MIN)
    .sort(([a], [b]) => a - b)
    .map(([decade]) => ({ kind: "decade", decade }));
  const pairs: Top10Theme[] = [...byPair.entries()]
    .filter(([, n]) => n >= THEME_MIN)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key]) => {
      const [genre, decade] = key.split("|");
      return { kind: "genreDecade", genre, decade: Number(decade) };
    });
  return [...genres, ...decades, ...pairs];
}

/**
 * Le nom propre d'un thème — ce qui l'identifie d'un jour à l'autre, et d'une version de la
 * bibliothèque à l'autre.
 */
export function themeKey(theme: Top10Theme): string {
  if (theme.kind === "genre") return `g:${theme.genre}`;
  if (theme.kind === "decade") return `d:${theme.decade}`;
  return `gd:${theme.genre}:${theme.decade}`;
}

/**
 * Le thème d'un jour, tiré sans jamais dépendre du *nombre* de thèmes.
 *
 * C'était tout le défaut. `themes[graine % themes.length]` semble inoffensif et ne l'est pas : le
 * modulo lie le résultat à la longueur de la liste, si bien qu'un seul thème qui entre ou qui sort
 * redistribue **tous** les jours à la fois. Or cette liste bouge sans arrêt — un film ajouté fait
 * franchir à un genre la barre des dix titres, et surtout un catalogue construit pendant que
 * Jellyfin finit de démarrer est amputé : moins de titres, moins de thèmes éligibles, autre
 * palmarès. D'où la plainte, exacte : « le top 10 change à chaque redémarrage ».
 *
 * On pèse donc chaque thème séparément — sa propre graine, tirée de son nom et de la date — et on
 * garde le plus lourd. Retirer un thème qui ne gagnait pas ne change rien du tout ; en ajouter un
 * ne change la journée que s'il gagne vraiment, soit une fois sur n. Le tirage reste entièrement
 * déduit de la date : rien n'est stocké pour qu'il fonctionne, et deux serveurs répondraient
 * pareil.
 */
export function themeOfDay<T extends ThemedItem>(items: T[], day: string): Top10Theme | null {
  let best: Top10Theme | null = null;
  let bestWeight = -1;
  for (const theme of eligibleThemes(items)) {
    const weight = seedFrom(`${day}|${themeKey(theme)}`);
    // À poids égal — improbable mais pas impossible sur 32 bits —, le nom tranche, pour que deux
    // machines ne puissent pas répondre différemment.
    if (weight > bestWeight || (weight === bestWeight && best !== null && themeKey(theme) < themeKey(best))) {
      best = theme;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * De quoi se souvenir de ce qui a réellement été montré.
 *
 * Le tirage ci-dessus est déjà stable face à une bibliothèque qui bouge, mais « stable » n'est pas
 * « garanti » : si le genre gagnant passe lui-même sous la barre des dix titres — ce qu'un
 * catalogue amputé au démarrage provoque —, un autre thème gagne, et la journée change en cours de
 * route. Une ligne en base ferme la question : le premier calcul de la journée fait foi, quoi qu'il
 * arrive ensuite au conteneur.
 *
 * Volontairement facultative : la fonction reste pure et testable sans base, et une installation
 * qui ne fournit rien retombe sur le tirage seul, qui est déjà le bon.
 */
export interface Top10Memory {
  /** Le thème retenu pour ce jour-là. `undefined` si on n'en sait rien, `null` s'il n'y en avait aucun. */
  recall(day: string): Top10Theme | null | undefined;
  remember(day: string, theme: Top10Theme | null): void;
}

function matches(item: ThemedItem, theme: Top10Theme): boolean {
  const inGenre = (genre: string) => (item.genres ?? []).includes(genre);
  if (theme.kind === "genre") return inGenre(theme.genre);
  if (theme.kind === "decade") return decadeOf(item.year) === theme.decade;
  return inGenre(theme.genre) && decadeOf(item.year) === theme.decade;
}

/** Le jour qui précède celui-ci, en chaîne, sans dépendre du fuseau. */
function previousDay(day: string, back: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d - back));
}

/**
 * Le palmarès du jour : dix titres, classés par note, dans une tranche qui change chaque jour.
 *
 * Le classement ne bouge pas — c'est ce qu'on classe qui change. Un « top 10 » qui se remélange
 * tous les matins n'est plus un palmarès mais une sélection qui se fait passer pour tel, et ça se
 * voit : le premier d'hier a disparu sans que rien ne l'explique. Une tranche, elle, se comprend
 * d'un coup d'œil au titre de la rangée.
 *
 * Le thème se déduit de la date : tout le monde voit le même, toute la journée, sans que rien ne
 * soit stocké nulle part. Et il retombe sur toute la collection si rien n'est assez fourni — une
 * bibliothèque qui débute vaut mieux avec un palmarès général qu'avec un thème de quatre titres.
 */
export function dailyTop10<T extends ThemedItem>(
  items: T[],
  day: string = dayKey(),
  /**
   * De quoi reconnaître un titre d'un jour à l'autre — son identifiant Radarr ou Sonarr.
   *
   * Passé en paramètre plutôt que lu sur l'objet : ces deux collections ne nomment pas leur clé
   * pareil, et une rangée de films ne doit pas dépendre de la forme d'une série.
   */
  keyOf?: (item: T) => string | number,
  /** Voir `Top10Memory` : ce qui rend la journée définitive une fois qu'elle a commencé. */
  memory?: Top10Memory
): DailyTop10<T> {
  /**
   * Le thème d'un jour : celui qu'on a retenu, sinon celui que la date désigne.
   *
   * Les jours passés ne sont jamais écrits — une première installation les inventerait tous, et
   * cette histoire-là n'a jamais été montrée à personne. Ils sont recalculés quand la base ne les
   * a pas, exactement comme avant.
   */
  const themeFor = (d: string): Top10Theme | null => {
    const known = memory?.recall(d);
    return known !== undefined ? known : themeOfDay(items, d);
  };

  const todaysTheme = themeFor(day);

  const pick = (d: string, banned: ReadonlySet<string | number>) => {
    const theme = d === day ? todaysTheme : themeFor(d);
    if (theme === null) return { theme, items: [] as T[] };
    const pool = items.filter((i) => matches(i, theme) && !(keyOf && banned.has(keyOf(i))));
    return { theme, items: top10Rail(pool) };
  };

  /**
   * On ne retient qu'une réponse qu'on sait saine — et c'est la moitié qui manquait.
   *
   * Vérifié sur la production dès le premier déploiement : la ligne du jour avait été écrite
   * *vide*. Aucun thème, donc un catalogue trop maigre pour en porter un — la panne même qu'on
   * cherchait à figer, figée pour vingt-quatre heures. « Le premier a raison » n'est vrai que si
   * le premier sait de quoi il parle. Une journée sans thème reste donc ouverte : elle est servie
   * telle quelle, sur toute la collection, et la prochaine réponse saine l'emportera.
   *
   * La condition des dix titres, elle, ne couvre pas ce cas-là — un thème éligible en compte dix
   * par construction, donc un thème calculé en rend toujours dix. Elle couvre l'autre : un thème
   * **relu en base** que la bibliothèque d'aujourd'hui ne peut plus remplir. On ne réécrit alors
   * rien, ce qui est de toute façon ce qu'on veut, et la garde reste juste si le seuil
   * d'éligibilité change un jour.
   */
  const healthy = todaysTheme !== null && pick(day, new Set()).items.length === 10;
  if (memory && healthy && memory.recall(day) === undefined) memory.remember(day, todaysTheme);

  if (todaysTheme === null) return { theme: null, items: top10Rail(items) };
  if (!keyOf) return { theme: todaysTheme, items: pick(day, new Set()).items };

  /**
   * Les trois jours précédents, recalculés plutôt que retenus.
   *
   * La sélection d'un jour se déduit entièrement de sa date : il n'y a donc rien à stocker, et le
   * serveur qui répond ce matin trouve exactement ce qu'aurait trouvé celui d'hier. Trois calculs
   * de plus sur quelques centaines de titres, et aucune table à faire vieillir.
   *
   * Ces trois-là sont calculés **sans exclusion** — remonter la chaîne indéfiniment n'aurait pas de
   * fin. La règle est donc très légèrement plus sévère qu'elle n'en a l'air : un titre écarté hier
   * compte quand même comme présent pour juger d'aujourd'hui. L'écart ne se voit pas, et la seule
   * autre issue serait de garder une mémoire que ce mécanisme n'a précisément pas besoin d'avoir.
   */
  const history = Array.from({ length: MAX_STREAK }, (_, i) => i + 1).map((back) => new Set(pick(previousDay(day, back), new Set()).items.map(keyOf)));
  const banned = new Set([...history[0]].filter((id) => history.every((day) => day.has(id))));
  return { theme: todaysTheme, items: pick(day, banned).items };
}
