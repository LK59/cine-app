/**
 * Où est l'image dans le cadre : les bandes noires incrustées dans le fichier lui-même.
 *
 * Un film en 2,39 livré dans un cadre 16:9 porte ses bandes dans chaque image. Le lecteur ajuste
 * le cadre à l'écran, pas l'image, et sur un téléphone plus large que 16:9 le film se retrouve
 * cerclé de noir sur ses quatre côtés — *The Kissing Booth*, 1920×1080 dont 1920×872 d'image
 * (23/09/2026). Mesuré sur la bibliothèque : 90 titres sur 222 codés en 16:9 ont des bandes en haut
 * et en bas, 7 sur les côtés.
 *
 * La mesure lit les vignettes que Jellyfin a déjà extraites pour la barre de progression (les
 * « trickplay » : une image toutes les dix secondes, sur tout le film). Rien à décoder, quelques
 * planches JPEG à lire — et six cents images valent mieux que dix points pris dans la vidéo.
 *
 * **Elle ne se trompe que du côté prudent.** Chaque vignette dit où son contenu commence ; on
 * garde l'union de toutes, c'est-à-dire la plus grande image vue sur le film. Une scène sombre
 * rétrécit sa propre mesure, jamais l'union : pour qu'une vraie image soit prise pour une bande, il
 * faudrait que ce bord soit noir d'un bout à l'autre du film. Et un film dont le format change en
 * cours de route (séquences IMAX) donne le cadre entier, donc aucun agrandissement. Mesuré avec
 * ffmpeg sur 222 titres : de trois à douze points par film, les quatre résultats qui ont bougé
 * ont tous bougé vers moins de bande.
 */

import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { withPersistentCache } from "@/lib/server-cache";
import type { PictureFrame } from "@/lib/frameFit";

export type { PictureFrame };

/**
 * Une ligne est de l'image dès que sa luminance moyenne dépasse ce seuil (sur 255).
 *
 * Celui de `cropdetect` à 0,1 — la mesure de référence. Une bande grise d'un encodage raté n'est
 * pas une bande pour lui ni pour nous : le film reste tel qu'il est, ce qui est le bon échec.
 */
const LIMIT = 24;

/**
 * Les pixels du bord qu'on ne consulte pas.
 *
 * Les vignettes sont collées les unes aux autres dans une planche JPEG, et les blocs de 8×8 pixels
 * du JPEG ne tombent pas sur leurs frontières (180 = 22,5 blocs) : la première et la dernière ligne
 * d'une vignette reçoivent un peu de la voisine. Lues telles quelles, elles faisaient de toute bande
 * une image. Un contenu qui commence dans cette marge est compté comme commençant au bord.
 */
const EDGE = 2;

/** En deçà, une bande n'en est pas une : un filet ne vaut pas de bouger l'image. */
const MIN_BAR = 0.01;

/** Le début et la fin du film ne comptent pas : logos de studio, cartons et générique. */
const SKIP_HEAD = 0.03;
const SKIP_TAIL = 0.08;

/** Sous ce nombre de vignettes parlantes, on ne dit rien plutôt que de deviner. */
const MIN_SAMPLES = 30;

interface Bounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Les bords du contenu d'une vignette, en pixels, ou null si elle est toute noire.
 *
 * @param gray une planche en niveaux de gris, un octet par pixel, `stride` de large
 */
export function contentBounds(gray: Uint8Array, stride: number, x0: number, y0: number, w: number, h: number): Bounds | null {
  const rowLit = (y: number) => {
    let sum = 0;
    const at = (y0 + y) * stride + x0;
    for (let x = 0; x < w; x++) sum += gray[at + x];
    return sum / w > LIMIT;
  };
  let top = -1;
  for (let y = 0; y < h; y++) if (rowLit(y)) { top = y; break; }
  if (top < 0) return null;
  let bottom = h;
  for (let y = h - 1; y >= top; y--) if (rowLit(y)) { bottom = y + 1; break; }

  // Les colonnes sur la hauteur de l'image seulement : les bandes du haut et du bas, comptées
  // dedans, assombrissaient chaque colonne et inventaient des bandes sur les côtés.
  const colLit = (x: number) => {
    let sum = 0;
    for (let y = top; y < bottom; y++) sum += gray[(y0 + y) * stride + x0 + x];
    return sum / (bottom - top) > LIMIT;
  };
  let left = 0;
  for (let x = 0; x < w; x++) if (colLit(x)) { left = x; break; }
  let right = w;
  for (let x = w - 1; x >= left; x--) if (colLit(x)) { right = x + 1; break; }

  return {
    top: top <= EDGE ? 0 : top,
    bottom: bottom >= h - EDGE ? h : bottom,
    left: left <= EDGE ? 0 : left,
    right: right >= w - EDGE ? w : right,
  };
}

/**
 * La plus grande image vue, en fractions, élargie d'un pixel de chaque côté.
 *
 * Le pixel de marge est pour la vignette : un pixel sur 180, c'est 0,6 % de la hauteur, et
 * mieux vaut garder un filet de noir que couper une ligne d'image.
 */
