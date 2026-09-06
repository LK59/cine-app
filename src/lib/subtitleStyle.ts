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
  /** Un facteur, pas une taille : la taille de base dépend de la largeur de l'écran. */
  size: number;
  color: SubtitleColor;
  background: SubtitleBackground;
}

export const SUBTITLE_SIZES = [
  { labelKey: "subtitleSizeSmall", value: 0.75 },
  { labelKey: "subtitleSizeNormal", value: 1 },
  { labelKey: "subtitleSizeLarge", value: 1.3 },
  { labelKey: "subtitleSizeXLarge", value: 1.6 },
] as const;

export const SUBTITLE_COLORS: SubtitleColor[] = ["white", "yellow"];
export const SUBTITLE_BACKGROUNDS: SubtitleBackground[] = ["shadow", "box", "none"];

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = { size: 1, color: "white", background: "shadow" };

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
    `font-size: clamp(14px, ${style.size * 4}vw, ${Math.round(style.size * 48)}px)`,
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
    fontSize: `clamp(14px, ${style.size * 4}vw, ${Math.round(style.size * 48)}px)`,
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
    // Stockage indisponible : les valeurs par défaut, qui sont celles d'avant ce réglage.
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
