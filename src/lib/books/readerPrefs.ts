/**
 * Les réglages du lecteur de livres (DECISIONS.md §127) : la page qui tourne, la police, sa taille,
 * l'interligne, les marges, la justification, le thème, la lumière. Gardés **par appareil**
 * (`localStorage`) et non par compte : on ne lit pas de la même façon sur un téléphone le soir et sur
 * un grand écran. Chaque accès est gardé — une navigation privée ou un stockage bloqué rendent
 * simplement les valeurs par défaut.
 */

export type ReaderTheme = "auto" | "light" | "sepia" | "dark" | "black";
export type ReaderMargin = "small" | "medium" | "large";
export type ReaderFont = "book" | "literata" | "georgia" | "outfit" | "system";
/** Comment la page tourne. `scroll` n'est pas une animation : le livre se lit en continu, de haut en bas. */
export type ReaderTurn = "none" | "slide" | "fade" | "flip" | "scroll";
/**
 * Les pages : `auto`, deux côte à côte quand l'écran est large et couché (le choix de foliate-js) ;
 * `single`, une seule colonne de largeur de lecture, centrée, même sur un grand écran ; `double`,
 * deux dès que deux colonnes de lecture tiennent — un iPad couché, une fenêtre moyenne.
 */
export type ReaderLayout = "auto" | "single" | "double";

export interface ReaderPrefs {
  turn: ReaderTurn;
  font: ReaderFont;
  /** En pour cent de la taille prévue par le livre. */
  fontSize: number;
  lineHeight: number;
  margin: ReaderMargin;
  justify: boolean;
  theme: ReaderTheme;
  layout: ReaderLayout;
  /** De 0,4 (sombre) à 1 (pleine lumière) : un voile posé sur la page, pas la luminosité de l'écran. */
  brightness: number;
  /** De 0 (neutre) à 1 (chaud) : un voile ambré pour lire le soir. */
  warmth: number;
  /**
   * « Tourner les pages en touchant les bords » : coupé, un toucher ne tourne jamais la page (glisser, le
   * clavier et la molette, si) et montre ou cache les barres, où qu'il tombe.
   */
  tapTurns: boolean;
}

export const READER_PREFS_KEY = "laterna:books:reader";

// Un pas pour tout ce qui change la taille : le curseur, les deux « A », le clavier, le pincement.
export const FONT_SIZE_RANGE = { min: 70, max: 200, step: 10 } as const;
export const LINE_HEIGHT_RANGE = { min: 1.1, max: 2.1, step: 0.05 } as const;
export const MARGINS: readonly ReaderMargin[] = ["small", "medium", "large"];
export const THEMES: readonly ReaderTheme[] = ["auto", "light", "sepia", "dark", "black"];
export const FONTS: readonly ReaderFont[] = ["book", "literata", "georgia", "outfit", "system"];
export const TURNS: readonly ReaderTurn[] = ["slide", "fade", "flip", "none", "scroll"];
export const LAYOUTS: readonly ReaderLayout[] = ["auto", "single", "double"];

/** Les réglages d'un appareil qui n'a rien choisi : une page qui glisse, ou un fondu si le système demande moins de mouvement. */
export function defaultReaderPrefs(reducedMotion = false): ReaderPrefs {
  return {
    turn: reducedMotion ? "fade" : "slide",
    font: "book",
    fontSize: 100,
    lineHeight: 1.5,
    margin: "medium",
    // Pas justifié par défaut : sur une colonne de téléphone, sans césure (qui dépend de la langue
    // déclarée et du système), un texte justifié ouvre de grands blancs entre les mots.
    justify: false,
    theme: "auto",
    layout: "auto",
    brightness: 1,
    warmth: 0,
    tapTurns: true,
  };
}

/** Les zones d'un toucher sur la page : 30 % à gauche, 40 % au centre, 30 % à droite. */
export const TAP_EDGE = 0.3;

/**
 * Ce que fait un toucher sur la page (hors lien) : tourner vers la gauche ou la droite sur un bord, sinon
 * montrer ou cacher les barres. Réglage coupé, toujours les barres.
 */
export function tapAction(x: number, width: number, tapTurns: boolean, chromeShown: boolean): "left" | "right" | "hide" | "show" {
  if (tapTurns && x < width * TAP_EDGE) return "left";
  if (tapTurns && x > width * (1 - TAP_EDGE)) return "right";
  return chromeShown ? "hide" : "show";
}

