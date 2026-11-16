/**
 * Le mode « Tout enchaîner » de la page de banc `/lumen-test` (étapes 3b et 3c de docs/remux-serveur/,
 * DECISIONS §157, §158).
 *
 * Pourquoi : un protocole d'une vingtaine de lectures et de deux cents sauts, à mener sur un iPhone. À la main,
 * c'est une heure de gestes et autant d'occasions d'en oublier un. Ici, un appui déroule tout, dans l'ordre, et
 * chaque essai part au journal dès qu'il est fini : une série interrompue a déjà laissé ce qu'elle a mesuré.
 *
 * **Depuis l'étape 3c, c'est un comparatif** : chaque titre est joué par deux lecteurs — Lumen serveur (HLS
 * natif, `player: "serveur"`) et le lecteur de production d'aujourd'hui (Lumen dans la page : remux, MediaSource,
 * `player: "actuel"`) —, dans le même `<video>`, avec la même piste audio et **les mêmes sauts** (positions tirées
 * d'une graine commune, `seekPositions`), mesurés par le même code (première image, `seekedMs`, `advanceMs`,
 * attentes, gels, `getVideoPlaybackQuality`, erreurs). Le banc du 16/11/2026 avait laissé une question : un saut
 * serveur ne repart qu'en 1,5 s médiane, et player.log dit ~0,43 s pour le lecteur actuel — mais ce n'est pas la
 * même mesure. Ici, si.
 *
 * **Tous les essais serveur d'abord, puis tous ceux du lecteur actuel** : WebKit refuse un HLS natif (code 4) dans
 * une page qui a déjà servi une MediaSource, l'inverse passe. Recharger la page entre les deux aurait permis
 * d'alterner, mais un rechargement fait perdre à l'élément le droit de jouer avec le son que l'appui sur « Tout
 * enchaîner » lui a donné : il faudrait un second appui au milieu de la série, et sessionStorage pour la
 * reprendre. Le prix de l'ordre fixe : le lecteur actuel passe après le serveur sur les mêmes fichiers et les mêmes
 * positions, donc sur un cache de pages du serveur plus chaud (la construction d'un segment serveur coûtait au pire
 * 257 ms disque compris au banc du 16/11 : l'avantage est borné par là, et il joue *pour* le lecteur actuel).
 *
 * Ce module est la partie sans navigateur — le plan, l'enchaînement, la détection des gels, les lignes, le
 * tableau — pour qu'elle s'éprouve en Node (`lumen-test-auto.test.ts`). Le composant (`LumenTest.tsx`) fournit le
 * pilote : la vidéo, les deux lecteurs, les sauts, les pistes, l'envoi. Rien ici ne touche au moteur.
 */

export type Cut = "idr" | "cra" | "cra-leading";

/** Le lecteur d'un essai : Lumen serveur (HLS natif) ou le lecteur de production (Lumen dans la page, MediaSource). */
export type PlayerKind = "serveur" | "actuel";

/** La passe : la série complète (~30 min) ou le comparatif rapide (~12 min). */
export type SeriesPass = "complète" | "courte";

/**
 * Les titres d'essai, tirés du recensement du 16/11/2026 (docs/remux-serveur/README.md, « Étape 3b ») :
 * un par cas à éprouver. Des identifiants de cette bibliothèque — ailleurs, le champ libre sert.
 * `key` nomme l'essai dans le journal (`ghosted-serveur`) : lisible sans table de correspondance.
 */
