// Le cache des index de Lumen serveur sur le disque, sous `DATA_DIR` (étape 3, DECISIONS.md §156).
//
// Pourquoi : l'index à froid coûte cher. Remesuré le 16/11/2026 avec la vérification paresseuse de
// l'étape 2, sur trois fichiers que le cache de pages ne tenait pas (fincore à 0 sur leur branche
// mergerfs), X-Ray en pause : *The Prestige* (11 Go, HEVC à CRA) **25,2 s** et 224 Mo lus,
// *Pearl Harbor* (6,4 Go) **22,7 s** et 108 Mo, un épisode 4K de *Black Monday* (3,3 Go, IDR seules)
// **2,0 s**. Chaque point vérifié coûte une douzaine de lectures de 16 Kio sur un disque à plateaux
// partagé avec X-Ray. Le cache en mémoire (`indexCache.ts`) meurt avec le conteneur, recréé à chaque
// déploiement — plusieurs fois par jour — : sans ce fichier, la première séance après chaque
// déploiement repayait ces vingt secondes, et un spectateur en pleine lecture sur une Apple TV
// attendait autant sa liste suivante.
//
// - **Clé** : chemin local + taille + mtime + inode (`identityKey`), la version du format produit
//   (`lumenFormatTag` : `LUMEN_FORMAT_VERSION`, et pour un essai sa découpe, sa révision et sa cible,
//   §157, §158) et celle de ce fichier (`STORE_VERSION`), condensées en SHA-256 pour le nom. Le fichier
//   relu porte sa clé entière, comparée à la lecture : une collision de nom ou un fichier d'une autre
//   version n'est jamais servi, il est effacé. Les index du format 1 (découpe `idr`) ne se relisent pas
//   sous le format 2 : autre clé, autre nom ; ils partent avec le temps, le moins récemment lu d'abord.
// - **Forme** : `v8.serialize` — le clonage structuré que l'index traverse déjà entre fils
//   (`worker_threads`), `Uint8Array` des init segments compris. Rien à écrire à la main, et un champ
//   ajouté à l'index n'oublie pas d'être sauvé.
// - **Borné en octets** (64 Mo par défaut : un index d'épisode pèse quelques dizaines de Ko sur le
//   disque, un film 4K de trois heures quelques centaines) ; le moins récemment lu part d'abord — une
//   lecture touche la date du fichier.
// - **Écriture atomique** (fichier temporaire, puis `rename`) : un conteneur tué au milieu ne laisse
//   jamais un index à moitié écrit sous un nom valable.
// - **Jamais l'erreur** : un disque plein, un dossier illisible, un fichier corrompu se lisent comme
//   une absence ; l'index est reconstruit depuis le média. Ce cache n'est qu'une accélération, comme
//   celui en mémoire.
//
// Fil principal seulement (`node:fs`, `node:v8`).

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deserialize, serialize } from "node:v8";
import { identityKey, LUMEN_DEFAULT_CUT, LUMEN_FORMAT_VERSION, lumenFormatTag, type FileIdentity, type LumenCutMode, type LumenIndex } from "./format";

/**
 * La version de ce fichier sur le disque. À monter si l'enveloppe change (ce qui entoure l'index) ;
 * l'index lui-même suit `LUMEN_FORMAT_VERSION`, déjà dans la clé.
 */
export const STORE_VERSION = 1;
export const DEFAULT_STORE_BYTES = 64 * 1024 * 1024;
const SUFFIX = ".idx";

interface Envelope {
  store: number;
  format: number;
  key: string;
  index: LumenIndex;
}

export interface LumenIndexStore {
  get(identity: FileIdentity, targetUs?: number, cut?: LumenCutMode): Promise<LumenIndex | null>;
  /** Rangé sous la découpe et la cible que l'index porte (`index.cut`, `index.targetUs`). */
  put(index: LumenIndex): Promise<void>;
}

export interface IndexStoreOptions {
  maxBytes?: number;
}

