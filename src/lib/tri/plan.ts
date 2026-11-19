// Ce qu'une suppression du tri emportera (DECISIONS.md §198) — calculé avant la confirmation, et de
// nouveau au moment d'agir : la suppression refuse un plan qui a changé entre-temps (`fingerprint`).
//
// **Les fichiers sont liés.** Ceux de la bibliothèque sont des liens physiques vers ceux que
// qBittorrent partage (et les cross-seeds, d'autres liens vers les mêmes octets) : supprimer le titre
// dans Radarr ou Sonarr ne libère rien tant qu'un torrent garde le même fichier. Le plan retrouve donc
// les torrents par les fichiers eux-mêmes — même périphérique et même inode, ce qui attrape les
// cross-seeds sans deviner sur les noms —, et par l'historique de Radarr ou Sonarr (l'identifiant du
// téléchargement, un torrent dont le fichier n'a jamais été importé).
//
// **Garde-fou** : un torrent dont un fichier est aussi lié dans la bibliothèque **ailleurs que sous ce
// titre** (un pack qui sert deux séries, un fichier partagé) n'est jamais emporté : il est écarté et
// le plan le dit. Laterna ne supprime rien lui-même — qBittorrent, Radarr et Sonarr le font ; il lit
// seulement le disque, monté en lecture seule.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fsSlots } from "@/lib/storage-scan";
import { MEDIA_ROOT, MOVIES_PATH, SEEDS_PATH, TV_PATH } from "@/lib/media-paths";
import { qbittorrent, type QbTorrent } from "@/lib/clients/qbittorrent";
import { radarr } from "@/lib/clients/radarr";
import { sonarr } from "@/lib/clients/sonarr";
import type { TriKind, TriPlan } from "./types";

/** Un fichier du disque : son chemin vu d'ici, son inode (« périphérique:numéro »), ses liens, sa taille. */
export interface DiskFile {
  path: string;
  inode: string;
  links: number;
  size: number;
}

/** « /media/movies/X » (vu de Radarr, Sonarr ou qBittorrent) → « /mnt/media/video/movies/X » (vu d'ici). */
export function localPath(remote: string): string {
  return remote.startsWith("/media/") ? `${MEDIA_ROOT}/${remote.slice("/media/".length)}` : remote;
}

/** Les fichiers de la bibliothèque et des partages, gardés dix minutes. */
interface DiskIndex {
  at: number;
  files: DiskFile[];
  byInode: Map<string, DiskFile[]>;
}
const indexState = ((globalThis as Record<symbol, unknown>)[Symbol.for("cine-app.tri.disk")] ??= { index: null, pending: null, generation: 0 }) as {
  index: DiskIndex | null;
  pending: Promise<DiskIndex> | null;
  /** Avancée par chaque suppression : un parcours commencé avant ne publie pas son index périmé. */
  generation: number;
};

// Huit à la fois, pas trente-deux : un `stat` occupe un fil du pool de libuv (quatre en tout), que les
// résolutions DNS des services partagent. Mesuré le 19/11/2026 : parcours et appels en parallèle, les
// appels à qBittorrent ou Radarr dépassaient leurs 5 s, coincés derrière des milliers de `stat`.
const fsSlot = fsSlots(8);

/**
 * Tous les fichiers sous une racine, sous-titres et .nfo compris (un torrent les emporte aussi) —
 * pas `find -printf`, que le BusyBox de l'image ne connaît pas.
 */
async function walkAll(root: string, depth = 0): Promise<DiskFile[]> {
  if (depth > 10) return [];
  let entries;
  try {
    entries = await fsSlot(() => fs.readdir(root, { withFileTypes: true }));
  } catch {
    return [];
  }
  const nested = await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => walkAll(path.join(root, e.name), depth + 1)));
  const files = await Promise.all(
    entries
      .filter((e) => e.isFile())
      .map(async (e): Promise<DiskFile | null> => {
        const full = path.join(root, e.name);
        try {
          const st = await fsSlot(() => fs.stat(full));
          return { path: full, inode: `${st.dev}:${st.ino}`, links: st.nlink, size: st.size };
        } catch {
          return null;
        }
      })
  );
  return [...nested.flat(), ...files.filter((f): f is DiskFile => f !== null)];
}