export const PRESETS: { key: string; id: string; title: string; note: string }[] = [
  { key: "maison-blanche", id: "d4513bcf59bba90a23656f40ed816c3d", title: "À la Maison Blanche S03E01", note: "H.264 1080p, AC-3 2.0, clés toutes les 2,6 s — le témoin" },
  { key: "black-monday", id: "3f79d20c0c10289f3c6df5f72f62b84b", title: "Black Monday S02E10", note: "HEVC 4K à IDR seules, une clé toutes les 2 s" },
  { key: "notting-hill", id: "55027c51fd0cdeceec6062202c73a4db", title: "Coup de foudre à Notting Hill", note: "HEVC 1080p à IDR seules, une clé par seconde, AC-3 5.1 — la cible de 2 s" },
  { key: "american-housewife", id: "7f17493b25683f0db7125defa08b70a0", title: "American Housewife — Attaque de poux", note: "HEVC 1080p à GOP ouvert court, débit faible" },
  { key: "ghosted", id: "1694ff6c78fd793f321d348511771a47", title: "Ghosted", note: "HEVC 4K DV 8.1, E-AC-3 Atmos, GOP ouvert" },
  { key: "pearl-harbor", id: "a1e058d682294a1de3cf5bb47d904e0e", title: "Pearl Harbor", note: "HEVC 1080p à GOP ouvert (132 CRA à RASL vues), 3 h" },
  { key: "ted-lasso", id: "edaa7d0071b034dc32fabf1834484278", title: "Ted Lasso S02E01", note: "HEVC 4K DV 8.1, trois Atmos, CRA à RASL" },
  { key: "prestige", id: "23505fbd074bc303c0a41dbc8a8d207f", title: "Le Prestige", note: "GOP ouvert, son DTS seul : refusé par le serveur tant que la conversion n'existe pas" },
  { key: "alien-romulus", id: "697cf1d483e4e736edf416d8b510f19f", title: "Alien : Romulus", note: "HEVC 1080p, E-AC-3 7.1, une clé toutes les 10,4 s" },
];

/** La cible de segment par défaut de Lumen serveur, en secondes (`LUMEN_TARGET_SEGMENT_US`). */
export const DEFAULT_TARGET_S = 4;

/** Un essai de la série : un titre, un lecteur, ce qu'on y fait. */
export interface Trial {
  /** Le nom de l'essai au journal : `<titre>-<lecteur>`, plus `-t2` pour une cible de 2 s. */
  id: string;
  /** Le titre (`PRESETS.key`) : les essais d'un même titre partagent leurs positions de saut et leur ligne du tableau. */
  key: string;
  itemId: string;
  title: string;
  player: PlayerKind;
  /** La découpe du serveur (`cra`, la règle depuis §158) ; sans objet pour le lecteur actuel. */
  cut: Cut;
  /** La cible de segment du serveur (s) : 4 sauf essai de l'étape 3c. */
  targetS: number;
  /** Départ demandé (s) : 0 pour le début. Un départ est mesuré comme un saut (`depart`). */
  startAt: number;
  /** Les parcours de sauts, chacun son nombre de sauts (positions tirées de la graine, 4 s de lecture après chaque). */
  tours: number[];
  /** Passer d'une piste audio à l'autre par `audioTracks` après les parcours (HLS seulement). */
  audioTour: boolean;
  /** Préparer seulement, sous ces découpes, sans lire : le verdict est le résultat (*Le Prestige*). */
  prepareOnly?: Cut[];
}

/** Lecture avant le premier parcours : de quoi voir le démarrage, et le premier segment suivant. */
export const PLAY_BEFORE_TOURS_MS = 10_000;
/** Sans première image passé ce délai (compté une fois `play()` accepté), l'essai est un échec et la série passe. */
export const FIRST_FRAME_TIMEOUT_MS = 20_000;
/** Après chaque changement de piste audio : la fenêtre où un blocage, une erreur ou un gel lui est imputé. */
export const AUDIO_SWITCH_WATCH_MS = 8_000;
/** Une position qui avance de plus que ceci sans nouvelle image présentée : un gel (le son continue, l'image non). */
export const FREEZE_ADVANCE_S = 1;
/** La cadence de la vérification des gels pendant la lecture (en plus du rebasage à chaque saut). */
export const FREEZE_CHECK_MS = 2_000;

const preset = (key: string) => {
  const found = PRESETS.find((p) => p.key === key);
  if (!found) throw new Error(`titre d'essai inconnu : ${key}`);
  return found;
};

type TrialOptions = Partial<Pick<Trial, "startAt" | "tours" | "audioTour" | "prepareOnly" | "targetS">>;

function trial(key: string, player: PlayerKind, options: TrialOptions = {}): Trial {
  const p = preset(key);
  const targetS = options.targetS ?? DEFAULT_TARGET_S;
  return {
    id: options.prepareOnly ? `${p.key}-preparer` : `${p.key}-${player}${targetS !== DEFAULT_TARGET_S ? `-t${targetS}` : ""}`,
    key: p.key,
    itemId: p.id,
    title: p.title,
    player,
    cut: "cra",
    targetS,
    startAt: options.startAt ?? 0,
    tours: options.tours ?? [10],
    audioTour: options.audioTour ?? false,
    prepareOnly: options.prepareOnly,
  };
}

/** Le même titre, joué par le lecteur actuel avec les mêmes parcours (sans tour des pistes : `audioTracks` est HLS). */
const current = (t: Trial): Trial => trial(t.key, "actuel", { tours: t.tours });

