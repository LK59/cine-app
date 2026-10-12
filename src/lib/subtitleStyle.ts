/**
 * L'apparence des sous-titres, une fois pour les deux façons de les dessiner.
 *
 * Il y en a deux, et elles n'ont rien en commun : les pistes natives passent par des `<track>` que
 * seul le pseudo-élément `::cue` peut atteindre, tandis que le lecteur remultiplexé dessine ses
 * lignes lui-même dans un paragraphe. Un réglage qui ne toucherait que l'un des deux serait un
 * réglage qui marche un film sur deux — c'est ce qui était le cas de la taille, qui ne s'appliquait
 * qu'aux pistes natives.
 *
 * Trois réglages, pas dix. La taille, parce que les écrans et les yeux diffèrent ; la couleur,
 * parce que du blanc sur une scène enneigée disparaît ; le fond, parce que l'ombre ne suffit pas
 * toujours et qu'une boîte, elle, suffit toujours.
 */

export type SubtitleColor = "white" | "yellow";
export type SubtitleBackground = "none" | "shadow" | "box";

export interface SubtitleStyle {
  /** Un facteur, pas une taille : la taille de base dépend de la hauteur et de la largeur de l'image. */
  size: number;
  color: SubtitleColor;
  background: SubtitleBackground;
}

export const SUBTITLE_SIZES = [
  { labelKey: "subtitleSizeXSmall", value: 0.6 },
  { labelKey: "subtitleSizeSmall", value: 0.75 },
  { labelKey: "subtitleSizeNormal", value: 1 },
  { labelKey: "subtitleSizeLarge", value: 1.3 },
  { labelKey: "subtitleSizeXLarge", value: 1.6 },
] as const;

export const SUBTITLE_COLORS: SubtitleColor[] = ["white", "yellow"];
export const SUBTITLE_BACKGROUNDS: SubtitleBackground[] = ["shadow", "box", "none"];

/**
 * « Petite » par défaut depuis le 23/09/2026 : « Normale » était jugée trop grosse sur téléphone dès
 * le premier film. Seul le défaut change — une taille déjà choisie est gardée, « Normale » comprise.
 */
export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = { size: 0.75, color: "white", background: "shadow" };

/**
 * La taille du texte : la plus petite de deux mesures, l'une tirée de la hauteur de l'image,
 * l'autre de sa largeur, chacune affine (une part fixe plus une part proportionnelle).
 *
 * Elle suivait la largeur seule (`4 vw`, 12/10/2026 : « trop gros, ils couvrent trop d'image ») :
 * sur un téléphone en paysage, 844 px de large pour 390 de haut, une ligne prenait 6,5 % de la
 * hauteur, deux lignes et leur interligne près d'un sixième de l'image. Les lecteurs de référence
 * (Netflix, Apple TV) règlent la taille sur la hauteur, et en proportion plus petite sur un petit
 * écran — d'où la part fixe : 37 px sur 1080 de haut (3,4 %), 17,5 px sur 390 (4,5 %, encore
 * lisible) avec une droite. La hauteur seule ferait d'un téléphone en portrait (844 de haut, 390 de
 * large) un écran de bureau, avec quinze caractères par ligne : la largeur le borne, réglée pour
 * donner 14 px sur 390 de large et laisser le reste à la hauteur (sauf l'iPad, 27,5 px au lieu de
 * 29,5). Valeurs à « Petite » (0,75, le défaut) ; les autres tailles gardent leurs proportions,
 * puisque le facteur multiplie tout.
 */
export const SUBTITLE_FONT = {
  /** px fixes + % de la hauteur, avant le facteur de taille. */
  height: { px: 8.6, percent: 3.77 },
  /** px fixes + % de la largeur, avant le facteur de taille. */
  width: { px: 9.8, percent: 2.28 },
  /**
   * Plancher et plafond, eux aussi multipliés par le facteur (plancher absolu : 8 px). Le plancher
   * ne sert qu'aux tout petits écrans (moins de 320 px de large) : partout ailleurs la règle donne plus.
   */
  floor: 13,
  cap: 64,
} as const;

function floorPx(size: number): number {
  return Math.max(8, Math.round(SUBTITLE_FONT.floor * size));
}
function capPx(size: number): number {
  return Math.round(SUBTITLE_FONT.cap * size);
}

/**
 * La même règle en pixels, pour une zone donnée — ce que la CSS ci-dessous calcule dans le
 * navigateur. Sert aux tests et à qui veut raisonner sur un écran sans en avoir un.
 */
