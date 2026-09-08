import { noteUnauthorized } from "@/lib/sessionExpired";
import { withCode } from "@/lib/upstreamError";

/**
 * A mutating call whose failure reaches the screen.
 *
 * Every action in this app was written the same way — `await fetch(...)` and then straight on to
 * refreshing the list — so a request that came back 404 or 502 looked exactly like one that
 * worked: nothing moved, nothing was said. That is how the pause button in Downloads went on
 * being dead through a qBittorrent upgrade without anybody being able to tell why.
 *
 * Throws with whatever the server explained, so the caller only has to say it.
 */
export async function apiAction(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init?.headers } : init?.headers,
  });

  if (!res.ok) {
    // Une action tentée sur une session disparue n'a pas d'erreur utile à afficher : elle a une
    // reconnexion à demander.
    noteUnauthorized(res);
    // The app's own routes answer `{ error }`; anything else is quoted as it came.
    const body = await res.json().catch(() => null) as { error?: string; code?: string } | null;
    // Le code voyage avec le message : sans lui, l'écran ne peut que répéter une phrase venue
    // d'ailleurs. Voir `upstreamError`.
    throw withCode(new Error(body?.error || `${res.status} ${res.statusText}`), body?.code);
  }

  return res.json().catch(() => null);
}