/**
 * La série complète de l'étape 3c, ~30 minutes (`seriesEstimateS`). Les titres de l'étape 3b, un parcours de 10
 * sauts (20 pour les deux HEVC à GOP ouvert qui ont tranché la découpe), puis le lecteur actuel sur chacun.
 * L'essai des segments courts (cible 2 s, étape 3c) sur les titres dont les clés sont rapprochées — *Black
 * Monday* (une clé toutes les 2 s), *Notting Hill* (1 s), *À la Maison Blanche* (2,6 s), d'après le recensement
 * —, chacun à côté de sa cible de 4 s : la mesure qui compte est `advanceMs` après un saut.
 * *Le Prestige* : préparé seulement (son DTS, refusé par le serveur) ; le tour des pistes sur *Ted Lasso* (trois
 * Atmos) seulement. Les essais serveur d'abord (voir l'en-tête).
 */
const FULL_SERVER: Trial[] = [
  trial("maison-blanche", "serveur"),
  trial("maison-blanche", "serveur", { targetS: 2 }),
  trial("black-monday", "serveur"),
  trial("black-monday", "serveur", { targetS: 2 }),
  trial("notting-hill", "serveur"),
  trial("notting-hill", "serveur", { targetS: 2 }),
  trial("american-housewife", "serveur"),
  trial("ghosted", "serveur", { tours: [20] }),
  trial("pearl-harbor", "serveur", { tours: [20] }),
  trial("ted-lasso", "serveur", { audioTour: true }),
  trial("alien-romulus", "serveur"),
  trial("prestige", "serveur", { prepareOnly: ["cra"], tours: [] }),
];

export const SERIES: Trial[] = [...FULL_SERVER, ...FULL_SERVER.filter((t) => !t.prepareOnly && t.targetS === DEFAULT_TARGET_S).map(current)];

/**
 * Le comparatif rapide, ~12 minutes : un H.264 (*À la Maison Blanche*), un HEVC à IDR seules (*Black Monday*,
 * plus sa cible de 2 s), un HEVC à GOP ouvert (*Ghosted*, DV 4K Atmos), un DV 4K à trois Atmos (*Ted Lasso*) ;
 * 10 sauts chacun, sans tour des pistes, chaque titre par les deux lecteurs.
 */
const QUICK_SERVER: Trial[] = [
  trial("maison-blanche", "serveur"),
  trial("black-monday", "serveur"),
  trial("black-monday", "serveur", { targetS: 2 }),
  trial("ghosted", "serveur"),
  trial("ted-lasso", "serveur"),
];

export const QUICK_SERIES: Trial[] = [...QUICK_SERVER, ...QUICK_SERVER.filter((t) => t.targetS === DEFAULT_TARGET_S).map(current)];

export function planOf(pass: SeriesPass): Trial[] {
  return pass === "courte" ? QUICK_SERIES : SERIES;
}

/**
 * Durée estimée d'un essai (s), pour la barre de progression et l'annonce du bouton. Mesures de la page sur
 * l'iPhone : un verdict d'index déjà construit ~1 s, une première image 0,5 à 5 s, un saut de parcours ~1,5 s
 * plus ses 4 s de lecture ; un changement de piste, sa fenêtre de 8 s. Une estimation : la barre avance au temps,
 * sans jamais dépasser la part de l'essai en cours.
 */
export function trialEstimateS(t: Trial): number {
  if (t.prepareOnly) return 15 * t.prepareOnly.length;
  const seeks = t.tours.reduce((sum, n) => sum + n, 0);
  return 3 + 5 + PLAY_BEFORE_TOURS_MS / 1000 + seeks * 5.5 + (t.audioTour ? 3 * (AUDIO_SWITCH_WATCH_MS / 1000 + 1) : 0);
}

export function seriesEstimateS(plan: readonly Trial[]): number {
  return plan.reduce((sum, t) => sum + trialEstimateS(t), 0);
}

/** La part faite de la série (0 à 1) : les essais finis, plus l'essai en cours au temps, plafonné à 95 % de sa part. */
export function seriesProgress(plan: readonly Trial[], index: number, elapsedInTrialS: number): number {
  const total = seriesEstimateS(plan);
  if (total <= 0) return 0;
  let done = 0;
  for (let i = 0; i < Math.min(index, plan.length); i++) done += trialEstimateS(plan[i]);
  if (index < plan.length) done += Math.min(Math.max(0, elapsedInTrialS), trialEstimateS(plan[index]) * 0.95);
  return Math.min(1, done / total);
}