export function indexFiles(files: DiskFile[]): Map<string, DiskFile[]> {
  const byInode = new Map<string, DiskFile[]>();
  for (const f of files) byInode.set(f.inode, [...(byInode.get(f.inode) ?? []), f]);
  return byInode;
}

/** Après une suppression, l'index ne vaut plus rien. */
export function forgetDiskIndex(): void {
  indexState.index = null;
  indexState.pending = null;
  indexState.generation++;
}

export async function diskIndex(force = false): Promise<DiskIndex> {
  if (!force && indexState.index && Date.now() - indexState.index.at < 10 * 60_000) return indexState.index;
  // Un seul parcours à la fois : un aperçu demandé pendant la préparation attend celle-ci.
  if (indexState.pending && !force) return indexState.pending;
  const generation = indexState.generation;
  const pending = (async () => {
    const files: DiskFile[] = [];
    for (const root of [MOVIES_PATH, TV_PATH, SEEDS_PATH]) files.push(...(await walkAll(root)));
    const index = { at: Date.now(), files, byInode: indexFiles(files) };
    if (indexState.generation === generation) indexState.index = index;
    return index;
  })();
  indexState.pending = pending;
  try {
    return await pending;
  } finally {
    if (indexState.pending === pending) indexState.pending = null;
  }
}

const under = (path: string, root: string) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

export interface PlanInput {
  kind: TriKind;
  id: number;
  title: string;
  /** Le dossier du titre, vu d'ici. */
  folder: string;
  torrents: readonly QbTorrent[];
  /** Les identifiants de téléchargement de l'historique de Radarr/Sonarr (minuscules). */
  historyHashes: ReadonlySet<string>;
  index: { files: readonly DiskFile[]; byInode: ReadonlyMap<string, DiskFile[]> };
  jellyseerrMediaId: number | null;
  requests: number;
}

/** Le plan, à partir de ce qui est déjà lu — pur, donc testable sur un faux disque. */
export function buildPlan(input: PlanInput): TriPlan & { skipped: { hash: string; name: string; reason: string }[] } {
  const libraryRoots = [MOVIES_PATH, TV_PATH];
  // Les fichiers triés par chemin : « tout ce qui est sous ce dossier » devient une plage, trouvée par
  // dichotomie — 4 000 torrents × des dizaines de milliers de fichiers, sinon.
  const sorted = [...input.index.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const byPath = new Map(sorted.map((f) => [f.path, f]));
  const filesUnder = (root: string): DiskFile[] => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].path < root) lo = mid + 1;
      else hi = mid;
    }
    const out: DiskFile[] = [];
    for (let i = lo; i < sorted.length && sorted[i].path.startsWith(root); i++) if (under(sorted[i].path, root)) out.push(sorted[i]);
    return out;
  };
  const libraryFiles = filesUnder(input.folder);
  const titleInodes = new Set(libraryFiles.map((f) => f.inode));

  // Sans `content_path` propre (métadonnées pas encore reçues), le dossier d'enregistrement serait celui
  // de toute la catégorie : tous les torrents passeraient pour les fichiers de celui-ci. Rien, alors.
  const filesOfTorrent = (t: QbTorrent) => {
    const content = (t.content_path ?? "").replace(/\/+$/, "");
    if (!content || content === (t.save_path ?? "").replace(/\/+$/, "")) return [];
    const local = localPath(content);
    // Ni une racine, ni un dossier de catégorie (enfant direct des partages) : ce serait les fichiers de
    // tous les torrents de la catégorie.
    if ([MEDIA_ROOT, MOVIES_PATH, TV_PATH, SEEDS_PATH].includes(local) || path.dirname(local) === SEEDS_PATH) return [];
    return filesUnder(local);
  };

  // Un fichier de ce torrent lié dans la bibliothèque ailleurs que sous ce titre : on n'y touche pas.
  const sharedElsewhere = (files: readonly DiskFile[]) =>
    files.some((f) =>
      (input.index.byInode.get(f.inode) ?? []).some((link) => libraryRoots.some((r) => under(link.path, r)) && !under(link.path, input.folder))
    );
  const chosen = new Map<string, { t: QbTorrent; why: TriPlan["torrents"][number]["why"] }>();
  const skipped: { hash: string; name: string; reason: string }[] = [];
  for (const t of input.torrents) {
    const files = filesOfTorrent(t);
    const shares = files.some((f) => titleInodes.has(f.inode));
    const fromHistory = input.historyHashes.has(t.hash.toLowerCase());
    if (!shares && !fromHistory) continue;
    if (sharedElsewhere(files)) {
      skipped.push({ hash: t.hash, name: t.name, reason: "fichier partagé avec un autre titre" });
      continue;
    }
    chosen.set(t.hash, { t, why: shares ? "fichier commun" : "historique" });
  }
  // Le même contenu sous un autre torrent (même nom, même taille) : un cross-seed qui n'a pas encore de
  // lien commun, ou dont les fichiers sont ailleurs.
  for (const t of input.torrents) {
    if (chosen.has(t.hash)) continue;
    if (![...chosen.values()].some((c) => c.t.name === t.name && c.t.size === t.size)) continue;
    if (sharedElsewhere(filesOfTorrent(t))) skipped.push({ hash: t.hash, name: t.name, reason: "fichier partagé avec un autre titre" });
    else chosen.set(t.hash, { t, why: "même contenu" });
  }

  // Ce que le disque récupère : un inode dont tous les liens partent avec la suppression.
  const removedPaths = new Set<string>(libraryFiles.map((f) => f.path));
  for (const { t } of chosen.values()) for (const f of filesOfTorrent(t)) removedPaths.add(f.path);
  let freed = 0;
  const counted = new Set<string>();
  for (const p of removedPaths) {
    const f = byPath.get(p);
    if (!f || counted.has(f.inode)) continue;
    counted.add(f.inode);
    const links = input.index.byInode.get(f.inode) ?? [f];
    const goneLinks = links.filter((l) => removedPaths.has(l.path)).length;
    if (goneLinks >= f.links) freed += f.size;
  }

  const torrents = [...chosen.values()]
    .map(({ t, why }) => ({ hash: t.hash, name: t.name, category: t.category, sizeBytes: t.size, why }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([input.kind, input.id, libraryFiles.map((f) => [f.path, f.size]), torrents.map((t) => t.hash)]))
    .digest("hex")
    .slice(0, 16);
  return {
    kind: input.kind,
    id: input.id,
    title: input.title,
    libraryFiles: libraryFiles.map((f) => ({ path: f.path.slice(MEDIA_ROOT.length + 1), sizeBytes: f.size })),
    torrents,
    freedBytesEstimate: freed,
    jellyseerrMediaId: input.jellyseerrMediaId,
    requests: input.requests,
    fingerprint,
    skipped,
  };
}