export function subtitleFontPx(size: number, width: number, height: number): number {
  const { height: h, width: w } = SUBTITLE_FONT;
  const byHeight = size * (h.px + (h.percent / 100) * height);
  const byWidth = size * (w.px + (w.percent / 100) * width);
  return Math.min(capPx(size), Math.max(floorPx(size), Math.min(byHeight, byWidth)));
}

/**
 * La taille du texte en CSS, pour les deux façons de le dessiner.
 *
 * `units` dit à quoi se mesurent hauteur et largeur. Le calque du lecteur natif se mesure à sa
 * propre zone (`cqh`/`cqw`, il est un conteneur de taille) : c'est l'écran du film, pas la
 * fenêtre — la même chose en plein écran, mais pas dans une fenêtre de navigateur entourée d'autre
 * chose. `::cue` vit dans l'arbre fantôme de l'élément vidéo, où l'on ne sait pas à quel conteneur
 * une unité de requête se rapporterait : il se mesure à la fenêtre, que le lecteur serveur remplit.
 *
 * Le plancher suit le facteur. Il était fixé à 14 px pour toutes les tailles, et sur un téléphone
 * en portrait « Petite » tombait dessus : elle s'affichait presque comme « Normale ».
 */
function fontSize(size: number, units: "container" | "viewport"): string {
  const [vh, vw] = units === "container" ? ["cqh", "cqw"] : ["vh", "vw"];
  const { height: h, width: w } = SUBTITLE_FONT;
  const byHeight = `calc(${size} * (${h.px}px + ${h.percent}${vh}))`;
  const byWidth = `calc(${size} * (${w.px}px + ${w.percent}${vw}))`;
  return `clamp(${floorPx(size)}px, min(${byHeight}, ${byWidth}), ${capPx(size)}px)`;
}

const HEX: Record<SubtitleColor, string> = { white: "#ffffff", yellow: "#f2e14c" };

/** L'ombre portée : deux passes, une large pour décoller du fond, une serrée pour le contour. */
const SHADOW = "0 2px 6px rgba(0,0,0,0.9), 0 0 2px rgba(0,0,0,1)";

/**
 * La règle CSS des pistes natives.
 *
 * Elle vise tous les `<video>` et pas celui-ci en particulier : `::cue` n'est pas un élément réel,
 * aucun style en ligne ne peut l'atteindre, et l'application n'a de toute façon jamais qu'une
 * vidéo active à la fois.
 */
export function cueCss(style: SubtitleStyle): string {
  const parts = [
    `font-size: ${fontSize(style.size, "viewport")}`,
    `color: ${HEX[style.color]}`,
    // `::cue` a un fond noir par défaut : le retirer explicitement est ce qui rend l'ombre seule
    // possible, et l'oublier laisserait la boîte du navigateur sous notre propre traitement.
    `background-color: ${style.background === "box" ? "rgba(0,0,0,0.72)" : "transparent"}`,
    `text-shadow: ${style.background === "box" ? "none" : SHADOW}`,
  ];
  return `video::cue { ${parts.join("; ")}; }`;
}

/** Les mêmes réglages, en style en ligne, pour les lignes que le lecteur dessine lui-même. */
export function overlayCss(style: SubtitleStyle): React.CSSProperties {
  return {
    // Mesuré à la zone du calque, qui doit donc être un conteneur de taille — voir `SUBTITLE_LAYER_STYLE`.
    fontSize: fontSize(style.size, "container"),
    color: HEX[style.color],
    textShadow: style.background === "box" ? "none" : SHADOW,
    backgroundColor: style.background === "box" ? "rgba(0,0,0,0.72)" : undefined,
    // Un peu d'air autour du texte, seulement quand il y a une boîte à remplir.
    padding: style.background === "box" ? "0.15em 0.5em" : undefined,
    borderRadius: style.background === "box" ? "0.25rem" : undefined,
    // La boîte épouse le texte plutôt que la largeur de la ligne, sinon deux lignes de longueurs
    // différentes donnent un rectangle qui déborde de la plus courte.
    boxDecorationBreak: style.background === "box" ? "clone" : undefined,
    WebkitBoxDecorationBreak: style.background === "box" ? "clone" : undefined,
  } as React.CSSProperties;
}

/**
 * Où se pose le calque du lecteur natif, et de combien il s'écarte des commandes.
 *
 * Il était à 96 px du bas (`bottom-24`) quoi qu'il arrive : un quart de la hauteur d'un téléphone en
 * paysage, et toujours aussi haut une fois les commandes parties (12/10/2026). Désormais la ligne
 * repose à 6,5 % de la hauteur (Netflix et l'Apple TV sont entre 6 et 8 %), jamais à moins de
 * 12 px, plus la zone sûre — et ne monte que pour passer au-dessus des commandes quand elles sont
 * là, de la hauteur exacte qu'elles occupent (`ChromeEdges`, mesurée par `PlayerControls`) et pas
 * d'une constante qui vaudrait pour un écran sur trois. Un sous-titre placé en haut (`{\an8}`) fait
 * la même chose de l'autre côté, sous la rangée du haut.
 *
 * Le déplacement est un `transform` seul (`.subtitle-lift`, globals.css) : il suit le fondu des
 * commandes sans relancer de mise en page à chaque image.
 */