// --- Les positions des sauts -----------------------------------------------------------------------------

/** FNV-1a sur 32 bits : la graine d'un parcours, tirée de la graine de la série, du titre et du rang du parcours. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32 : un générateur sur 32 bits, assez pour tirer des positions, identique partout. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Les positions (s) d'un parcours : **les mêmes pour les deux lecteurs** d'un titre — même graine de série, même
 * titre, même rang de parcours, même durée (celle du verdict serveur, `durationS`, demandée par les deux essais ;
 * la durée de l'élément sinon). La règle du parcours d'avant : entre 30 s et la fin moins 60 s, puis bornée à la
 * fin moins 5 s ; au dixième de seconde, pour que la ligne envoyée les montre telles qu'elles ont été demandées.
 */
export function seekPositions(seed: number, key: string, tour: number, count: number, durationS: number): number[] {
  const random = mulberry32(hash32(`${seed}|${key}|${tour}`));
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const to = 30 + random() * Math.max(1, durationS - 90);
    out.push(Math.round(Math.max(0, Math.min(durationS - 5, to)) * 10) / 10);
  }
  return out;
}

/** Une graine de série : 31 bits, tirée par la page, portée par chaque ligne pour refaire les mêmes parcours. */
export function newSeed(): number {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0] >>> 1;
}

// --- La détection des gels -------------------------------------------------------------------------------

/** Un gel : l'horloge du média a avancé sans qu'une image nouvelle ne soit présentée. */
export interface Freeze {
  /** La position (s) de la dernière image présentée : ce que l'écran montrait pendant le gel. */
  at: number;
  /** Durée estimée (ms), du début de l'avance sans image jusqu'à ce qui l'a fini ; `null` tant qu'il dure. */
  ms: number | null;
  /** Le gel a suivi un saut sans qu'aucune image ne soit venue entre-temps : le cas d'une CRA mal reprise. */
  afterSeek: boolean;
  /**
   * Ce qui l'a fini : une image enfin présentée, un saut (le parcours continue), la page cachée ou la vidéo sortie
   * de la vue (le jugement s'arrête là : la durée est un minimum), ou la fin de l'essai.
   */
  until?: "image" | "saut" | "masqué" | "fin";
}

/**
 * Ce que l'œil voyait seul, compté par la page : l'image figée pendant que le son continue.
 *
 * `requestVideoFrameCallback` appelle une fois par image *présentée* (pas décodée) : tant que le compositeur
 * montre la même, rien n'arrive. Le son, lui, pilote `currentTime`. Donc si la position avance de plus d'une
 * seconde depuis la dernière image présentée, l'écran est figé alors que la lecture continue — exactement le
 * symptôme d'une CRA reprise sans ses références (Safari sous MediaSource : *Ted Lasso* S02E01).
 *
 * L'horloge est passée en argument (`now`, ms) : la page donne `performance.now()`, le test une horloge factice.
 * Ce qui n'est pas vu : une image *présentée* mais abîmée (verte, en blocs) — elle compte comme une image. C'est
 * la première question de fin de série.
 */
export class FreezeWatch {
  readonly freezes: Freeze[] = [];
  /** Images présentées depuis le début de l'essai (rappels de `requestVideoFrameCallback`). */
  presented = 0;
  /** La référence : position et instant de la dernière image, ou du dernier rebasage (saut, retour au premier plan). */
  private anchor: { t: number; at: number; afterSeek: boolean } | null = null;
  private open: { freeze: Freeze; since: number } | null = null;

  /** Une image présentée à l'instant `now`, de position `t` (`mediaTime` du rappel, sinon `currentTime`). */
  frame(now: number, t: number): void {
    this.presented += 1;
    this.close(now, "image");
    this.anchor = { t, at: now, afterSeek: false };
  }

  /**
   * La position a changé sans lecture — un saut (`afterSeek`), ou la page cachée, la vidéo hors de la vue, un retour
   * au premier plan : on repart de `t`, sans image encore. Avant la première image, rien : c'est l'attente de la première image qui juge (20 s).
   */
  rebase(now: number, t: number, afterSeek = true): void {
    if (this.presented === 0) return;
    this.close(now, afterSeek ? "saut" : "masqué");
    this.anchor = { t, at: now, afterSeek };
  }

