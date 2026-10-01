import type { DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";
import { directInfoKey } from "@/lib/playbackPrefetch";
import { fetcher } from "@/lib/swr";

/**
 * La description d'un fichier (`/api/jellyfin/direct/<id>`) — demandée d'avance par la fiche, par
 * le cache de reprise et par l'épisode suivant, et lue par le lecteur à l'ouverture.
 *
 * **Jamais plus vieille que cinq minutes.** Elle porte la taille et l'ETag du fichier, c'est-à-dire
 * ce qui décide si les octets gardés sur l'appareil sont les siens (`openDiskChunks`). Elle passait
 * par `preload` de SWR, qui garde une réponse jusqu'à ce qu'un hook la prenne — des heures s'il le
 * faut — puis par la réserve de SWR, que le lecteur ne revalide jamais. 30/09/2026, Android de
 * Lucas : *Ted Lasso* S04E09 gardé en « À suivre » vers 07:02 dans sa version 1080p, remplacé par
 * une 4K vers 07:20, ouvert à 07:32 sur la description de 07:02 — qui disait exactement ce que
 * l'appareil gardait. Le contrôle ETag/taille a donc servi l'ancien fichier (`hevc 1920x960`,
 * « depuis l'appareil »), et seul un rechargement de la page a ouvert la 4K. Sonarr remplace un
 * fichier par une meilleure version, FileFlows réencode chaque nouveau fichier : les épisodes
 * d'« À suivre » sont justement les plus exposés.
 *
 * Cinq minutes couvrent ce que l'avance sert — une fiche ouverte puis Lire, l'épisode suivant
 * préparé une minute avant le générique — sans servir la description d'un fichier d'il y a une demi-heure.
 */
export const DIRECT_INFO_FRESH_MS = 5 * 60_000;

const kept = new Map<string, { at: number; info: Promise<DirectPlayInfo> }>();

function fresh(itemId: string): Promise<DirectPlayInfo> | null {
  const entry = kept.get(itemId);
  if (!entry) return null;
  if (Date.now() - entry.at < DIRECT_INFO_FRESH_MS) return entry.info;
  kept.delete(itemId);
  return null;
}

/**
 * La description, reprise si elle est fraîche — en vol comprise —, demandée sinon. Peut rejeter
 * (l'erreur du `fetcher`, avec son code : `file_missing` grise le bouton Lire). Un échec n'est
 * jamais gardé : la demande suivante repart au serveur.
 */
export function fetchDirectInfo(itemId: string): Promise<DirectPlayInfo> {
  const current = fresh(itemId);
  if (current) return current;
  const info = fetcher(directInfoKey(itemId)) as Promise<DirectPlayInfo>;
  const entry = { at: Date.now(), info };
  kept.set(itemId, entry);
  info.catch(() => {
    if (kept.get(itemId) === entry) kept.delete(itemId);
  });
  return info;
}

/**
 * Celle que le lecteur ouvre. Une demande d'avance qui a échoué n'est pas la réponse du moment : on
 * repose la question une fois — c'est ce que faisait la fiche en relançant l'hôte qui l'attendait.
 */
export function directInfoForOpening(itemId: string): Promise<DirectPlayInfo> {
  const current = fresh(itemId);
  if (!current) return fetchDirectInfo(itemId);
  // L'entrée est déjà retirée quand ce rejet arrive ici (son propre `catch` est inscrit avant).
  return current.catch(() => fetchDirectInfo(itemId));
}

/** À la déconnexion, et pour les tests. */
export function forgetDirectInfo(): void {
  kept.clear();
}