/** Les couleurs de chaque thème — le fond autour du livre et les barres du lecteur prennent les mêmes. */
export const THEME_COLORS: Record<Exclude<ReaderTheme, "auto">, { bg: string; fg: string; link: string; dark: boolean }> = {
  light: { bg: "#fbfbf9", fg: "#1c1c1e", link: "#2b5797", dark: false },
  sepia: { bg: "#f3e9d2", fg: "#4f3b2a", link: "#7a4b1e", dark: false },
  dark: { bg: "#1c1c1f", fg: "#d9d7d2", link: "#9fb7e0", dark: true },
  // Le noir pur des écrans OLED : les pixels s'éteignent, et le texte est un peu moins blanc pour ne pas éblouir.
  black: { bg: "#000000", fg: "#bdbab4", link: "#8fa8d4", dark: true },
};

/** Le thème réellement appliqué : `auto` suit le système. */
export function resolvedTheme(theme: ReaderTheme, systemDark: boolean): Exclude<ReaderTheme, "auto"> {
  if (theme !== "auto") return theme;
  return systemDark ? "dark" : "light";
}

/**
 * Ce que la marge veut dire pour le paginateur de foliate-js : la marge haute et basse (`margin`),
 * l'écart entre colonnes (`gap`, qui fait aussi les bords gauche et droit), et la largeur de ligne au-delà
 * de laquelle le texte passe sur deux colonnes.
 */
export const MARGIN_LAYOUT: Record<ReaderMargin, { margin: string; gap: string; maxInlineSize: string }> = {
  small: { margin: "40px", gap: "4%", maxInlineSize: "760px" },
  medium: { margin: "56px", gap: "7%", maxInlineSize: "680px" },
  large: { margin: "72px", gap: "11%", maxInlineSize: "600px" },
};