  /** Vérifie la position `t` à l'instant `now` ; rend le gel s'il vient de commencer. */
  check(now: number, t: number): Freeze | null {
    if (!this.anchor || this.open) return null;
    const advanced = t - this.anchor.t;
    if (!(advanced > FREEZE_ADVANCE_S)) return null;
    const freeze: Freeze = { at: Math.round(this.anchor.t * 10) / 10, ms: null, afterSeek: this.anchor.afterSeek };
    this.freezes.push(freeze);
    // Le début se déduit de l'avance (lecture à vitesse 1) : vérifié toutes les 2 s, le gel a commencé bien avant
    // qu'on le voie. Jamais avant la référence elle-même (le temps d'un saut avant la reprise ne compte pas).
    this.open = { freeze, since: Math.max(this.anchor.at, now - advanced * 1000) };
    return freeze;
  }

  /** Fin de l'essai : un gel encore ouvert est fermé à cet instant. */
  end(now: number): void {
    this.close(now, "fin");
  }

  get frozenMs(): number {
    return this.freezes.reduce((sum, f) => sum + (f.ms ?? 0), 0);
  }

  private close(now: number, until: NonNullable<Freeze["until"]>): void {
    if (!this.open) return;
    this.open.freeze.ms = Math.max(0, Math.round(now - this.open.since));
    this.open.freeze.until = until;
    this.open = null;
  }
}

// --- Les compteurs de décodage ---------------------------------------------------------------------------

export interface Quality {
  total: number;
  dropped: number;
  corrupted: number;
}

/**
 * La différence de `getVideoPlaybackQuality()` entre le début et la fin d'un essai. Une source neuve remet les
 * compteurs à zéro sur WebKit comme sur Chromium : si la fin est plus petite que le début, c'est qu'ils l'ont
 * été entre les deux, et la fin seule est l'essai.
 */
export function qualityDelta(start: Quality | undefined, end: Quality | undefined): Quality | undefined {
  if (!end) return undefined;
  if (!start || end.total < start.total) return { ...end };
  return { total: end.total - start.total, dropped: Math.max(0, end.dropped - start.dropped), corrupted: Math.max(0, end.corrupted - start.corrupted) };
}

export function median(values: readonly number[]): number | undefined {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

/** Le 90e centile, au rang le plus proche (10 sauts : le 9e) — la même règle que les chiffres du banc du 16/11. */
export function p90(values: readonly number[]): number | undefined {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return undefined;
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)]);
}

// --- L'enchaînement ------------------------------------------------------------------------------------

/** Le verdict du serveur, réduit à ce que la série décide avec. */
export interface PreparedVerdict {
  ok: boolean;
  reason?: string;
  detail?: string;
  version?: string;
  audioTrack: number | null;
  segments?: number;
  longestS?: number;
  /** La durée du fichier selon l'index du serveur : celle d'où les deux lecteurs tirent les positions des sauts. */
  durationS?: number;
}

export type StartResult = { image: true } | { image: false; reason: string };

export type TrialStatus = "ok" | "échec" | "refusé" | "préparé" | "arrêté";

/** Ce que la série a décidé d'un essai ; le pilote y joint ses mesures en le fermant. */
export interface TrialOutcome {
  status: TrialStatus;
  reason?: string;
  /** *Le Prestige* : chaque découpe préparée et son verdict (`null` : le serveur n'a pas répondu). */
  prepared?: { cut: Cut; verdict: PreparedVerdict | null }[];
}

/** Ce que la lecture d'un essai a mesuré, tiré de la lecture de la page en la fermant. */
export interface TrialMeasures {
  firstFrameMs?: number;
  seeks: { ok?: boolean; seekedMs?: number; advanceMs?: number }[];
  freezes: Freeze[];
  errors: string[];
  waits: number;
  quality?: Quality;
  audioSwitches: { ms?: number; waited: boolean; errors?: number; freezes?: number }[];
}

