import { Cache } from "three";
import { useStore } from "../state/store";

/**
 * Les décors arrivent en trois paquets (`vite.config.ts`, `assetPacks`), pas en deux cents fichiers.
 *
 * Pourquoi : le pare-feu du serveur bannit — pour des heures, et de tout le serveur — une adresse qui demande
 * plus de ~40 noms de fichiers « non statiques » distincts en rafale (`.ktx2`, `.bin`, `.gltf`, `.json`…).
 * Ouvrir le chalet en demandait ≈ 180 : un iPhone a été banni 4 h le 11/11/2026.
 *
 * Comment : les paquets sont lus d'abord (`loadPacks`, la barre de l'accueil compte leurs octets) ; ensuite
 * `THREE.Cache` répond aux chargeurs de three (textures KTX2, modèles glTF et leurs `.bin`, transcodeur Basis)
 * sans une requête, et `assetBytes` / `assetJson` servent ce que la page lit elle-même. Rien n'est fabriqué en
 * `blob:` — la politique de sécurité de l'application refuse `fetch(blob:)`.
 *
 * Un paquet qui ne vient pas fait échouer le chargement (l'écran « Réessayer ») : retomber sur les fichiers un à
 * un les demanderait tous — c'est exactement ce qui fait bannir, et ils ne sont plus dans le build.
 */
const MAGIC = "LTPK";
const base = import.meta.env.BASE_URL;
const files = new Map<string, Uint8Array>();
let pending: Promise<void> | null = null;
/** Les lectures de décor encore en cours hors de `Suspense` (lumière précalculée, panorama) : voir `holdPacks`. */
const holds = new Set<Promise<unknown>>();
/** Les paquets ont été rendus (`releasePacks`) : un chemin empaqueté demandé ensuite est une erreur. */
let released = false;

/** Le chemin sous la base (`assets/textures/rug/color.ktx2`) d'une adresse de la page, sans sa requête. */
function pathOf(url: string): string | null {
  try {
    const u = new URL(url, location.href);
    if (u.origin !== location.origin || !u.pathname.startsWith(base)) return null;
    return decodeURIComponent(u.pathname.slice(base.length));
  } catch {
    return null;
  }
}

/**
 * Le contenu empaqueté de cette adresse, en **copie** : `KTX2Loader` cède son tampon au travailleur qui le
 * décode, et un tampon cédé est vide pour le suivant. `undefined` si aucun paquet ne la contient.
 */
export function packed(url: string): ArrayBuffer | undefined {
  const path = pathOf(url);
  const bytes = path ? files.get(path) : undefined;
  // Après `releasePacks`, rien ne devrait plus lire un décor : tout est monté d'emblée (les pièces sont cachées,
  // jamais démontées). Si cela change un jour, la requête partirait vers un fichier qui n'est plus dans le build.
  if (!bytes && released && path && /^(assets\/(textures|models|lightmaps|panorama)|basis)\//.test(path)) console.error(`[immersion] décor demandé après la libération des paquets : ${path}`);
  return bytes ? (bytes.slice().buffer as ArrayBuffer) : undefined;
}

/**
 * Une lecture de décor qui se fait hors de `Suspense` (dans un effet) : les paquets ne sont rendus qu'une fois
 * qu'elle a abouti, et la scène n'est préparée (`SceneReady`) qu'avec elle. Rend la même promesse.
 */
export function holdPacks<T>(work: Promise<T>): Promise<T> {
  holds.add(work);
  const done = () => holds.delete(work);
  work.then(done, done);
  return work;
}

/** Résolue quand plus aucune lecture retenue n'est en cours (y compris celles ajoutées en attendant). */
export async function packsSettled(): Promise<void> {
  while (holds.size > 0) await Promise.allSettled([...holds]);
}

/**
 * Rend la mémoire des paquets (≈ 42 Mo) une fois la scène construite et préparée : three garde déjà sa propre copie
 * de ce qu'il a décodé, et la carte graphique la sienne — les octets bruts n'étaient plus qu'une troisième copie.
 */
export function releasePacks(): void {
  if (__PACKS__.length === 0) return;
  files.clear();
  released = true;
}

/** Les octets d'un asset (`assets/<file>`) : du paquet, ou du réseau en développement. `null` s'il manque. */
export async function assetBytes(url: string): Promise<ArrayBuffer | null> {
  const hit = packed(url);
  if (hit) return hit;
  if (__PACKS__.length > 0) return null;
  const response = await fetch(url, { credentials: "same-origin" });
  return response.ok ? response.arrayBuffer() : null;
}

export async function assetJson<T>(url: string): Promise<T | null> {
  const bytes = await assetBytes(url);
  return bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as T) : null;
}

