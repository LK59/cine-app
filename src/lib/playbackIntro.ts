import { MOVIES_CATALOGUE_KEY, SERIES_CATALOGUE_KEY } from "@/lib/catalogueKeys";
import { catalogueTitles, type HydratedPayload } from "@/lib/cinemaPayload";
import { tmdbResize } from "@/lib/images";

/**
 * L'ouverture de la lecture : ce que l'écran montre entre l'appui sur « Lire » et la première image
 * (DECISIONS.md §60). Le visuel du film qui avance lentement, son logo qui paraît avec une lueur, une
 * légende (épisode, reprise), une ligne de chargement, puis un fondu enchaîné vers le film.
 *
 * Mise au point dans la page « Tests animations » (lot G, 10/10/2026), puis validée telle quelle :
 * les réglages ci-dessous sont ceux retenus, et le lot G rend le même composant (`PlaybackIntro`)
 * avec ses curseurs en plus — ce qu'on règle là-bas est ce qui part en production.
 *
 * Ce fichier ne contient que des règles pures : réglages, adresses, voile, légende, et la recherche
 * du visuel dans ce que l'appareil sait déjà. L'horloge partagée entre les deux lecteurs est en bas.
 */

export type IntroBackground = "net" | "light" | "strong" | "old";

export interface PlaybackIntroSettings {
  /** Sous ce délai entre l'appui et la première image, rien ne paraît : l'ouverture n'aurait pas de sens. */
  thresholdMs: number;
  /** Le fond part de cette échelle et revient à 1 en six secondes. */
  zoom: number;
  /** La durée d'apparition du logo. */
  logoMs: number;
  /** La lueur qui traverse le logo, découpée à sa forme par un masque. */
  sweep: boolean;
  background: IntroBackground;
  /** En %, 0 pour le voile d'origine ; voir `introVeil`. */
  brightness: number;
}

/** Les réglages validés le 10/10/2026 : fond net, voile d'origine, et les délais par défaut du banc. */
export const PLAYBACK_INTRO: PlaybackIntroSettings = {
  thresholdMs: 300,
  zoom: 1.08,
  logoMs: 600,
  sweep: true,
  background: "net",
  brightness: 0,
};

/**
 * Les fonds que le banc compare, et le flou de chacun. « Net » est celui de la production : même
 * adouci, le flou se lisait comme une image de basse qualité ; net en 1 280 px, le voile suffit à faire
 * lire le logo. Les autres restent pour comparer.
 */
export const INTRO_BACKGROUNDS: { id: IntroBackground; label: string; blur: number }[] = [
  { id: "net", label: "Net", blur: 0 },
  { id: "light", label: "Flou léger", blur: 10 },
  { id: "strong", label: "Flou marqué", blur: 24 },
  { id: "old", label: "Ancien (300 px agrandi)", blur: 0 },
];

export function introBlur(background: IntroBackground): number {
  return INTRO_BACKGROUNDS.find((m) => m.id === background)?.blur ?? 0;
}

/**
 * L'adresse du visuel : 1 280 px, ou l'original quand l'écran en montre plus (plus de 1 700 pixels
 * physiques de large). L'ancien fond de 300 px agrandi ne sert qu'à la comparaison du banc — c'est lui
 * qui faisait « le flou basse résolution qui se voit ».
 */
export function introBackdropSrc(url: string | null | undefined, background: IntroBackground = "net", physicalWidth?: number): string {
  if (!url) return "";
  if (background === "old") return tmdbResize(url, "w300") ?? url;
  const width =
    physicalWidth ?? (typeof window !== "undefined" ? window.innerWidth * (window.devicePixelRatio || 1) : 0);
  return tmdbResize(url, width > 1700 ? "original" : "w1280") ?? url;
}

/**
 * Le voile du fond. Plus dense sur une image nette, qui garde tous ses détails derrière le logo : un
 * voile radial pour le centrer, un dégradé du bas pour la légende et la ligne de chargement.
 * `brightness` (en %, 0 par défaut) l'allège ou l'épaissit d'autant : +30 retire 30 % de chaque
 * opacité, −30 en ajoute 30 %, plafonné pour que le fond reste visible.
 */