/** La clé complète d'un index : ce qui doit être identique pour qu'un index gardé vaille. */
export function storeKey(identity: FileIdentity, targetUs?: number, cut: LumenCutMode = LUMEN_DEFAULT_CUT): string {
  return `${STORE_VERSION}|${lumenFormatTag(cut, targetUs)}|${identityKey(identity)}`;
}

function fileNameOf(key: string): string {
  return `${createHash("sha256").update(key).digest("hex").slice(0, 40)}${SUFFIX}`;
}

/** Le cache disque, dans `dir` (créé à la première écriture). */
export function lumenIndexStore(dir: string, options: IndexStoreOptions = {}): LumenIndexStore {
  const maxBytes = options.maxBytes ?? DEFAULT_STORE_BYTES;
  let pruning: Promise<void> | null = null;

  const prune = async (): Promise<void> => {
    const names = await readdir(dir).catch(() => [] as string[]);
    const files: { path: string; size: number; at: number }[] = [];
    for (const name of names) {
      const path = join(dir, name);
      const st = await stat(path).catch(() => null);
      if (!st) continue;
      // Le temporaire d'une écriture que le conteneur n'a pas finie (arrêt en plein `writeFile`).
      if (name.endsWith(".tmp")) {
        if (Date.now() - st.mtimeMs > 60 * 60 * 1000) await unlink(path).catch(() => {});
        continue;
      }
      if (name.endsWith(SUFFIX)) files.push({ path, size: st.size, at: st.mtimeMs });
    }
    let total = files.reduce((sum, f) => sum + f.size, 0);
    // Le plus anciennement lu d'abord (une lecture touche la date, voir `get`).
    files.sort((a, b) => a.at - b.at);
    for (const f of files) {
      if (total <= maxBytes) break;
      await unlink(f.path).catch(() => {});
      total -= f.size;
    }
  };

  return {
    async get(identity, targetUs, cut = LUMEN_DEFAULT_CUT) {
      const key = storeKey(identity, targetUs, cut);
      const path = join(dir, fileNameOf(key));
      let raw: Buffer;
      try {
        raw = await readFile(path);
      } catch {
        return null; // absent : le cas ordinaire
      }
      try {
        const envelope = deserialize(raw) as Envelope;
        if (envelope?.store !== STORE_VERSION || envelope.format !== LUMEN_FORMAT_VERSION || envelope.key !== key) throw new Error("autre version");
        if (identityKey(envelope.index.identity) !== identityKey(identity)) throw new Error("autre fichier");
        if (envelope.index.cut !== cut || lumenFormatTag(envelope.index.cut, envelope.index.targetUs) !== lumenFormatTag(cut, targetUs)) throw new Error("autre découpe");
        // La date du fichier sert d'ordre d'éviction : lu maintenant, il part en dernier.
        const now = new Date();
        await utimes(path, now, now).catch(() => {});
        return envelope.index;
      } catch {
        // Corrompu, tronqué, d'une autre version : effacé, l'index sera reconstruit et réécrit.
        await unlink(path).catch(() => {});
        return null;
      }
    },

    async put(index) {
      const key = storeKey(index.identity, index.targetUs, index.cut);
      const envelope: Envelope = { store: STORE_VERSION, format: LUMEN_FORMAT_VERSION, key, index };
      const bytes = serialize(envelope);
      // Un index plus lourd que tout le cache n'y entre pas : il en chasserait tout le reste.
      if (bytes.length > maxBytes) return;
      try {
        await mkdir(dir, { recursive: true });
        const path = join(dir, fileNameOf(key));
        const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
        await writeFile(tmp, bytes);
        await rename(tmp, path).catch(async (error) => {
          await unlink(tmp).catch(() => {});
          throw error;
        });
      } catch {
        return; // disque plein, dossier en lecture seule : l'index reste en mémoire, rien de plus
      }
      // Une passe d'éviction à la fois ; écrire est rare (un index par fichier ouvert pour la première fois).
      pruning ??= prune().finally(() => {
        pruning = null;
      });
      await pruning;
    },
  };
}
