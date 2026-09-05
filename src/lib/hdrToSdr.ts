/**
 * Reprendre l'affichage d'un film HDR sur un écran qui ne l'est pas.
 *
 * Sur le chemin natif, c'est le navigateur qui décode et qui compose : aucun pixel ne passe par
 * JavaScript, et c'est ce qui rend ce chemin bon marché. La plupart des plateformes convertissent
 * alors correctement une source HDR pour un écran ordinaire — Chrome sous Windows, Safari sous
 * macOS. Certaines ne le font pas, et le film sort gris et délavé : la courbe PQ lue comme du sRGB
 * éclaircit tout le bas de l'échelle, et des primaires larges rendues sur des étroites ternissent
 * les couleurs.
 *
 * Ce qu'on fait alors est une vraie conversion et non plus une correction à l'estime : l'image est
 * reprise à l'élément et passée dans le shader écrit pour ça, puis peinte sur un canevas posé
 * par-dessus. Le décodage reste matériel, le son et l'horloge restent à l'élément — voir
 * `hdrPresenter`.
 *
 * Reste la question que rien ne permet de poser : ce navigateur a-t-il déjà fait le travail ? Il
 * n'existe aucune API pour la lui poser. Ce module choisit donc à partir de ce qu'on peut
 * réellement savoir — ce que l'écran déclare — et laisse le dernier mot à qui regarde l'image.
 */

/**
 * La reprise d'affichage est en sommeil.
 *
 * Mise de côté le temps d'être éprouvée, à la demande — rien n'est supprimé : le présentateur, le
 * shader et les décisions ci-dessous restent en place et testés, et cette constante est le seul
 * geste à refaire pour les rallumer. Tant qu'elle est fausse, l'entrée de menu n'apparaît pas et
 * l'image reste exactement celle que le navigateur produit, sur toutes les plateformes.
 */
export const HDR_PRESENTER_ENABLED = false;

/** Quand reprendre l'affichage. Trois réponses, une seule question : faut-il le faire. */
export type HdrMode = "auto" | "always" | "never";

export const HDR_MODES: HdrMode[] = ["auto", "always", "never"];

export type DisplayRange = "high" | "standard" | "unknown";

/**
 * Ce que l'écran sait afficher, demandé plutôt que supposé.
 *
 * Les deux requêtes sont posées, pas une seule : un navigateur qui ne connaît pas `dynamic-range`
 * répond faux aux deux, ce qui se distingue d'un écran standard — qui répond vrai à l'une. Sans
 * cette distinction, une version trop ancienne pour la question ferait passer un vrai écran HDR
 * pour un écran ordinaire.
 */
export function displayRange(): DisplayRange {
  if (typeof window === "undefined" || !window.matchMedia) return "unknown";
  if (window.matchMedia("(dynamic-range: high)").matches) return "high";
  if (window.matchMedia("(dynamic-range: standard)").matches) return "standard";
  return "unknown";
}

/**
 * Faut-il reprendre l'affichage.
 *
 * En automatique, uniquement sur un écran qui s'est déclaré standard. Les deux autres réponses
 * sont des abstentions, et chacune pour une raison qui lui est propre :
 *
 *   * `high` — l'écran est HDR et le navigateur l'affiche nativement en HDR. Reprendre reviendrait
 *     à remplacer du vrai HDR par une conversion vers le standard : la seule façon de dégrader une
 *     image qui était juste. C'est l'écueil à ne jamais franchir tout seul.
 *   * `unknown` — le navigateur ne sait pas répondre, et l'écran peut être HDR. Dans le doute on
 *     ne touche à rien, plutôt que de risquer le cas précédent.
 *
 * Reste le cas d'un écran standard sur un navigateur qui convertissait déjà bien : on remplace
 * alors une conversion correcte par une autre conversion correcte. Ça coûte du GPU et ne casse
 * rien — c'est la raison pour laquelle l'automatique peut se permettre d'être franc ici, là où la
 * correction manuelle qui a précédé aurait, elle, corrigé deux fois.
 */
export function shouldPresentHdr(
  fileIsHdr: boolean,
  onNativeElement: boolean,
  mode: HdrMode,
  range: DisplayRange
): boolean {
  if (!fileIsHdr || !onNativeElement || mode === "never") return false;
  if (mode === "always") return true;
  return range === "standard";
}

/** L'option n'a de sens que là où elle pourrait agir : un fichier HDR, sur l'élément natif. */
export function hdrModeApplies(fileIsHdr: boolean, onNativeElement: boolean): boolean {
  return fileIsHdr && onNativeElement;
}

const STORAGE_KEY = "cine.player.hdrMode";

function readHdrMode(): HdrMode {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && (HDR_MODES as string[]).includes(stored)) return stored as HdrMode;
  } catch {
    // Navigation privée, cookies bloqués : l'automatique est le bon défaut de toute façon.
  }
  return "auto";
}

/**
 * Le mode, lu par `useSyncExternalStore` plutôt que posé dans un effet.
 *
 * Le stockage local n'existe pas sur le serveur, et la valeur doit malgré tout être stable entre
 * le rendu serveur et le premier rendu client. Un `useState` rempli depuis un effet dirait la même
 * chose en repeignant une fois de plus, et en écrivant un état pendant un effet — ce que le
 * compilateur React refuse à raison.
 */
let cached: HdrMode | null = null;
const listeners = new Set<() => void>();

export const hdrModeStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot(): HdrMode {
    if (cached === null) cached = readHdrMode();
    return cached;
  },
  serverSnapshot: (): HdrMode => "auto",
  set(mode: HdrMode): void {
    cached = mode;
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // Voir readHdrMode : rien à rattraper.
    }
    for (const listener of listeners) listener();
  },
};

/** L'écran, qui change si la fenêtre passe d'un moniteur à l'autre. */
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