export function introVeil(background: IntroBackground, brightness = 0): string {
  const a = (alpha: number) => `rgba(0,0,0,${Math.min(0.95, alpha * (1 - brightness / 100)).toFixed(3)})`;
  if (background === "net") {
    return `radial-gradient(ellipse at center, ${a(0.3)}, ${a(0.82)} 78%), linear-gradient(to top, ${a(0.6)}, rgba(0,0,0,0) 45%)`;
  }
  if (background === "old") return `radial-gradient(ellipse at center, ${a(0.35)}, ${a(0.78)} 75%)`;
  return `radial-gradient(ellipse at center, ${a(0.25)}, ${a(0.72)} 78%), linear-gradient(to top, ${a(0.45)}, rgba(0,0,0,0) 40%)`;
}

/* ─── Ce que l'ouverture montre ─────────────────────────────────────────────── */

/**
 * Le visuel, le logo et, pour un épisode, sa place dans la série — tout ce qu'il faut pour que
 * l'ouverture paraisse sans rien demander au réseau.
 */
export interface PlaybackIntroArt {
  /** Le nom du film ou de la série, écrit à la place du logo quand il n'y en a pas. */
  name: string;
  backdropUrl: string | null;
  logoUrl: string | null;
  season?: number;
  episode?: number;
  episodeTitle?: string | null;
}

/** Ce que la recherche lit du cache de SWR — sa forme minimale, pour qu'un test la simule. */
export interface IntroCacheReader {
  keys(): Iterable<string>;
  get(key: string): unknown;
}

interface IntroTitle {
  jellyfinItemId?: string | null;
  title: string;
  backdropUrl: string | null;
  logoUrl: string | null;
}
interface IntroMovie extends IntroTitle {
  radarrId: number;
}
interface IntroSeries extends IntroTitle {
  sonarrId: number;
  firstEpisode?: { itemId: string };
}

function dataOf(reader: IntroCacheReader, key: string): unknown {
  const entry = reader.get(key) as { data?: unknown } | undefined;
  return entry?.data;
}

function titlesOf<T>(reader: IntroCacheReader, key: string): T[] {
  const payload = dataOf(reader, key) as Pick<HydratedPayload<T>, "items" | "spotlight" | "rows"> | undefined;
  if (!payload || typeof payload !== "object" || !payload.rows) return [];
  return catalogueTitles(payload);
}

function art(title: IntroTitle, episode?: { season: number; episode: number; title?: string | null }): PlaybackIntroArt {
  return {
    name: title.title,
    backdropUrl: title.backdropUrl,
    logoUrl: title.logoUrl,
    ...(episode ? { season: episode.season, episode: episode.episode, episodeTitle: episode.title ?? null } : {}),
  };
}

/** « S01E02 · Le titre » — la forme du sous-titre de « Reprendre », la seule qu'il donne. */
function parseEpisodeSubtitle(subtitle: unknown): { season: number; episode: number; title: string | null } | null {
  if (typeof subtitle !== "string") return null;
  const m = /^S(\d+)E(\d+)(?:\s·\s(.*))?$/.exec(subtitle);
  return m ? { season: Number(m[1]), episode: Number(m[2]), title: m[3]?.trim() || null } : null;
}

/**
 * Le visuel d'un titre qu'on lance, trouvé dans ce que l'appareil a déjà reçu : le catalogue (films,
 * séries), « Reprendre », « À suivre », et les listes d'épisodes déjà ouvertes. Rien n'est demandé au
 * serveur — l'ouverture doit pouvoir paraître à l'instant de l'appui, et la description du fichier,
 * qui porte aussi un logo, arrive parfois après le seuil (son logo a 500 ms de budget côté serveur).
 *
 * Un épisode prend le visuel et le logo de sa série. Rien de trouvé : `null`, et l'ouverture écrit
 * le titre de la séance sur fond noir.
 */