/** Une ligne de résultat : ce que l'écran montre d'un essai fini, et ce que la ligne récapitulative en garde. */
export interface TrialResult {
  trial: string;
  /** Le titre (`PRESETS.key`) : la ligne du tableau comparatif. */
  key: string;
  rank: number;
  title: string;
  player: PlayerKind;
  /** La découpe et la cible du serveur ; absentes pour le lecteur actuel. */
  cut?: Cut;
  targetS?: number;
  status: TrialStatus;
  reason?: string;
  firstFrameMs?: number;
  seeks: number;
  missed: number;
  /** Médiane, du geste à la reprise (le temps avance de 0,3 s), des sauts repris : `advanceMs`. */
  seekMedianMs?: number;
  /** Le 90e centile de la même mesure. */
  advanceP90Ms?: number;
  /** Médiane et 90e centile, du geste à `seeked` (l'image à la bonne position), des sauts repris. */
  seekedMedianMs?: number;
  seekedP90Ms?: number;
  freezes: number;
  freezeMs: number;
  errors: number;
  firstError?: string;
  waits: number;
  frames?: number;
  dropped?: number;
  corrupted?: number;
  audioSwitches?: number;
  /** Changements de piste suivis d'un blocage, d'une erreur, d'un gel, ou après lesquels le temps n'a pas repris. */
  audioTrouble?: number;
  verdicts?: string[];
}

export function describeVerdict(cut: Cut, verdict: PreparedVerdict | null): string {
  if (!verdict) return `${cut} : pas de réponse`;
  const facts = `${verdict.segments ?? "?"} segments, le plus long ${verdict.longestS ?? "?"} s`;
  return verdict.ok ? `${cut} : servi (${facts})` : `${cut} : refus ${verdict.reason ?? "?"}${verdict.detail ? ` (${verdict.detail})` : ""} — ${facts}`;
}

export function resultOf(t: Trial, rank: number, outcome: TrialOutcome, measures?: TrialMeasures): TrialResult {
  const base: TrialResult = {
    trial: t.id,
    key: t.key,
    rank,
    title: t.title,
    player: t.player,
    ...(t.player === "serveur" ? { cut: t.cut, targetS: t.targetS } : {}),
    status: outcome.status,
    reason: outcome.reason,
    seeks: 0,
    missed: 0,
    freezes: 0,
    freezeMs: 0,
    errors: 0,
    waits: 0,
  };
  if (outcome.prepared) base.verdicts = outcome.prepared.map((p) => describeVerdict(p.cut, p.verdict));
  if (!measures) return base;
  const reached = measures.seeks.filter((s) => s.ok && typeof s.advanceMs === "number").map((s) => s.advanceMs as number);
  const seeked = measures.seeks.filter((s) => s.ok && typeof s.seekedMs === "number").map((s) => s.seekedMs as number);
  const switches = measures.audioSwitches;
  return {
    ...base,
    firstFrameMs: measures.firstFrameMs,
    seeks: measures.seeks.length,
    missed: measures.seeks.filter((s) => !s.ok).length,
    seekMedianMs: median(reached),
    advanceP90Ms: p90(reached),
    seekedMedianMs: median(seeked),
    seekedP90Ms: p90(seeked),
    freezes: measures.freezes.length,
    freezeMs: measures.freezes.reduce((sum, f) => sum + (f.ms ?? 0), 0),
    errors: measures.errors.length,
    firstError: measures.errors[0],
    waits: measures.waits,
    frames: measures.quality?.total,
    dropped: measures.quality?.dropped,
    corrupted: measures.quality?.corrupted,
    ...(switches.length
      ? { audioSwitches: switches.length, audioTrouble: switches.filter((s) => s.ms === undefined || s.waited || (s.errors ?? 0) > 0 || (s.freezes ?? 0) > 0).length }
      : {}),
  };
}

/** La ligne d'écran d'un essai fini : première image, médiane des sauts, gels, erreurs. */
export function formatResult(r: TrialResult): string {
  const head = `${r.rank}. ${r.title} · ${playerLabel(r)}`;
  if (r.verdicts) return `${head} — ${r.verdicts.join(" ; ")}`;
  if (r.status === "refusé") return `${head} — refusé : ${r.reason ?? "?"}`;
  const parts = [
    r.firstFrameMs !== undefined ? `image ${r.firstFrameMs} ms` : "sans image",
    r.seeks
      ? `sauts : image ${r.seekedMedianMs ?? "—"}/${r.seekedP90Ms ?? "—"} ms, reprise ${r.seekMedianMs ?? "—"}/${r.advanceP90Ms ?? "—"} ms (méd./p90)${r.missed ? `, ${r.missed} manqué${r.missed > 1 ? "s" : ""}` : ""}`
      : null,
    `gels ${r.freezes}${r.freezes ? ` (${(r.freezeMs / 1000).toFixed(1)} s)` : ""}`,
    `erreurs ${r.errors}`,
    r.audioSwitches ? `pistes ${r.audioSwitches - (r.audioTrouble ?? 0)}/${r.audioSwitches} nettes` : null,
    r.status !== "ok" ? `${r.status.toUpperCase()}${r.reason ? ` : ${r.reason}` : ""}` : null,
  ];
  return `${head} — ${parts.filter(Boolean).join(" · ")}`;
}