/**
 * Les chargeurs de three passent par `FileLoader`, qui consulte `THREE.Cache` avant le réseau. Il est branché
 * sur les paquets, et sur eux seuls : `add` ne garde rien d'autre, comme quand le cache était coupé.
 */
function installCache(): void {
  Cache.enabled = true;
  Cache.add = () => {};
  Cache.get = (key: string) => {
    if (!key.startsWith("file:")) return undefined;
    const url = key.slice(5);
    const bytes = packed(url);
    if (!bytes) return undefined;
    // Le transcodeur est demandé en texte, tout le reste en tampon.
    return url.split("?")[0].endsWith(".js") ? new TextDecoder().decode(bytes) : bytes;
  };
}

async function fetchPack(name: string, expected: number, received: (n: number) => void): Promise<Uint8Array> {
  const response = await fetch(`${base}packs/${name}.bin?v=${__ASSETS_VERSION__}`, { credentials: "same-origin" });
  if (!response.ok || !response.body) throw new Error(`paquet ${name} : réponse ${response.status}`);
  let data = new Uint8Array(expected);
  let length = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.length > data.length) {
      const grown = new Uint8Array(Math.max(data.length * 2, length + value.length));
      grown.set(data.subarray(0, length));
      data = grown;
    }
    data.set(value, length);
    length += value.length;
    received(value.length);
  }
  return data.subarray(0, length);
}

function unpack(name: string, data: Uint8Array): void {
  // Une session finie rend la page de connexion (200, du HTML) : ce n'est pas un paquet.
  if (data.length < 8 || new TextDecoder().decode(data.subarray(0, 4)) !== MAGIC) throw new Error(`paquet ${name} illisible`);
  const headerLength = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(data.subarray(8, 8 + headerLength))) as { files: Record<string, [number, number]> };
  const start = 8 + headerLength;
  for (const [path, [offset, length]] of Object.entries(header.files)) files.set(path, data.subarray(start + offset, start + offset + length));
}

/** Télécharge les paquets (une fois par visite). La progression, en octets, est écrite dans l'état (`packs`). */
export function loadPacks(): Promise<void> {
  if (pending) return pending;
  installCache();
  const total = __PACKS__.reduce((sum, pack) => sum + pack.bytes, 0);
  let loaded = 0;
  let painted = 0;
  const progress = (n: number) => {
    loaded += n;
    // Pas à chaque morceau reçu : une fois par pour cent suffit à la barre.
    if (loaded - painted >= total / 100 || loaded >= total) {
      painted = loaded;
      useStore.getState().setPacks({ loaded: Math.min(loaded, total), total });
    }
  };
  if (total > 0) useStore.getState().setPacks({ loaded: 0, total });
  pending = Promise.all(
    __PACKS__.map(async (pack) => {
      unpack(pack.name, await fetchPack(pack.name, pack.bytes, progress));
    })
  ).then(() => {
    if (total > 0) useStore.getState().setPacks({ loaded: total, total });
  });
  // Un échec n'est pas gardé : « Réessayer » recharge la page, mais un nouvel appel doit pouvoir repartir.
  pending.catch(() => {
    pending = null;
  });
  return pending;
}