export function resolveIntroArt(itemId: string, reader: IntroCacheReader): PlaybackIntroArt | null {
  const movies = titlesOf<IntroMovie>(reader, MOVIES_CATALOGUE_KEY);
  const movie = movies.find((m) => m.jellyfinItemId === itemId);
  if (movie) return art(movie);

  const series = titlesOf<IntroSeries>(reader, SERIES_CATALOGUE_KEY);
  const bySonarr = (id: unknown) => (typeof id === "number" ? series.find((s) => s.sonarrId === id) : undefined);

  // « À suivre » : le numéro de saison et d'épisode, et la série par Sonarr.
  const nextUp = (dataOf(reader, "/api/cinema/next-up") as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [];
  const up = nextUp.find((i) => i.jellyfinItemId === itemId);
  if (up) {
    const s = bySonarr(up.sonarrId);
    if (s && typeof up.seasonNumber === "number" && typeof up.episodeNumber === "number") {
      return art(s, { season: up.seasonNumber, episode: up.episodeNumber });
    }
  }

  // « Reprendre » : la fiche par son adresse, l'épisode par son sous-titre.
  const resume = (dataOf(reader, "/api/jellyfin/resume") as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [];
  const resumed = resume.find((i) => i.id === itemId);
  if (resumed && typeof resumed.cinemaHref === "string") {
    const href = /^\/(radarr|sonarr)\/(\d+)$/.exec(resumed.cinemaHref);
    if (href?.[1] === "radarr") {
      const m = movies.find((x) => x.radarrId === Number(href[2]));
      if (m) return art(m);
    } else if (href?.[1] === "sonarr") {
      const s = bySonarr(Number(href[2]));
      const ep = parseEpisodeSubtitle(resumed.subtitle);
      if (s) return art(s, ep ?? undefined);
    }
  }

  // Les listes d'épisodes déjà reçues — une fiche de série ouverte, l'épisode suivant.
  for (const key of reader.keys()) {
    const m = typeof key === "string" ? /^\/api\/cinema\/series\/([^/]+)\/episodes$/.exec(key) : null;
    if (!m) continue;
    const seasons = (dataOf(reader, key) as { seasons?: Array<{ episodes?: Array<Record<string, unknown>> }> } | undefined)?.seasons ?? [];
    for (const season of seasons) {
      const ep = season.episodes?.find((e) => e.jellyfinItemId === itemId);
      if (!ep) continue;
      const s = series.find((x) => x.jellyfinItemId === m[1]);
      if (s && typeof ep.seasonNumber === "number" && typeof ep.episodeNumber === "number") {
        return art(s, { season: ep.seasonNumber, episode: ep.episodeNumber, title: typeof ep.title === "string" ? ep.title : null });
      }
    }
  }

  // Le premier épisode qu'une série jamais commencée lance d'emblée (DECISIONS.md §55).
  const first = series.find((s) => s.firstEpisode?.itemId === itemId);
  if (first) return art(first, { season: 1, episode: 1 });

  // Une série lancée par son propre identifiant (rare) : son visuel, sans légende.
  const whole = series.find((s) => s.jellyfinItemId === itemId);
  return whole ? art(whole) : null;
}

/* ─── La légende ───────────────────────────────────────────────────────────── */

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** Une reprise plus courte ne vaut pas une ligne : le recul d'ouverture est déjà de cinq secondes. */
export const RESUME_CAPTION_MIN_SECONDS = 30;

/** « 1 h 12 » au-delà d'une heure, « 12 min 05 » en deçà — la forme de l'écran « connexion perdue ». */
export function formatResumeClock(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h > 0 ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min ${String(sec).padStart(2, "0")}`;
}

/**
 * La légende contextuelle, une ligne par fait : l'épisode (« S1 · É3 · Le titre »), puis la reprise
 * (« Reprise à 12 min 05 »). Un film lancé depuis le début n'en a aucune.
 */
export function introCaption(
  facts: { season?: number; episode?: number; episodeTitle?: string | null; resumeSeconds?: number | null },
  t: Translate
): string[] {
  const lines: string[] = [];
  if (typeof facts.season === "number" && typeof facts.episode === "number") {
    const code = t("cinema.episodeShort", { season: facts.season, episode: facts.episode });
    lines.push(facts.episodeTitle ? `${code} · ${facts.episodeTitle}` : code);
  }
  if (typeof facts.resumeSeconds === "number" && facts.resumeSeconds >= RESUME_CAPTION_MIN_SECONDS) {
    lines.push(t("player.experimental.resumeAt", { time: formatResumeClock(facts.resumeSeconds) }));
  }
  return lines;
}

/* ─── L'horloge partagée ───────────────────────────────────────────────────── */

/**
 * Quand l'ouverture a commencé, et si elle est finie, par lecture (`${openId}:${itemId}`).
 *
 * Hors de React parce qu'elle doit survivre au démontage d'un lecteur : quand le lecteur natif passe
 * la main au lecteur serveur avant la première image (`fallToStable`), le second monte avec sa propre
 * ouverture, qui doit reprendre au point exact où la première en était — le fond au même zoom, le
 * logo déjà là — et non recommencer. Et une lecture qui a montré une image ne rejoue jamais
 * l'ouverture : ni une reconstruction, ni un relais en plein film, ni le retour d'une diffusion.
 *
 * L'épisode suivant est une autre clé : il a sa propre ouverture si son chargement se fait attendre.
 */
const clocks = new Map<string, { startedAt: number; finished: boolean; snapshot?: unknown }>();
const KEPT_CLOCKS = 8;

export function introKey(openId: number | undefined, itemId: string): string {
  return `${openId ?? 0}:${itemId}`;
}

/** Note le début de cette ouverture — le premier appel l'emporte. Rend l'heure retenue. */
export function startIntroClock(key: string, now: number = Date.now()): number {
  const known = clocks.get(key);
  if (known) return known.startedAt;
  clocks.set(key, { startedAt: now, finished: false });
  // Bornée : une page ouverte des jours enchaîne des centaines de lectures.
  while (clocks.size > KEPT_CLOCKS) clocks.delete(clocks.keys().next().value as string);
  return now;
}

/** La première image est là (ou la lecture l'a dépassée) : cette ouverture ne reparaîtra plus. */
export function finishIntro(key: string): void {
  const known = clocks.get(key);
  if (known) known.finished = true;
  else clocks.set(key, { startedAt: Date.now(), finished: true });
}

export function introFinished(key: string): boolean {
  return clocks.get(key)?.finished === true;
}

/**
 * Ce que l'ouverture montre, figé quand elle paraît, pour qu'un lecteur qui prend la relève montre la
 * même chose — la légende de reprise du natif vient de l'état du serveur, que le lecteur serveur ne
 * relit pas, et elle aurait disparu au relais.
 */
export function keepIntroSnapshot<T>(key: string, snapshot: T): void {
  const known = clocks.get(key);
  if (known) known.snapshot = snapshot;
}

export function introSnapshot<T>(key: string): T | undefined {
  return clocks.get(key)?.snapshot as T | undefined;
}

/** Pour les tests. */
export function resetIntroClocks(): void {
  clocks.clear();
}

/**
 * Une ouverture a-t-elle un sens pour cette séance ? Pas pour le banc d'essai (il mesure, l'écran
 * n'est pas regardé), ni pour la page rechargée d'un changement de piste ou le retour d'une
 * diffusion : ce sont des reprises en plein film, que le spectateur n'a pas « lancées ».
 */
export function introAllowedFor(session: { bench?: string; fromReload?: boolean; startPaused?: boolean }): boolean {
  return !session.bench && !session.fromReload && !session.startPaused;
}

/** Charge le visuel et le logo dès l'appui : à la première frame de l'ouverture, ils sont d'ordinaire déjà là. */
export function preloadIntroArt(art: PlaybackIntroArt | null | undefined): void {
  if (!art || typeof Image === "undefined") return;
  for (const src of [introBackdropSrc(art.backdropUrl), art.logoUrl ?? ""]) {
    if (!src) continue;
    const img = new Image();
    img.decoding = "async";
    img.src = src;
  }
}