export function unionFrame(all: Bounds[], w: number, h: number): PictureFrame | null {
  if (all.length < MIN_SAMPLES) return null;
  const top = Math.max(0, Math.min(...all.map((b) => b.top)) - 1) / h;
  const bottom = Math.min(h, Math.max(...all.map((b) => b.bottom)) + 1) / h;
  const left = Math.max(0, Math.min(...all.map((b) => b.left)) - 1) / w;
  const right = Math.min(w, Math.max(...all.map((b) => b.right)) + 1) / w;
  const round = (v: number) => Math.round(v * 10_000) / 10_000;
  // Un filet de chaque côté est du bruit : il ne compte que si la paire de bandes le dépasse.
  const vertical = top + (1 - bottom) >= MIN_BAR * 2;
  const horizontal = left + (1 - right) >= MIN_BAR * 2;
  return {
    top: vertical ? round(top) : 0,
    bottom: vertical ? round(bottom) : 1,
    left: horizontal ? round(left) : 0,
    right: horizontal ? round(right) : 1,
    aspect: round(w / h),
    samples: all.length,
  };
}

/** Ce que Jellyfin dit de ses vignettes pour un élément. */
export interface TrickplayInfo {
  mediaSourceId: string;
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  thumbnailCount: number;
}

export async function trickplayInfo(itemId: string, signal?: AbortSignal): Promise<TrickplayInfo | null> {
  // Par `/Items?Ids=` : `/Items/{id}` exige un UserId (voir la route trickplay/info), la liste non.
  const res = await fetch(`${config.jellyfin.url}/Items?Ids=${itemId}&Fields=Trickplay&EnableImages=false`, {
    headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
    signal: signal ?? AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as {
    Items?: { Trickplay?: Record<string, Record<string, { Width: number; Height: number; TileWidth: number; TileHeight: number; ThumbnailCount: number }>> }[];
  };
  const sources = body.Items?.[0]?.Trickplay;
  const [mediaSourceId, resolutions] = Object.entries(sources ?? {})[0] ?? [];
  if (!mediaSourceId || !resolutions) return null;
  // La plus petite : 320 px suffisent à voir une bande, et c'est la seule que la bibliothèque a.
  const [width, info] = Object.entries(resolutions).sort(([a], [b]) => Number(a) - Number(b))[0] ?? [];
  if (!info || !info.ThumbnailCount) return null;
  return {
    mediaSourceId,
    width: Number(width),
    height: info.Height,
    tileWidth: info.TileWidth,
    tileHeight: info.TileHeight,
    thumbnailCount: info.ThumbnailCount,
  };
}

/**
 * Mesure un élément. Null quand il n'y a pas de vignettes, ou pas assez pour conclure.
 *
 * Quelques planches de ~100 vignettes chacune, lues deux par deux : une par tranche de 17 minutes
 * de film, une demi-seconde de travail en tout.
 */
export async function measurePictureFrame(itemId: string, info: TrickplayInfo): Promise<PictureFrame | null> {
  const { default: sharp } = await import("sharp");
  const perTile = info.tileWidth * info.tileHeight;
  const tiles = Math.ceil(info.thumbnailCount / perTile);
  const from = Math.floor(info.thumbnailCount * SKIP_HEAD);
  const until = Math.ceil(info.thumbnailCount * (1 - SKIP_TAIL));
  const all: Bounds[] = [];

  const readTile = async (index: number) => {
    const res = await fetch(
      `${config.jellyfin.url}/Videos/${itemId}/Trickplay/${info.width}/${index}.jpg?MediaSourceId=${info.mediaSourceId}`,
      { headers: jellyfinAuthHeaders(config.jellyfin.apiKey), signal: AbortSignal.timeout(15_000) }
    );
    if (!res.ok) return;
    const { data, info: image } = await sharp(Buffer.from(await res.arrayBuffer()))
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const gray = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const stride = image.width * image.channels;
    for (let k = 0; k < perTile; k++) {
      const n = index * perTile + k;
      if (n < from || n >= until) continue;
      const x0 = (k % info.tileWidth) * info.width;
      const y0 = Math.floor(k / info.tileWidth) * info.height;
      // La dernière planche est plus courte que les autres.
      if (x0 + info.width > image.width || y0 + info.height > image.height) continue;
      const bounds = image.channels === 1 ? contentBounds(gray, stride, x0, y0, info.width, info.height) : null;
      if (bounds) all.push(bounds);
    }
  };

  for (let index = 0; index < tiles; index += 2) {
    await Promise.all([readTile(index), index + 1 < tiles ? readTile(index + 1) : Promise.resolve()]);
  }
  return unionFrame(all, info.width, info.height);
}

/** Six mois : les bandes d'un fichier ne changent pas, et un fichier remplacé change de clé. */
const FRAME_TTL_MS = 180 * 24 * 3600_000;

/**
 * Le cadre d'un élément, mesuré une fois puis gardé sur disque.
 *
 * La clé porte le nombre de vignettes : un fichier remplacé par Radarr ou Sonarr garde souvent
 * son identifiant Jellyfin, mais ses vignettes sont refaites, et leur nombre change avec la durée.
 * Pas de vignettes, pas de clé : rien n'est retenu, et la question sera reposée quand Jellyfin les
 * aura produites.
 */
export async function pictureFrameFor(itemId: string): Promise<PictureFrame | null> {
  const info = await trickplayInfo(itemId);
  if (!info) return null;
  return withPersistentCache(`frame:v1:${itemId}:${info.thumbnailCount}`, FRAME_TTL_MS, () => measurePictureFrame(itemId, info));
}
