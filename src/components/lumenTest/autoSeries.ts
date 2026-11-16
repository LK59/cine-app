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
 * Depuis l'étape 3e (DECISIONS §160), **l'ordre inverse** aussi (`planOf(pass, "actuel")`) : le lecteur actuel d'abord,
 * puis la page rechargée (`reloadBefore`, `SeriesDriver.reload`) et Lumen serveur — la série reprend au même rang
 * après un appui (`runSeries(…, { from })`), ce qui corrige le biais du cache plus chaud. Et **les leviers de
 * démarrage** (`TrialModes`), essais serveur à côté d'un témoin du même titre.
 *
 * Depuis l'étape 3f, **la passe « son multiplexé »** (`MUX_SERIES`) : un seul levier, conçu pour trancher — quatre
 * titres, chacun joué trois fois dans chaque mode en alternance, mêmes sauts partout, le débit mesuré avant chaque
 * essai, puis un verdict par titre calculé contre la dispersion des répétitions (`muxPass.ts`).
 *
 * Ce module est la partie sans navigateur — le plan, l'enchaînement, la détection des gels, les lignes, le
 * tableau — pour qu'elle s'éprouve en Node (`lumen-test-auto.test.ts`). Le composant (`LumenTest.tsx`) fournit le
 * pilote : la vidéo, les deux lecteurs, les sauts, les pistes, l'envoi. Rien ici ne touche au moteur.
 */

import type { ChronoSummary } from "./chronology";
import { analyzeMux } from "./muxPass";

export type Cut = "idr" | "cra" | "cra-leading";

/** Le lecteur d'un essai : Lumen serveur (HLS natif) ou le lecteur de production (Lumen dans la page, MediaSource). */
export type PlayerKind = "serveur" | "actuel";

/**
 * La passe : la série complète (~28 min), le comparatif rapide (~13 min), les leviers de démarrage (~10 min, étape 3e)
 * ou le son multiplexé contre la règle (~18 min, étape 3f).
 */
export type SeriesPass = "complète" | "courte" | "leviers" | "multiplexé";

/**
 * L'ordre des lecteurs (étape 3e) : `serveur` — tous les essais serveur, puis ceux du lecteur actuel, dans la même
 * page (l'ordre de l'étape 3c) ; `actuel` — l'inverse, **avec un rechargement de la page** entre les deux, puisque
 * WebKit refuse un HLS natif après une MediaSource dans une même page. Le second ordre corrige le biais du premier :
 * le lecteur joué en second lit des positions que le premier vient de lire, sur un cache disque plus chaud.
 */
export type SeriesOrder = "serveur" | "actuel";

/**
 * Les leviers de démarrage d'un essai serveur (étape 3e, DECISIONS §160) — chacun un mode d'essai, absent par défaut :
 * - `mux` (a) : le son par défaut multiplexé dans les segments vidéo (`?mux=1`, version `…m1`, `trials.ts`) — une
 *   liste, un init et un segment de moins à demander avant la première image ;
 * - `early` (b) : la préparation précoce, comme à l'ouverture de la fiche — `serveur` : `POST …/prepare` (index et
 *   segment de départ construits et gardés) puis `EARLY_DELAY_MS` avant Lire ; `élément` : en plus, la source posée
 *   sur la vidéo avec `preload="auto"` pendant ce délai (Safari charge listes, init et premiers segments) ;
 * - `startMode` (c), pour un départ en milieu de film (`startAt`) : `saut` — la règle d'aujourd'hui, `currentTime` à
 *   `loadedmetadata` ; `ext-x-start` — `EXT-X-START:TIME-OFFSET` dans la liste maître (`?start=`) ; `fragment` —
 *   `#t=` sur l'adresse ;
 * - `bandwidth` (d) : `moyen` — BANDWIDTH annoncé au débit moyen plutôt qu'à la crête (`?bw=moyen`).
 */
export interface TrialModes {
  mux?: boolean;
  early?: "serveur" | "élément";
  startMode?: "saut" | "ext-x-start" | "fragment";
  bandwidth?: "moyen";
}

/** Le délai entre Préparer et Lire d'un essai `early` : le temps d'ouvrir une fiche et d'appuyer sur Lire. */
export const EARLY_DELAY_MS = 5_000;

