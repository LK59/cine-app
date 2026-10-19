// La « version allégée » suppose que Jellyfin ait le droit de transcoder la vidéo pour ce compte
// (DECISIONS.md §78) : c'est un transcodage, à débit réduit. La politique du compte le dit
// (`Policy.EnableVideoPlaybackTranscoding`, `/Users/{id}`, lu à la clé d'administration comme les
// tags bloqués). Sans ce droit, Jellyfin refuserait le flux réduit : le lecteur ne prépare ni ne
// bascule jamais sur elle, et une connexion trop lente finit sur l'écran « Lecture impossible… »
// (Réessayer · Fermer), comme en « Originale ».
//
// L'autre condition — un lecteur serveur sur cette installation (`PLAYER_SERVER_FALLBACK`) — est lue
// côté navigateur par `usePlayerServerFallback`.
//
// La même lecture donne le droit de télécharger (`Policy.EnableContentDownloading`, 19/10/2026) :
// « Télécharger le fichier », dans le ⋮ du lecteur au bureau, ne s'offre et ne sert qu'à un compte
// qui l'a — voir `contentDownloadingAllowed`.

import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { jellyfinFetch } from "@/lib/jellyfinBreaker";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";

/** Relue toutes les deux minutes, comme les tags bloqués : un droit retiré s'applique vite. */
const TTL_MS = 2 * 60 * 1000;
const TIMEOUT_MS = 5000;

const cache = new Map<string, { allowed: boolean; download: boolean; at: number }>();

/** Pour les tests. */
export function forgetTranscodePolicy(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Ce que l'ouverture d'un film attend au plus de cette question (`/direct`, `/playback/start`) : elle
 * part avec eux, en parallèle, et un Jellyfin qui traîne ne doit pas retarder la première image. Au-delà,
 * la dernière réponse connue, sinon oui ; la lecture de la politique continue et remplit le cache.
 */
const WAIT_MS = 300;
/** Une seule lecture en vol par compte : les deux routes d'une ouverture la partagent. */
const inflight = new Map<string, Promise<boolean>>();

async function readPolicy(jfId: string, fallback: boolean, now: number): Promise<boolean> {
  try {
    const res = await jellyfinFetch(`${config.jellyfin.url}/Users/${jellyfinIdSegment(jfId)}`, {
      headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return fallback;
    const user = (await res.json()) as { Policy?: { EnableVideoPlaybackTranscoding?: boolean; EnableContentDownloading?: boolean } };
    const allowed = user.Policy?.EnableVideoPlaybackTranscoding !== false;
    // Absent, refusé : un fichier entier ne part qu'avec un oui explicite de Jellyfin.
    const download = user.Policy?.EnableContentDownloading === true;
    cache.set(jfId, { allowed, download, at: now });
    return allowed;
  } catch {
    return fallback;
  }
}

/**
 * Jellyfin peut-il transcoder la vidéo pour ce compte ? Sans réponse : la dernière connue, sinon oui
 * — le défaut de Jellyfin, et un refus éventuel se verrait comme un échec ordinaire du lecteur
 * serveur plutôt que comme une version allégée qui manque à tout le monde le jour où Jellyfin
 * redémarre. Jamais plus de `WAIT_MS` d'attente.
 */
export async function videoTranscodingAllowed(jfId: string | null | undefined, now = Date.now()): Promise<boolean> {
  if (!jfId) return true;
  const known = cache.get(jfId);
  if (known && now - known.at < TTL_MS) return known.allowed;
  const fallback = known?.allowed ?? true;
  let pending = inflight.get(jfId);
  if (!pending) {
    pending = readPolicy(jfId, fallback, now).finally(() => inflight.delete(jfId));
    inflight.set(jfId, pending);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(fallback), WAIT_MS);
  });
  try {
    return await Promise.race([pending, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ce compte peut-il télécharger un fichier de la bibliothèque ? `Policy.EnableContentDownloading`,
 * relu comme le reste toutes les deux minutes — un droit retiré dans Jellyfin s'applique vite.
 *
 * L'inverse de `videoTranscodingAllowed` dans le doute : sans réponse de Jellyfin, **non**. Ce n'est
 * pas une lecture qui échoue, c'est un fichier entier qui sort de la bibliothèque, et rien n'attend
 * cette réponse pour démarrer — ni délai court, ni dernière valeur prise pour un oui.
 */
export async function contentDownloadingAllowed(jfId: string | null | undefined, now = Date.now()): Promise<boolean> {
  if (!jfId) return false;
  const known = cache.get(jfId);
  if (known && now - known.at < TTL_MS) return known.download;
  let pending = inflight.get(jfId);
  if (!pending) {
    pending = readPolicy(jfId, known?.allowed ?? true, now).finally(() => inflight.delete(jfId));
    inflight.set(jfId, pending);
  }
  await pending;
  // Une lecture échouée ne remplit rien : il ne reste qu'une réponse périmée, qui ne vaut pas un oui.
  const read = cache.get(jfId);
  return !!read && now - read.at < TTL_MS ? read.download : false;
}
