/**
 * Prendre les deux images à comparer, et retenir le verdict.
 *
 * La partie qui touche au DOM : elle capture une image du lecteur et la vignette de trickplay du
 * même instant, les réduit toutes deux à la même petite taille, et confie le reste à `hdrLook`.
 *
 * Le verdict porte sur le navigateur, pas sur le film — un navigateur qui aplatit le HDR le fait
 * pour tous. Il est donc mesuré une fois puis retenu, avec la chaîne d'identification du
 * navigateur : le jour où Firefox corrige son rendu, cette chaîne change, la mesure se refait et
 * la proposition disparaît d'elle-même. Personne n'a rien à désactiver.
 */

import { measure, looksFlattened, shapeDistance, verdictOf, SAME_SHOT_DISTANCE, REQUIRED_SAMPLES, type Verdict } from "@/lib/hdrLook";

export interface TrickplayInfo {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  thumbnailCount: number;
  intervalMs: number;
}

/** Taille de comparaison. Assez pour une structure et des centiles, trop peu pour coûter quoi que ce soit. */
const SAMPLE_W = 96;
const SAMPLE_H = 54;

/**
 * Écart maximal, en millisecondes, entre l'image du lecteur et l'instant de la vignette.
 *
 * Une vignette est prise à l'instant pile de son repère. Plus on s'en éloigne, plus le risque
 * qu'un plan ait changé grandit — et un plan différent ne dit rien du rendu. L'occasion revient
 * à chaque intervalle, il n'y a aucune raison de se contenter d'un mauvais appariement.
 */
export const MAX_TIME_OFFSET_MS = 800;

function context(): CanvasRenderingContext2D | null {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE_W;
  canvas.height = SAMPLE_H;
  // `willReadFrequently` : on relit chaque image dessinée, ce qui est exactement le cas que cette
  // option évite de faire passer par le GPU pour rien.
  return canvas.getContext("2d", { willReadFrequently: true, alpha: false });
}

/** L'image telle que le lecteur l'affiche en ce moment. */
function grabVideo(video: HTMLVideoElement) {
  const ctx = context();
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
    const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
    return measure(data, SAMPLE_W, SAMPLE_H);
  } catch {
    // Un canevas teinté, une image pas encore décodée : pas d'échantillon, et rien de grave.
    return null;
  }
}

const tiles = new Map<string, Promise<HTMLImageElement | null>>();

function loadTile(url: string): Promise<HTMLImageElement | null> {
  const cached = tiles.get(url);
  if (cached) return cached;
  const loading = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
  tiles.set(url, loading);
  return loading;
}

/**
 * La vignette du même instant, découpée dans sa planche.
 *
 * La géométrie est celle qu'utilise déjà l'aperçu de la barre de progression : les vignettes sont
 * empilées par planches de `tileWidth × tileHeight`, une toutes les `intervalMs`.
 */
async function grabTile(itemId: string, info: TrickplayInfo, timeSeconds: number) {
  const index = Math.min(info.thumbnailCount - 1, Math.max(0, Math.floor((timeSeconds * 1000) / info.intervalMs)));
  const perTile = info.tileWidth * info.tileHeight;
  const tileIndex = Math.floor(index / perTile);
  const inTile = index % perTile;
  const col = inTile % info.tileWidth;
  const row = Math.floor(inTile / info.tileWidth);

  const image = await loadTile(
    `/api/jellyfin/trickplay/tile?itemId=${encodeURIComponent(itemId)}&width=${info.width}&index=${tileIndex}`
  );
  if (!image) return null;
  const ctx = context();
  if (!ctx) return null;
  try {
    ctx.drawImage(image, col * info.width, row * info.height, info.width, info.height, 0, 0, SAMPLE_W, SAMPLE_H);
    const { data } = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H);
    return measure(data, SAMPLE_W, SAMPLE_H);
  } catch {
    return null;
  }
}

/** Ce qu'une tentative d'échantillon a donné, pour que l'appelant sache s'il doit réessayer. */
export type SampleOutcome = "flattened" | "faithful" | "unusable";

/**
 * Un échantillon : l'image d'ici, la vignette de là, et la comparaison.
 *
 * `unusable` couvre tout ce qui empêche de conclure — trop loin du repère, vignette absente,
 * plans différents. Rien n'est deviné dans ces cas-là ; on attend l'occasion suivante.
 */
export async function sampleOnce(
  video: HTMLVideoElement,
  itemId: string,
  info: TrickplayInfo,
  timeSeconds: number
): Promise<SampleOutcome> {
  const offset = (timeSeconds * 1000) % info.intervalMs;
  if (offset > MAX_TIME_OFFSET_MS) return "unusable";

  const frame = grabVideo(video);
  if (!frame) return "unusable";
  const reference = await grabTile(itemId, info, timeSeconds);
  if (!reference) return "unusable";

  // Deux plans différents ne disent rien du rendu : l'échantillon est jeté, pas interprété.
  if (shapeDistance(frame.shape, reference.shape) > SAME_SHOT_DISTANCE) return "unusable";

  return looksFlattened(frame.look, reference.look) ? "flattened" : "faithful";
}

// ── Le verdict retenu ────────────────────────────────────────────────────────

const STORAGE_KEY = "cine.player.hdrLook";

interface StoredVerdict {
  agent: string;
  verdict: Verdict;
  /** Le spectateur a demandé qu'on ne le lui propose plus. Distinct du verdict lui-même. */
  dismissed?: boolean;
}

function agent(): string {
  return typeof navigator === "undefined" ? "?" : navigator.userAgent;
}

function loadVerdict(): StoredVerdict | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredVerdict;
    // Un autre navigateur, ou le même après une mise à jour : la mesure ne vaut plus, on la
    // refait. C'est ce qui fera disparaître la proposition le jour où le bug sera corrigé.
    return stored.agent === agent() ? stored : null;
  } catch {
    return null;
  }
}

export function writeVerdict(verdict: Verdict, dismissed = false): void {
  cached = { agent: agent(), verdict, dismissed };
  loaded = true;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached satisfies StoredVerdict));
  } catch {
    // Stockage indisponible : la mesure se refera au prochain film, ce qui est sans conséquence.
  }
  for (const listener of listeners) listener();
}

/**
 * Le verdict, lu par `useSyncExternalStore`.
 *
 * Le stockage local n'existe pas sur le serveur, et la valeur doit pourtant être stable entre le
 * rendu serveur et le premier rendu client. Le lire dans un effet pour le poser en état ferait
 * repeindre une fois de plus et écrirait un état pendant un effet, ce que le compilateur React
 * refuse — et il faut de toute façon une notification quand la mesure conclut.
 *
 * L'instantané est mis en cache pour garder une identité stable entre deux changements, ce
 * qu'exige `useSyncExternalStore` et qu'un objet reconstruit à chaque lecture ne donnerait pas.
 */
let cached: StoredVerdict | null = null;
let loaded = false;
const listeners = new Set<() => void>();

export const verdictStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot(): StoredVerdict | null {
    if (!loaded) {
      cached = loadVerdict();
      loaded = true;
    }
    return cached;
  },
  serverSnapshot: (): StoredVerdict | null => null,
};

export type { StoredVerdict };

export { verdictOf, REQUIRED_SAMPLES };
export type { Verdict };
