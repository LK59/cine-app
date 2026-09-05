/**
 * Rattraper une image HDR affichée sur un écran qui ne l'est pas.
 *
 * Sur le chemin natif, c'est le navigateur qui décode et qui compose : aucun pixel ne passe par
 * JavaScript, et c'est précisément ce qui rend ce chemin bon marché. Mais quand le fichier est
 * masterisé en HDR10 — primaires BT.2020, courbe PQ — et que l'écran ne l'est pas, certains
 * navigateurs se contentent d'envoyer ces valeurs à un écran standard. Le résultat est l'image
 * délavée, grise et sans contraste qu'on connaît : la courbe PQ lue comme du sRGB éclaircit tout
 * le bas de l'échelle, et les primaires larges lues comme des étroites désaturent les couleurs.
 *
 * On ne peut pas convertir proprement : l'image qu'on récupérerait d'un canevas a déjà subi cette
 * conversion, et ce qui a été écrasé l'est pour de bon. Le seul décodage qui donnerait accès aux
 * vraies valeurs PQ est logiciel — c'est le chemin canevas, qu'on paie en CPU et que Firefox ne
 * peut de toute façon pas emprunter pour du HEVC.
 *
 * Ce qui reste est une correction, pas une conversion : une vraie courbe de transfert par canal
 * plus une resaturation, appliquées par le compositeur via un filtre SVG. L'élément reste natif,
 * le décodage reste matériel, rien ne passe par une boucle JavaScript. En échange, ce n'est pas
 * juste au sens colorimétrique — c'est réglé à l'œil, et c'est pour ça que le niveau se choisit.
 */

export type ToneLevel = "off" | "light" | "medium" | "strong";

export const TONE_LEVELS: ToneLevel[] = ["off", "light", "medium", "strong"];

/** Les paramètres du filtre. `out = amplitude × in^exponent`, puis resaturation. */
export interface ToneCurve {
  exponent: number;
  amplitude: number;
  saturation: number;
}

/**
 * Trois forces plutôt qu'un réglage continu.
 *
 * L'exposant assombrit le bas de l'échelle — c'est lui qui rend le contraste — et l'amplitude
 * rattrape les hautes lumières qu'il vient d'emporter avec le reste. La saturation compense des
 * primaires larges rendues sur des primaires étroites, ce qui ternit toujours dans ce sens.
 */
export const TONE_CURVES: Record<Exclude<ToneLevel, "off">, ToneCurve> = {
  light: { exponent: 1.5, amplitude: 1.08, saturation: 1.15 },
  medium: { exponent: 1.9, amplitude: 1.16, saturation: 1.3 },
  strong: { exponent: 2.3, amplitude: 1.26, saturation: 1.45 },
};

export type DisplayRange = "high" | "standard" | "unknown";

/**
 * Ce que l'écran sait afficher, demandé plutôt que supposé.
 *
 * Les deux requêtes sont posées, pas une seule : un navigateur qui ne connaît pas
 * `dynamic-range` répond faux aux deux, ce qui se distingue d'un écran standard — qui répond vrai
 * à l'une. Sans cette distinction, une version trop ancienne pour la question ferait passer un
 * vrai écran HDR pour un écran ordinaire, et on corrigerait une image qui n'a rien à se faire
 * corriger.
 */
export function displayRange(): DisplayRange {
  if (typeof window === "undefined" || !window.matchMedia) return "unknown";
  if (window.matchMedia("(dynamic-range: high)").matches) return "high";
  if (window.matchMedia("(dynamic-range: standard)").matches) return "standard";
  return "unknown";
}

/**
 * À qui l'option est offerte.
 *
 * À tout fichier HDR joué sur l'élément natif, sans condition d'écran — et c'est un revirement
 * assumé. Tant que la détection décidait d'appliquer la correction, se tromper coûtait une image
 * abîmée, et il fallait qu'elle soit sûre. Depuis que le défaut est « aucune », elle ne décide
 * plus que de l'apparition d'une ligne de menu : la garder comme condition ne protégeait plus de
 * rien et privait deux cas réels du réglage dont ils ont besoin — un écran HDR dont le système a
 * désactivé le mode HDR, et un navigateur trop ancien pour connaître la question.
 *
 * Ce que l'écran répond sert donc à renseigner celui qui choisit, pas à choisir à sa place.
 */
export function toneMappingApplies(fileIsHdr: boolean): boolean {
  return fileIsHdr;
}

const STORAGE_KEY = "cine.player.hdrTone";

/**
 * Le niveau retenu, ou celui par défaut — qui est « aucune », et c'est délibéré.
 *
 * Savoir que l'écran est standard ne dit pas que le navigateur n'a rien fait. Chrome sous Windows
 * et Safari sous macOS convertissent déjà correctement une vidéo HDR vers un écran qui ne l'est
 * pas, et aucune API ne permet de leur demander s'ils l'ont fait. Corriger d'office reviendrait
 * donc à corriger deux fois là où tout allait bien, et à durcir une image juste — un défaut plus
 * visible que celui qu'on répare, infligé à ceux qui n'avaient rien demandé.
 *
 * L'entrée du menu apparaît dès que la question se pose ; c'est celui qui voit l'image qui
 * tranche, une fois, et son choix est retenu.
 */
export function readToneLevel(): ToneLevel {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && (TONE_LEVELS as string[]).includes(stored)) return stored as ToneLevel;
  } catch {
    // Navigation privée, cookies bloqués : on repart du défaut, ce qui est exactement le bon
    // comportement.
  }
  return "off";
}

function writeToneLevel(level: ToneLevel): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // Voir readToneLevel : rien à rattraper.
  }
}

/**
 * Le niveau et l'écran, lus par `useSyncExternalStore` plutôt que posés dans un effet.
 *
 * Les deux ont la même forme : une valeur que le serveur ne peut pas connaître — le stockage
 * local et `matchMedia` n'existent que dans le navigateur — et qui doit malgré tout être stable
 * entre le rendu serveur et le premier rendu client. Un `useState` rempli depuis un effet dirait
 * la même chose, en repeignant une fois de plus et en écrivant un état pendant un effet, ce que
 * le compilateur React refuse à raison.
 *
 * L'instantané est mis en cache contre lui-même : `useSyncExternalStore` réclame une identité
 * stable tant que rien n'a changé, et une chaîne relue à chaque rendu la lui donne déjà — mais le
 * stockage, lui, n'a pas à être relu à chaque fois.
 */
let cachedLevel: ToneLevel | null = null;
const levelListeners = new Set<() => void>();

function levelSnapshot(): ToneLevel {
  if (cachedLevel === null) cachedLevel = readToneLevel();
  return cachedLevel;
}

export const toneLevelStore = {
  subscribe(listener: () => void): () => void {
    levelListeners.add(listener);
    return () => levelListeners.delete(listener);
  },
  snapshot: levelSnapshot,
  serverSnapshot: (): ToneLevel => "off",
  set(level: ToneLevel): void {
    cachedLevel = level;
    writeToneLevel(level);
    for (const listener of levelListeners) listener();
  },
};

/**
 * L'écran, qui peut changer : une fenêtre déplacée d'un moniteur HDR vers un moniteur ordinaire
 * ne pose plus la même question.
 */
export const displayRangeStore = {
  subscribe(listener: () => void): () => void {
    if (typeof window === "undefined" || !window.matchMedia) return () => {};
    const query = window.matchMedia("(dynamic-range: high)");
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  },
  snapshot: displayRange,
  serverSnapshot: (): DisplayRange => "unknown",
};
