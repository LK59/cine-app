// La « version allégée » suppose que Jellyfin ait le droit de transcoder la vidéo pour ce compte
// (DECISIONS.md §78) : c'est un transcodage, à débit réduit. La politique du compte le dit
// (`Policy.EnableVideoPlaybackTranscoding`, `/Users/{id}`, lu à la clé d'administration comme les
// tags bloqués). Sans ce droit, Jellyfin refuserait le flux réduit : le bouton n'est pas proposé, et
// les scénarios de connexion lente n'offrent que Réessayer et Fermer.
//
// L'autre condition — un lecteur serveur sur cette installation (`PLAYER_SERVER_FALLBACK`) — est lue
// côté navigateur par `usePlayerServerFallback`.

import { config } from "@/lib/config";
import { jellyfinAuthHeaders } from "@/lib/jellyfinAuth";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";

/** Relue toutes les deux minutes, comme les tags bloqués : un droit retiré s'applique vite. */
const TTL_MS = 2 * 60 * 1000;
const TIMEOUT_MS = 5000;

const cache = new Map<string, { allowed: boolean; at: number }>();

/** Pour les tests. */
export function forgetTranscodePolicy(): void {
  cache.clear();
}

/**
 * Jellyfin peut-il transcoder la vidéo pour ce compte ? Sans réponse : la dernière connue, sinon oui
 * — le défaut de Jellyfin, et un refus éventuel se verrait comme un échec ordinaire du lecteur
 * serveur plutôt que comme un bouton qui manque à tout le monde le jour où Jellyfin redémarre.
 */
export async function videoTranscodingAllowed(jfId: string | null | undefined, now = Date.now()): Promise<boolean> {
  if (!jfId) return true;
  const known = cache.get(jfId);
  if (known && now - known.at < TTL_MS) return known.allowed;
  try {
    const res = await fetch(`${config.jellyfin.url}/Users/${jellyfinIdSegment(jfId)}`, {
      headers: jellyfinAuthHeaders(config.jellyfin.apiKey),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return known?.allowed ?? true;
    const user = (await res.json()) as { Policy?: { EnableVideoPlaybackTranscoding?: boolean } };
    const allowed = user.Policy?.EnableVideoPlaybackTranscoding !== false;
    cache.set(jfId, { allowed, at: now });
    return allowed;
  } catch {
    return known?.allowed ?? true;
  }
}