/** Le lecteur d'une ligne, et sa cible quand ce n'est pas celle par défaut : « serveur », « serveur 2 s », « actuel ». */
export function playerLabel(r: Pick<TrialResult, "player" | "targetS">): string {
  return r.player === "serveur" && r.targetS !== undefined && r.targetS !== DEFAULT_TARGET_S ? `serveur ${r.targetS} s` : r.player;
}

/**
 * Ce que la page fournit à la série : chaque geste du protocole, sur la vraie vidéo. Chaque méthode rend la main
 * quand son geste est fini (ou arrêté) ; aucune ne doit rejeter, mais si l'une le fait, l'essai est un échec et la
 * série continue.
 */
export interface SeriesDriver {
  stopped(): boolean;
  begin(t: Trial, rank: number): void;
  prepare(t: Trial, cut: Cut): Promise<PreparedVerdict | null>;
  /** Lance la lecture de l'essai et attend la première image (20 s au plus après un `play()` accepté). */
  start(t: Trial, rank: number, verdict: PreparedVerdict): Promise<StartResult>;
  play(ms: number): Promise<void>;
  tour(count: number, index: number): Promise<void>;
  audioTour(): Promise<void>;
  /** Ferme l'essai — la lecture s'il y en a une — et rend sa ligne de résultat. */
  close(t: Trial, rank: number, outcome: TrialOutcome): TrialResult;
  /** Envoie la ligne de l'essai ; un échec d'envoi ne change rien à la série (le pilote garde la ligne). */
  send(t: Trial, rank: number, result: TrialResult): Promise<void>;
}

const errorText = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 120);

/** Un essai, du verdict au tour des pistes. Ce qui le fait échouer est rendu, jamais levé plus haut. */
async function runTrial(t: Trial, rank: number, d: SeriesDriver): Promise<TrialOutcome> {
  if (t.prepareOnly) {
    const prepared: NonNullable<TrialOutcome["prepared"]> = [];
    for (const cut of t.prepareOnly) {
      if (d.stopped()) return { status: "arrêté", prepared };
      prepared.push({ cut, verdict: await d.prepare(t, cut) });
    }
    return { status: "préparé", prepared };
  }
  const verdict = await d.prepare(t, t.cut);
  if (d.stopped()) return { status: "arrêté" };
  if (!verdict) return { status: "échec", reason: "préparation impossible" };
  if (!verdict.ok) return { status: "refusé", reason: `${verdict.reason ?? "?"}${verdict.detail ? ` (${verdict.detail})` : ""}` };
  const started = await d.start(t, rank, verdict);
  if (d.stopped()) return { status: "arrêté" };
  if (!started.image) return { status: "échec", reason: started.reason };
  await d.play(PLAY_BEFORE_TOURS_MS);
  for (let i = 0; i < t.tours.length; i++) {
    if (d.stopped()) return { status: "arrêté" };
    await d.tour(t.tours[i], i);
  }
  if (t.audioTour && !d.stopped()) await d.audioTour();
  return { status: d.stopped() ? "arrêté" : "ok" };
}

/**
 * La série : chaque essai dans l'ordre, fermé et envoyé avant le suivant. Un essai qui échoue — refus, pas
 * d'image, exception du pilote — est noté et la série passe : une découpe qui casse Safari sur un titre ne doit
 * pas priver les suivants de leur mesure. « Arrêter » finit l'essai en cours (sa ligne part quand même) et rien
 * après.
 */
export async function runSeries(plan: readonly Trial[], d: SeriesDriver, onResult?: (result: TrialResult) => void): Promise<{ results: TrialResult[]; stopped: boolean }> {
  const results: TrialResult[] = [];
  for (let i = 0; i < plan.length; i++) {
    if (d.stopped()) break;
    const t = plan[i];
    const rank = i + 1;
    d.begin(t, rank);
    let outcome: TrialOutcome;
    try {
      outcome = await runTrial(t, rank, d);
    } catch (error) {
      outcome = { status: d.stopped() ? "arrêté" : "échec", reason: `exception ${errorText(error)}` };
    }
    let result: TrialResult;
    try {
      result = d.close(t, rank, outcome);
    } catch (error) {
      result = resultOf(t, rank, { status: "échec", reason: `fermeture ${errorText(error)}` });
    }
    results.push(result);
    onResult?.(result);
    try {
      await d.send(t, rank, result);
    } catch {
      /* le pilote garde la ligne pour le prochain envoi ; la série continue */
    }
  }
  return { results, stopped: d.stopped() };
}