/** Le nom court des modes d'un essai (identifiant au journal, ligne du tableau) : `mux`, `prep`, `fiche`, `depart-xstart`, `bw`. */
export function modeTag(modes: TrialModes | undefined): string {
  if (!modes) return "";
  const parts: string[] = [];
  if (modes.mux) parts.push("mux");
  if (modes.early) parts.push(modes.early === "serveur" ? "prep" : "fiche");
  if (modes.startMode) parts.push(`depart-${modes.startMode === "ext-x-start" ? "xstart" : modes.startMode === "fragment" ? "frag" : "saut"}`);
  if (modes.bandwidth) parts.push("bw");
  return parts.join("-");
}

/** Les modes d'un essai, en français, pour l'écran. */
export function modeLabel(modes: TrialModes | undefined): string {
  if (!modes) return "";
  const parts: string[] = [];
  if (modes.mux) parts.push("son multiplexé");
  if (modes.early) parts.push(modes.early === "serveur" ? "préparé 5 s avant" : "fiche ouverte 5 s avant");
  if (modes.startMode) parts.push(`départ par ${modes.startMode === "ext-x-start" ? "EXT-X-START" : modes.startMode === "fragment" ? "#t=" : "saut"}`);
  if (modes.bandwidth) parts.push("débit annoncé moyen");
  return parts.join(", ");
}

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
  /** Les leviers de démarrage (serveur seulement, étape 3e) ; absent : la règle. */
  modes?: TrialModes;
  /** L'ordre `actuel` : la page se recharge avant cet essai (le premier essai serveur après ceux du lecteur actuel). */
  reloadBefore?: boolean;
  /** La passe « son multiplexé » (étape 3f) : la répétition (1 à 3) de ce mode sur ce titre. */
  rep?: number;
  /** La lecture avant le premier parcours (ms) ; absente : `PLAY_BEFORE_TOURS_MS`. */
  playBeforeMs?: number;
  /** La lecture après chaque saut d'un parcours (ms) ; absente : 4 s. */
  dwellMs?: number;
  /**
   * Un seul changement de piste, vers une piste d'une autre langue s'il y en a une (étape 3f) — à la place du tour de
   * toutes les pistes : la question est « le changement marche-t-il encore », pas « chaque piste se joue-t-elle ».
   */
  audioSwitch?: boolean;
}

/** Lecture avant le premier parcours : de quoi voir le démarrage, et le premier segment suivant. */
export const PLAY_BEFORE_TOURS_MS = 10_000;
/** La lecture après chaque saut d'un parcours, par défaut : de quoi voir un gel et ce que Safari demande ensuite. */
export const DWELL_AFTER_SEEK_MS = 4_000;
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

type TrialOptions = Partial<Pick<Trial, "startAt" | "tours" | "audioTour" | "prepareOnly" | "targetS" | "modes" | "rep" | "playBeforeMs" | "dwellMs" | "audioSwitch">>;