/** La pile de chaque police ; `book` n'en impose aucune. Literata et Outfit sont servies par l'application. */
export const FONT_STACKS: Record<Exclude<ReaderFont, "book">, string> = {
  literata: `"Laterna Literata", Georgia, serif`,
  georgia: `Georgia, "Iowan Old Style", "Palatino Linotype", Palatino, serif`,
  outfit: `"Laterna Outfit", system-ui, sans-serif`,
  system: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`,
};

function clamp(value: unknown, min: number, max: number, step: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const stepped = Math.round((value - min) / step) * step + min;
  return Math.min(max, Math.max(min, Math.round(stepped * 100) / 100));
}

/** Une taille de texte ramenée aux bornes et au pas du curseur — celle que le geste de zoom écrit aussi. */
export function clampFontSize(value: number): number {
  return clamp(value, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max, FONT_SIZE_RANGE.step, 100);
}

/** La taille après un geste de zoom d'un facteur `ratio` (pincement, Ctrl/⌘ + molette) : bornée et au pas du curseur. */
export function zoomedFontSize(base: number, ratio: number): number {
  return clampFontSize(Number.isFinite(ratio) && ratio > 0 ? base * ratio : base);
}

function oneOf<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return values.includes(value as T) ? (value as T) : fallback;
}

/** Une valeur relue du stockage, ramenée aux choix possibles — un ancien format ou une valeur forgée ne passe pas. */
export function normalizeReaderPrefs(raw: unknown, reducedMotion = false): ReaderPrefs {
  const d = defaultReaderPrefs(reducedMotion);
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    turn: oneOf(TURNS, o.turn, d.turn),
    font: oneOf(FONTS, o.font, d.font),
    fontSize: clamp(o.fontSize, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max, FONT_SIZE_RANGE.step, d.fontSize),
    lineHeight: clamp(o.lineHeight, LINE_HEIGHT_RANGE.min, LINE_HEIGHT_RANGE.max, LINE_HEIGHT_RANGE.step, d.lineHeight),
    margin: oneOf(MARGINS, o.margin, d.margin),
    justify: typeof o.justify === "boolean" ? o.justify : d.justify,
    theme: oneOf(THEMES, o.theme, d.theme),
    // `spread: false` : l'interrupteur « deux pages » des premiers essais, devenu « une page ».
    layout: oneOf(LAYOUTS, o.layout, o.spread === false ? "single" : d.layout),
    brightness: clamp(o.brightness, 0.4, 1, 0.05, d.brightness),
    warmth: clamp(o.warmth, 0, 1, 0.05, d.warmth),
    tapTurns: typeof o.tapTurns === "boolean" ? o.tapTurns : d.tapTurns,
  };
}

export function loadReaderPrefs(reducedMotion = false): ReaderPrefs {
  try {
    const raw = localStorage.getItem(READER_PREFS_KEY);
    return raw ? normalizeReaderPrefs(JSON.parse(raw), reducedMotion) : defaultReaderPrefs(reducedMotion);
  } catch {
    return defaultReaderPrefs(reducedMotion);
  }
}

export function saveReaderPrefs(prefs: ReaderPrefs): void {
  try {
    localStorage.setItem(READER_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* stockage plein ou refusé : le réglage vaut pour cette lecture seulement */
  }
}

/**
 * Les deux polices servies par l'application, déclarées dans chaque chapitre : un chapitre est un
 * document à part (`blob:`), qui ne voit pas les polices de la page. Adresses absolues pour la même
 * raison — relatives à un `blob:`, elles ne mèneraient nulle part. Noms préfixés : un livre qui
 * déclare sa propre « Literata » garde la sienne.
 */
export function readerFontFaces(origin: string): string {
  const face = (family: string, file: string, range: string, style = "normal", weight = "200 900") =>
    `@font-face{font-family:"${family}";font-style:${style};font-weight:${weight};font-display:swap;src:url("${origin}/books/fonts/${file}") format("woff2");unicode-range:${range};}`;
  const LATIN = "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
  const LATIN_EXT = "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF";
  return [
    face("Laterna Literata", "literata-latin.woff2", LATIN),
    face("Laterna Literata", "literata-latin-ext.woff2", LATIN_EXT),
    face("Laterna Literata", "literata-latin-italic.woff2", LATIN, "italic"),
    face("Laterna Literata", "literata-latin-ext-italic.woff2", LATIN_EXT, "italic"),
    face("Laterna Outfit", "outfit-latin.woff2", LATIN, "normal", "100 900"),
    face("Laterna Outfit", "outfit-latin-ext.woff2", LATIN_EXT, "normal", "100 900"),
  ].join("\n");
}

/**
 * La feuille de style posée sur chaque chapitre. `!important` sur les couleurs, l'interligne, la
 * police et la justification : beaucoup d'EPUB fixent les leurs, et le thème sombre n'aurait servi à
 * rien sur un texte noir. La taille est relative (`%` sur la racine) : les titres et les notes du livre
 * gardent leurs proportions. Les images ne sont jamais recolorées.
 */
export function readerCss(prefs: ReaderPrefs, systemDark: boolean, origin: string): string {
  const theme = resolvedTheme(prefs.theme, systemDark);
  const { bg, fg, link, dark } = THEME_COLORS[theme];
  const font = prefs.font === "book" ? "" : `font-family: ${FONT_STACKS[prefs.font]} !important;`;
  const align = prefs.justify ? "justify" : "start";
  return `
    ${prefs.font === "literata" || prefs.font === "outfit" ? readerFontFaces(origin) : ""}
    html {
      color-scheme: ${dark ? "dark" : "light"};
      font-size: ${prefs.fontSize}% !important;
      background: ${bg} !important;
      color: ${fg} !important;
      -webkit-text-size-adjust: none;
      text-size-adjust: none;
    }
    body { background: transparent !important; color: inherit !important; }
    body, p, li, blockquote, dd, dt, div, span, td, th, h1, h2, h3, h4, h5, h6, a, em, strong, i, b { ${font} }
    p, li, blockquote, dd, div, span, td {
      line-height: ${prefs.lineHeight} !important;
    }
    p, li, blockquote, dd, div, span, td, th, h1, h2, h3, h4, h5, h6, em, strong, i, b, small, sup, sub {
      color: inherit !important;
      background-color: transparent !important;
    }
    p, li, blockquote, dd { text-align: ${align} !important; }
    p { hyphens: auto; -webkit-hyphens: auto; widows: 2; orphans: 2; }
    a:any-link { color: ${link} !important; text-decoration-thickness: 1px; }
    img, svg, video { max-width: 100%; height: auto; object-fit: contain; }
    ${dark ? "img, svg { filter: brightness(0.88); }" : ""}
  `;
}
