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
  // Un formulaire porte son propre type, avec la frontière qui sépare ses parties : lui imposer
  // du JSON rendait les captures d'un signalement illisibles pour le serveur (24/09/2026).
  const json = init?.body && !(init.body instanceof FormData);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: json ? { "Content-Type": "application/json", ...init?.headers } : init?.headers,
    });
  } catch (error) {
    // Une annulation voulue reste ce qu'elle est : l'appelant la reconnaît à son nom.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    /**
     * Le serveur n'a pas pu être joint (15/10/2026, passe de nuit, BUREAU-7) : un Wi-Fi qui tombe,
     * un redémarrage pendant un déploiement. `fetch` lève alors un `TypeError` dont le message est
     * celui du navigateur — « Failed to fetch », « Load failed », « NetworkError when attempting to
     * fetch resource. » —, et c'est ce texte anglais et technique qui s'affichait, en rouge, à un
     * compte en français. Il porte maintenant le code `network`, que l'écran traduit.
     */
    throw withCode(new Error("Serveur injoignable", { cause: error }), "network");
  }

  if (!res.ok) {
    // Une action tentée sur une session disparue n'a pas d'erreur utile à afficher : elle a une
    // reconnexion à demander.
    noteUnauthorized(res);
    // The app's own routes answer `{ error }`; anything else is quoted as it came.
    const body = await res.json().catch(() => null) as { error?: string; code?: string } | null;
    // Le code voyage avec le message : sans lui, l'écran ne peut que répéter une phrase venue
    // d'ailleurs. Voir `upstreamError`.
    //
    // Une passerelle sans corps de l'application (502, 503, 504 du relais pendant un redéploiement)
    // n'est pas une réponse de nos routes : c'est le serveur qui n'a pas été joint — même code que
    // la coupure ci-dessus, plutôt que « 502 Bad Gateway » à l'écran (BUREAU-7).
    const unreached = !body && (res.status === 502 || res.status === 503 || res.status === 504);
    throw withCode(new Error(body?.error || `${res.status} ${res.statusText}`), body?.code ?? (unreached ? "network" : undefined));
  }

  return res.json().catch(() => null);
}