// --- Les lignes -------------------------------------------------------------------------------------------

export interface SeriesAnswers {
  /** « Avez-vous vu une image abîmée (verte, en blocs) ou figée pendant que le son continuait ? » */
  damaged: "oui" | "non" | null;
  /** Sur quel titre, si oui (facultatif). */
  damagedTitle: string;
  /** « Quand les pistes audio ont changé (Ted Lasso), le son a-t-il changé sans coupure de l'image ? » */
  audioClean: "oui" | "non" | "pas-entendu" | null;
}

/** Le marquage d'une ligne d'essai : la série (pour joindre ses lignes), l'essai, son rang, le total, le lecteur. */
export function trialTag(serie: string, t: Trial, rank: number, of: number, meta: { pass: SeriesPass; seed: number }) {
  return { serie, trial: t.id, rank, of, player: t.player, pass: meta.pass, seed: meta.seed };
}

/** Ce qu'une colonne du tableau comparatif garde d'un essai. */
export interface ComparisonCell {
  status: TrialStatus;
  firstFrameMs?: number;
  seekedMedianMs?: number;
  seekedP90Ms?: number;
  advanceMedianMs?: number;
  advanceP90Ms?: number;
  seeks: number;
  missed: number;
  errors: number;
  freezes: number;
}

/** Une ligne du tableau : un titre (et une cible serveur autre que 4 s : sa propre ligne), ses deux lecteurs. */
export interface ComparisonRow {
  key: string;
  title: string;
  /** 4 pour la comparaison des deux lecteurs ; 2 pour l'essai des segments courts (serveur seul). */
  targetS: number;
  serveur?: ComparisonCell;
  actuel?: ComparisonCell;
}

/**
 * Le tableau côte à côte de l'écran de fin et de la ligne récapitulative : par titre, première image, et
 * `seekedMs` / `advanceMs` médiane et p90 pour chaque lecteur. L'ordre est celui du premier essai de chaque
 * ligne ; les préparations seules (*Le Prestige*) n'y sont pas.
 */
export function comparisonRows(results: readonly TrialResult[]): ComparisonRow[] {
  const rows = new Map<string, ComparisonRow>();
  for (const r of results) {
    if (r.verdicts) continue;
    const targetS = r.player === "serveur" ? (r.targetS ?? DEFAULT_TARGET_S) : DEFAULT_TARGET_S;
    const id = `${r.key}|${targetS}`;
    const row = rows.get(id) ?? { key: r.key, title: r.title, targetS };
    row[r.player] = {
      status: r.status,
      firstFrameMs: r.firstFrameMs,
      seekedMedianMs: r.seekedMedianMs,
      seekedP90Ms: r.seekedP90Ms,
      advanceMedianMs: r.seekMedianMs,
      advanceP90Ms: r.advanceP90Ms,
      seeks: r.seeks,
      missed: r.missed,
      errors: r.errors,
      freezes: r.freezes,
    };
    rows.set(id, row);
  }
  return [...rows.values()];
}

/**
 * La ligne récapitulative : chaque essai résumé, le tableau comparatif et les deux réponses — ce que la page ne
 * voit pas. Même `kind` que les autres (`lumen-test`), marquée `auto.summary` ; relue et bornée par
 * `testReport.ts` comme le reste.
 */
export function summaryBody(
  serie: string,
  of: number,
  results: readonly TrialResult[],
  answers: SeriesAnswers,
  meta: { elapsedS: number; stopped: boolean; pass: SeriesPass; seed: number }
) {
  return {
    auto: { serie, summary: true, of, done: results.length, elapsedS: Math.round(meta.elapsedS), stopped: meta.stopped, pass: meta.pass, seed: meta.seed },
    trials: results.map((r) => ({ ...r })),
    comparison: comparisonRows(results),
    answers: {
      damaged: answers.damaged,
      damagedTitle: answers.damaged === "oui" && answers.damagedTitle.trim() ? answers.damagedTitle.trim().slice(0, 120) : undefined,
      audioClean: answers.audioClean,
    },
  };
}