export const SUBTITLE_REST = { percent: 6.5, minPx: 12 } as const;

/** Les bords des commandes affichées, en px depuis le haut et depuis le bas de l'écran. */
export interface ChromeEdges {
  top: number;
  bottom: number;
}

/** Le style du calque : un conteneur de taille, pour que `cqh`/`cqw` se mesurent à lui. */
export const SUBTITLE_LAYER_STYLE: React.CSSProperties = { containerType: "size" };

function restCss(edge: "top" | "bottom"): string {
  return `calc(max(${SUBTITLE_REST.minPx}px, ${SUBTITLE_REST.percent}cqh) + env(safe-area-inset-${edge}, 0px))`;
}

/**
 * Le style de la rangée qui porte les lignes, à l'intérieur du calque. `chrome` absent : commandes
 * cachées, la ligne repose. Présent : elle s'en écarte, si elle ne l'est pas déjà.
 */
export function subtitleRowStyle(top: boolean, chrome: ChromeEdges | null): React.CSSProperties {
  const rest = restCss(top ? "top" : "bottom");
  const edge = chrome ? (top ? chrome.top : chrome.bottom) : 0;
  const lift = chrome ? `max(0px, ${Math.round(edge)}px - ${rest})` : "0px";
  return {
    [top ? "top" : "bottom"]: rest,
    transform: `translateY(${top ? lift : `calc(-1 * ${lift})`})`,
  };
}

/**
 * Le même calcul en pixels — ce que donne `subtitleRowStyle` sur un écran de cette hauteur. Pour
 * les tests : la distance entre le bas (ou le haut) de l'écran et la ligne la plus proche.
 */
export function subtitleOffsetPx(height: number, chromeEdge: number | null, safeArea = 0): number {
  const rest = Math.max(SUBTITLE_REST.minPx, (SUBTITLE_REST.percent / 100) * height) + safeArea;
  return chromeEdge === null ? rest : Math.max(rest, chromeEdge);
}

const STORAGE_KEY = "cine:subtitle-style";
/** L'ancienne clé, qui ne portait que la taille. Relue une fois pour ne rien perdre. */
const LEGACY_SIZE_KEY = "cine:subtitle-size";

function read(): SubtitleStyle {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SubtitleStyle>;
      return {
        size: SUBTITLE_SIZES.some((s) => s.value === parsed.size) ? parsed.size! : DEFAULT_SUBTITLE_STYLE.size,
        color: SUBTITLE_COLORS.includes(parsed.color as SubtitleColor) ? parsed.color! : DEFAULT_SUBTITLE_STYLE.color,
        background: SUBTITLE_BACKGROUNDS.includes(parsed.background as SubtitleBackground)
          ? parsed.background!
          : DEFAULT_SUBTITLE_STYLE.background,
      };
    }
    // Quelqu'un qui avait déjà réglé sa taille la garde : c'est le seul réglage qui existait.
    const legacy = Number(window.localStorage.getItem(LEGACY_SIZE_KEY));
    if (SUBTITLE_SIZES.some((s) => s.value === legacy)) return { ...DEFAULT_SUBTITLE_STYLE, size: legacy };
  } catch {
    // Stockage indisponible : les valeurs par défaut.
  }
  return DEFAULT_SUBTITLE_STYLE;
}

/**
 * Lu par `useSyncExternalStore` : la valeur vit dans le stockage local, qui n'existe pas sur le
 * serveur, et deux lecteurs — les commandes et l'hôte du lecteur — doivent voir le même
 * changement au même moment.
 */
let cached: SubtitleStyle | null = null;
const listeners = new Set<() => void>();

export const subtitleStyleStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot(): SubtitleStyle {
    if (!cached) cached = read();
    return cached;
  },
  serverSnapshot: (): SubtitleStyle => DEFAULT_SUBTITLE_STYLE,
  set(patch: Partial<SubtitleStyle>): void {
    cached = { ...subtitleStyleStore.snapshot(), ...patch };
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
    } catch {
      // Voir `read` : le réglage vaut pour cette session, et c'est déjà mieux que rien.
    }
    for (const listener of listeners) listener();
  },
};