function trial(key: string, player: PlayerKind, options: TrialOptions = {}): Trial {
  const p = preset(key);
  const targetS = options.targetS ?? DEFAULT_TARGET_S;
  const tag = modeTag(options.modes);
  return {
    id: options.prepareOnly ? `${p.key}-preparer` : `${p.key}-${player}${targetS !== DEFAULT_TARGET_S ? `-t${targetS}` : ""}${tag ? `-${tag}` : ""}${options.rep ? `-r${options.rep}` : ""}`,
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
    ...(options.modes ? { modes: options.modes } : {}),
    ...(options.rep ? { rep: options.rep } : {}),
    ...(options.playBeforeMs !== undefined ? { playBeforeMs: options.playBeforeMs } : {}),
    ...(options.dwellMs !== undefined ? { dwellMs: options.dwellMs } : {}),
    ...(options.audioSwitch ? { audioSwitch: true } : {}),
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

/** Les essais du lecteur actuel d'une série : un par titre joué par le serveur selon la règle (ni cible d'essai, ni levier). */
const currentOf = (server: Trial[]) => server.filter((t) => !t.prepareOnly && t.targetS === DEFAULT_TARGET_S && !t.modes).map(current);

export const SERIES: Trial[] = [...FULL_SERVER, ...currentOf(FULL_SERVER)];

/**
 * Le comparatif rapide, ~13 minutes : un H.264 (*À la Maison Blanche*), un HEVC à IDR seules (*Black Monday*), un HEVC
 * à GOP ouvert (*Ghosted*, DV 4K Atmos), un DV 4K à trois Atmos (*Ted Lasso*) ; 10 sauts chacun, sans tour des pistes,
 * chaque titre par les deux lecteurs. Depuis l'étape 3e, les deux leviers de démarrage sur les deux titres où
 * l'écart de première image était le plus grand (*Ghosted* 1,26 contre 0,29 s, *Ted Lasso* 1,12 contre 0,35 s) :
 * le son multiplexé (a, 5 sauts) et la préparation précoce (b, 3 sauts). La cible de 2 s de *Black Monday* en est
 * sortie : elle a répondu (1,55 s de reprise contre 1,51 s, comparatif du 16/11) et reste dans la série complète.
 */
const QUICK_SERVER: Trial[] = [
  trial("maison-blanche", "serveur"),
  trial("black-monday", "serveur"),
  trial("ghosted", "serveur"),
  trial("ted-lasso", "serveur"),
  trial("ghosted", "serveur", { modes: { mux: true }, tours: [5] }),
  trial("ted-lasso", "serveur", { modes: { mux: true }, tours: [5] }),
  trial("ghosted", "serveur", { modes: { early: "serveur" }, tours: [3] }),
  trial("ted-lasso", "serveur", { modes: { early: "serveur" }, tours: [3] }),
];

export const QUICK_SERIES: Trial[] = [...QUICK_SERVER, ...currentOf(QUICK_SERVER)];

/**
 * Les leviers de démarrage (étape 3e), ~10 minutes, Lumen serveur seul : chaque levier à côté d'un essai témoin de la
 * règle sur le même titre, dans la même passe (même réseau, même heure).
 * - témoins : *Black Monday*, *Ghosted*, *Ted Lasso* (5 sauts) ;
 * - (c) le départ à 600 s — une reprise — par saut après le chargement (la règle d'aujourd'hui), par `EXT-X-START`
 *   et par `#t=`, sur *Black Monday* (HEVC 4K à IDR) et *Ghosted* (GOP ouvert) ;
 * - (b) la fiche ouverte 5 s avant Lire (préparation serveur et source posée avec `preload="auto"`) ;
 * - (d) le BANDWIDTH annoncé au débit moyen ;
 * - (a) le son multiplexé sur un H.264 à son stéréo (*À la Maison Blanche*), le cas le plus simple.
 */
export const LEVER_SERIES: Trial[] = [
  trial("black-monday", "serveur", { tours: [5] }),
  trial("ghosted", "serveur", { tours: [5] }),
  trial("ted-lasso", "serveur", { tours: [5] }),
  ...(["saut", "ext-x-start", "fragment"] as const).flatMap((startMode) => [
    trial("black-monday", "serveur", { startAt: 600, modes: { startMode }, tours: [3] }),
    trial("ghosted", "serveur", { startAt: 600, modes: { startMode }, tours: [3] }),
  ]),
  trial("ghosted", "serveur", { modes: { early: "élément" }, tours: [3] }),
  trial("ted-lasso", "serveur", { modes: { early: "élément" }, tours: [3] }),
  trial("black-monday", "serveur", { modes: { bandwidth: "moyen" }, tours: [5] }),
  trial("ghosted", "serveur", { modes: { bandwidth: "moyen" }, tours: [5] }),
  trial("maison-blanche", "serveur", { modes: { mux: true }, tours: [5] }),
];

/**
 * La passe « son multiplexé » (étape 3f) : quatre titres variés, chacun joué **trois fois sans et trois fois avec** le
 * son par défaut multiplexé dans les segments vidéo (`mux`, levier a de l'étape 3e), en alternance A-B-B-A-A-B.
 *
 * Pourquoi cette forme. La passe « leviers » du 16/11 n'avait essayé le levier qu'une fois (*À la Maison Blanche* :
 * image 0,48 s, reprise 1,25 s), sans témoin sur le même titre, et le débit de l'iPhone y a varié de 23 à 100 Mb/s
 * d'un essai à l'autre : rien de concluant. Ici :
 * - **les titres** (recensement de l'étape 3b et titres de la page) : un H.264 1080p à son stéréo (*À la Maison
 *   Blanche*), un HEVC 1080p à son 5.1 (*Notting Hill* — le multicanal multiplexé est ce qu'Apple interdit en 9.6), un
 *   4K Dolby Vision à E-AC-3 Atmos (*Ghosted*, ~53 Mb/s en moyenne), un HEVC 1080p à GOP ouvert sans Dolby Vision
 *   (*Pearl Harbor*, 132 CRA à RASL vues). Chacun a deux pistes de langues différentes : le changement de piste
 *   s'entend ;
 * - **l'alternance** A-B-B-A-A-B neutralise une dérive linéaire du réseau (même rang moyen pour les deux modes à un
 *   demi-essai près). Les titres de rang pair la jouent en miroir (B-A-A-B-B-A) : le premier essai d'un titre est le
 *   seul à lire ses positions sur un disque froid (aucun segment n'est gardé par le serveur, seul le cache de pages
 *   les garde), et ce désavantage tombe ainsi deux fois sur chaque mode, plutôt que quatre fois sur la règle ;
 * - **les mêmes sauts partout** : six positions par titre, tirées de la graine de la série et du titre
 *   (`seekPositions(seed, key, 0, …)`) — les six essais d'un titre les demandent toutes, dans le même ordre ; c'est ce
 *   qui permet la comparaison position par position (`muxPass.ts`) ;
 * - **la durée** (~18 minutes estimées, ~17 réelles) : 3 s de lecture avant le parcours, 6 sauts suivis de 3 s de lecture (au lieu de 10 s
 *   et 4 s : la passe compare deux modes l'un à l'autre, pas à un banc d'avant), un changement de piste dans chaque
 *   essai multiplexé (6 s observées) et dans le premier essai témoin de chaque titre — la référence de ce que coûte un
 *   changement de rendu à rendu.
 */
export const MUX_TITLES = ["maison-blanche", "notting-hill", "ghosted", "pearl-harbor"] as const;
/** L'alternance des modes sur un titre : A la règle (groupes son séparés), B le son multiplexé. */
export const MUX_PATTERN = ["A", "B", "B", "A", "A", "B"] as const;
export const MUX_SEEKS = 6;
export const MUX_PLAY_BEFORE_MS = 3_000;
export const MUX_DWELL_MS = 3_000;
/** La fenêtre d'un changement de piste de la passe : reprise, `waiting`, erreurs, gels, et les segments de la nouvelle piste. */
export const MUX_SWITCH_WATCH_MS = 6_000;

export const MUX_SERIES: Trial[] = MUX_TITLES.flatMap((key, titleIndex) => {
  const pattern = titleIndex % 2 === 0 ? MUX_PATTERN : MUX_PATTERN.map((m) => (m === "A" ? "B" : "A"));
  const seen = { A: 0, B: 0 };
  return pattern.map((m) => {
    const rep = ++seen[m];
    const mux = m === "B";
    return trial(key, "serveur", {
      tours: [MUX_SEEKS],
      rep,
      playBeforeMs: MUX_PLAY_BEFORE_MS,
      dwellMs: MUX_DWELL_MS,
      // Chaque essai multiplexé change de piste une fois ; la règle, une fois par titre (sa première répétition).
      audioSwitch: mux || rep === 1,
      ...(mux ? { modes: { mux: true } } : {}),
    });
  });
});

/**
 * Le plan d'une passe dans l'ordre demandé. `actuel` : les essais du lecteur actuel d'abord, puis ceux du serveur, le
 * premier marqué `reloadBefore` — la page se recharge là (WebKit refuse un HLS natif après une MediaSource). Une passe
 * sans lecteur actuel (les leviers) n'a qu'un ordre.
 */
export function planOf(pass: SeriesPass, order: SeriesOrder = "serveur"): Trial[] {
  const plan = pass === "courte" ? QUICK_SERIES : pass === "leviers" ? LEVER_SERIES : pass === "multiplexé" ? MUX_SERIES : SERIES;
  if (order === "serveur" || !plan.some((t) => t.player === "actuel")) return plan;
  const currentFirst = plan.filter((t) => t.player === "actuel");
  const server = plan.filter((t) => t.player === "serveur");
  return [...currentFirst, ...server.map((t, i) => (i === 0 ? { ...t, reloadBefore: true } : t))];
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
  // La chronologie (étape 3e) : cinq échanges d'horloge, un échantillon de débit, la relecture du relevé — ~2 s.
  const chrono = 2;
  const early = t.modes?.early ? EARLY_DELAY_MS / 1000 : 0;
  const play = (t.playBeforeMs ?? PLAY_BEFORE_TOURS_MS) / 1000;
  const dwell = (t.dwellMs ?? DWELL_AFTER_SEEK_MS) / 1000;
  const switches = t.audioTour ? 3 * (AUDIO_SWITCH_WATCH_MS / 1000 + 1) : t.audioSwitch ? MUX_SWITCH_WATCH_MS / 1000 + 1 : 0;
  return 3 + 5 + chrono + early + play + seeks * (1.5 + dwell) + switches;
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
  /** La première image à la position de départ demandée (±2 s) : différente de la première image pour un départ en milieu de film. */
  targetFrameMs?: number;
  /** La chronologie de l'essai résumée (étape 3e), et le débit mesuré par la page avant la lecture. */
  chrono?: ChronoSummary;
  linkMbps?: number;
  seeks: { ok?: boolean; seekedMs?: number; advanceMs?: number }[];
  freezes: Freeze[];
  errors: string[];
  waits: number;
  quality?: Quality;
  audioSwitches: { ms?: number; waited: boolean; errors?: number; freezes?: number; applied?: boolean; segs?: number }[];
  /** La piste entendue au départ contre celle que la liste maître désigne (étape 3f, `muxPass.ts`). */
  audioCheck?: AudioCheck;
  /** Le débit moyen annoncé par la liste maître (AVERAGE-BANDWIDTH de la variante lue, Mb/s). */
  streamMbps?: number;
}

/**
 * La piste audio entendue au départ (étape 3f) : `want` — le rendu DEFAULT du groupe de la variante en tête de la liste
 * maître (`LANGUAGE:NAME`), celui qu'AVFoundation doit ouvrir ; `got` — la piste allumée dans `video.audioTracks`. `ok`
 * absent : pas de quoi juger (liste maître illisible, `audioTracks` non exposé).
 */
export interface AudioCheck {
  ok?: boolean;
  want?: string;
  got?: string;
  /** Les pistes que `audioTracks` annonce (`langue:étiquette`), dans l'ordre : identiques d'un mode à l'autre ? */
  tracks?: string[];
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
  /** Les leviers de l'essai (`modeTag`), absents pour la règle. */
  mode?: string;
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
  targetFrameMs?: number;
  /** La chronologie résumée (étape 3e) : réserve à la reprise, première requête, segment prêt, débit du lien. */
  chrono?: ChronoSummary;
  linkMbps?: number;
  /** La passe « son multiplexé » (étape 3f) : la répétition, et la reprise de chaque saut dans l'ordre (null : manqué). */
  rep?: number;
  advances?: (number | null)[];
  audioCheck?: AudioCheck;
  /** Le changement de piste de l'essai (le premier), réduit : reprise, blocage, erreurs, gels, appliqué, segments reçus. */
  audioSwitch?: { ms?: number; waited: boolean; errors: number; freezes: number; applied?: boolean; segs?: number };
  streamMbps?: number;
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
    ...(t.modes ? { mode: modeTag(t.modes) } : {}),
    ...(t.rep ? { rep: t.rep } : {}),
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
    ...(measures.targetFrameMs !== undefined && measures.targetFrameMs !== measures.firstFrameMs ? { targetFrameMs: measures.targetFrameMs } : {}),
    ...(measures.chrono && Object.keys(measures.chrono).length ? { chrono: measures.chrono } : {}),
    ...(measures.linkMbps !== undefined ? { linkMbps: measures.linkMbps } : {}),
    ...(t.rep ? { advances: measures.seeks.map((s) => (s.ok && typeof s.advanceMs === "number" ? s.advanceMs : null)) } : {}),
    ...(measures.audioCheck ? { audioCheck: measures.audioCheck } : {}),
    ...(t.audioSwitch && switches[0]
      ? {
          audioSwitch: {
            ms: switches[0].ms,
            waited: switches[0].waited,
            errors: switches[0].errors ?? 0,
            freezes: switches[0].freezes ?? 0,
            ...(switches[0].applied !== undefined ? { applied: switches[0].applied } : {}),
            ...(switches[0].segs !== undefined ? { segs: switches[0].segs } : {}),
          },
        }
      : {}),
    ...(measures.streamMbps !== undefined ? { streamMbps: measures.streamMbps } : {}),
  };
}

/** La chronologie d'un essai en une ligne d'écran : où le temps est passé, médianes des sauts. */
export function formatChrono(r: Pick<TrialResult, "chrono" | "linkMbps">): string | null {
  const c = r.chrono;
  const parts = [
    r.linkMbps !== undefined ? `lien ${r.linkMbps} Mb/s` : null,
    c?.firstReqMs !== undefined ? `1re requête +${c.firstReqMs} ms` : null,
    c?.firstVideoReadyMs !== undefined ? `segment prêt +${c.firstVideoReadyMs} ms` : null,
    c?.seekedToAdvanceMs !== undefined ? `seeked→reprise ${c.seekedToAdvanceMs} ms` : null,
    c?.aheadSeekedS !== undefined ? `avance à seeked ${c.aheadSeekedS} s` : null,
    c?.aheadAdvanceS !== undefined ? `à la reprise ${c.aheadAdvanceS} s` : null,
    c?.videoAdvance !== undefined ? `${c.videoAdvance} seg. vidéo demandés` : null,
    c?.readyMaxMs !== undefined ? `serveur ≤ ${c.readyMaxMs} ms` : null,
    c?.firstVideoRecvMs !== undefined ? `1er seg. vidéo reçu +${c.firstVideoRecvMs} ms` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** La ligne d'écran d'un essai fini : première image, médiane des sauts, gels, erreurs. */
export function formatResult(r: TrialResult): string {
  const head = `${r.rank}. ${r.title} · ${playerLabel(r)}${r.mode ? ` (${r.mode})` : ""}${r.rep ? ` #${r.rep}` : ""}`;
  if (r.verdicts) return `${head} — ${r.verdicts.join(" ; ")}`;
  if (r.status === "refusé") return `${head} — refusé : ${r.reason ?? "?"}`;
  const parts = [
    r.firstFrameMs !== undefined ? `image ${r.firstFrameMs} ms` : "sans image",
    r.targetFrameMs !== undefined ? `image au départ ${r.targetFrameMs} ms` : null,
    r.seeks
      ? `sauts : image ${r.seekedMedianMs ?? "—"}/${r.seekedP90Ms ?? "—"} ms, reprise ${r.seekMedianMs ?? "—"}/${r.advanceP90Ms ?? "—"} ms (méd./p90)${r.missed ? `, ${r.missed} manqué${r.missed > 1 ? "s" : ""}` : ""}`
      : null,
    `gels ${r.freezes}${r.freezes ? ` (${(r.freezeMs / 1000).toFixed(1)} s)` : ""}`,
    `erreurs ${r.errors}`,
    r.audioSwitches ? `pistes ${r.audioSwitches - (r.audioTrouble ?? 0)}/${r.audioSwitches} nettes` : null,
    r.audioCheck?.ok !== undefined ? `piste au départ ${r.audioCheck.ok ? "la bonne" : `FAUSSE (${r.audioCheck.got ?? "?"} au lieu de ${r.audioCheck.want ?? "?"})`}` : null,
    r.audioSwitch?.applied === false ? "CHANGEMENT DE PISTE NON APPLIQUÉ" : null,
    r.status !== "ok" ? `${r.status.toUpperCase()}${r.reason ? ` : ${r.reason}` : ""}` : null,
    formatChrono(r),
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
  /** Le tour des pistes (`audioTour`), ou le seul changement de piste d'un essai `audioSwitch` (étape 3f). */
  audioTour(): Promise<void>;
  /**
   * Ferme l'essai — la lecture s'il y en a une — et rend sa ligne de résultat. Asynchrone depuis l'étape 3e : la
   * chronologie relit le relevé du serveur avant de dessiner les cascades.
   */
  close(t: Trial, rank: number, outcome: TrialOutcome): TrialResult | Promise<TrialResult>;
  /**
   * L'ordre `actuel` : avant `t` (`reloadBefore`), garder l'état de la série et recharger la page. Ne rend jamais la
   * main dans un navigateur (la page part) ; la série reprend au rang `index` après l'appui de l'administrateur.
   */
  reload?(index: number): Promise<void>;
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
  await d.play(t.playBeforeMs ?? PLAY_BEFORE_TOURS_MS);
  for (let i = 0; i < t.tours.length; i++) {
    if (d.stopped()) return { status: "arrêté" };
    await d.tour(t.tours[i], i);
  }
  if ((t.audioTour || t.audioSwitch) && !d.stopped()) await d.audioTour();
  return { status: d.stopped() ? "arrêté" : "ok" };
}

/**
 * La série : chaque essai dans l'ordre, fermé et envoyé avant le suivant. Un essai qui échoue — refus, pas
 * d'image, exception du pilote — est noté et la série passe : une découpe qui casse Safari sur un titre ne doit
 * pas priver les suivants de leur mesure. « Arrêter » finit l'essai en cours (sa ligne part quand même) et rien
 * après.
 */
export async function runSeries(
  plan: readonly Trial[],
  d: SeriesDriver,
  onResult?: (result: TrialResult) => void,
  options: { from?: number } = {}
): Promise<{ results: TrialResult[]; stopped: boolean }> {
  const results: TrialResult[] = [];
  const from = options.from ?? 0;
  for (let i = from; i < plan.length; i++) {
    if (d.stopped()) break;
    const t = plan[i];
    const rank = i + 1;
    // L'ordre `actuel` : la page se recharge avant le premier essai serveur — sauf si la série reprend justement là.
    if (t.reloadBefore && i !== from && d.reload) {
      await d.reload(i);
      return { results, stopped: d.stopped() };
    }
    d.begin(t, rank);
    let outcome: TrialOutcome;
    try {
      outcome = await runTrial(t, rank, d);
    } catch (error) {
      outcome = { status: d.stopped() ? "arrêté" : "échec", reason: `exception ${errorText(error)}` };
    }
    let result: TrialResult;
    try {
      result = await d.close(t, rank, outcome);
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
  /**
   * La passe « son multiplexé » (étape 3f) : « Quand la piste a changé pendant un essai multiplexé, avez-vous entendu
   * l'autre langue ? » — ce que la page ne sait pas : `audioTracks` peut dire la piste allumée sans que le son suive.
   */
  audioChanged?: "oui" | "parfois" | "non" | "pas-entendu" | null;
  /** « La voix était-elle en phase avec les lèvres ? » — la synchro image-son, que rien ne mesure ici. */
  lipSync?: "oui" | "non-mux" | "non-partout" | "pas-regardé" | null;
}

/** Le marquage d'une ligne d'essai : la série (pour joindre ses lignes), l'essai, son rang, le total, le lecteur. */
export function trialTag(serie: string, t: Trial, rank: number, of: number, meta: { pass: SeriesPass; seed: number; order?: SeriesOrder }) {
  return {
    serie,
    trial: t.id,
    rank,
    of,
    player: t.player,
    pass: meta.pass,
    seed: meta.seed,
    ...(meta.order ? { order: meta.order } : {}),
    ...(t.modes ? { mode: modeTag(t.modes) } : {}),
    ...(t.rep ? { rep: t.rep } : {}),
  };
}

/** Ce qu'une colonne du tableau comparatif garde d'un essai. */
export interface ComparisonCell {
  status: TrialStatus;
  firstFrameMs?: number;
  targetFrameMs?: number;
  chrono?: ChronoSummary;
  linkMbps?: number;
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
  /** Un levier de démarrage (serveur seul, étape 3e) : sa propre ligne. */
  mode?: string;
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
    const id = `${r.key}|${targetS}|${r.mode ?? ""}`;
    const row = rows.get(id) ?? { key: r.key, title: r.title, targetS, ...(r.mode ? { mode: r.mode } : {}) };
    row[r.player] = {
      status: r.status,
      firstFrameMs: r.firstFrameMs,
      targetFrameMs: r.targetFrameMs,
      chrono: r.chrono,
      linkMbps: r.linkMbps,
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
  meta: { elapsedS: number; stopped: boolean; pass: SeriesPass; seed: number; order?: SeriesOrder }
) {
  return {
    auto: { serie, summary: true, of, done: results.length, elapsedS: Math.round(meta.elapsedS), stopped: meta.stopped, pass: meta.pass, seed: meta.seed, ...(meta.order ? { order: meta.order } : {}) },
    trials: results.map((r) => ({ ...r })),
    // La passe « son multiplexé » a son propre tableau (`mux`) : celui des deux lecteurs n'y garderait qu'une répétition.
    comparison: meta.pass === "multiplexé" ? [] : comparisonRows(results),
    answers: {
      damaged: answers.damaged,
      damagedTitle: answers.damaged === "oui" && answers.damagedTitle.trim() ? answers.damagedTitle.trim().slice(0, 120) : undefined,
      audioClean: answers.audioClean,
      ...(meta.pass === "multiplexé" ? { audioChanged: answers.audioChanged ?? null, lipSync: answers.lipSync ?? null } : {}),
    },
    // La passe « son multiplexé » : le verdict par titre, celui de l'écran de fin (`muxPass.ts`).
    ...(meta.pass === "multiplexé" ? { mux: analyzeMux(results) } : {}),
  };
}