/** Le plan d'un titre, lu en vrai : Radarr ou Sonarr, qBittorrent, l'historique, le disque. */
/**
 * `freshDisk` : relire le disque plutôt que l'index des dix dernières minutes. L'aperçu s'en passe (un
 * parcours complet prend 15 à 25 s) ; la suppression l'exige, et refuse si le plan a changé depuis.
 */
export async function planRemoval(kind: TriKind, id: number, meta: { jellyseerrMediaId: number | null; requests: number }, freshDisk = false) {
  // Le titre seul, relu à l'instant (pas la liste entière : 4,9 Mo chez Radarr).
  const item = await (kind === "movie" ? radarr.getMovie(id) : sonarr.getSeriesById(id)).catch(() => null);
  if (!item || !item.path) throw new Error("titre introuvable dans Radarr ou Sonarr");
  const folder = localPath(item.path);
  // Le dossier du titre doit être dans la bibliothèque, et pas la racine elle-même.
  if (!(under(folder, MOVIES_PATH) || under(folder, TV_PATH)) || folder === MOVIES_PATH || folder === TV_PATH) {
    throw new Error(`dossier hors de la bibliothèque : ${item.path}`);
  }
  // Le disque d'abord, les services ensuite — jamais en même temps (voir `fsSlot`).
  const index = await diskIndex(freshDisk);
  const [torrents, history] = await Promise.all([
    qbittorrent.getTorrents(),
    (kind === "movie" ? radarr.getMovieHistory(id) : sonarr.getSeriesHistory(id)).catch(() => [] as { downloadId?: string }[]),
  ]);
  const historyHashes = new Set<string>(
    (history as { downloadId?: string }[]).map((h) => (h.downloadId ?? "").toLowerCase()).filter((h) => /^[0-9a-f]{40}$/.test(h))
  );
  return buildPlan({ kind, id, title: item.title, folder, torrents, historyHashes, index, ...meta });
}
