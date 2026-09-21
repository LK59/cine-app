"use client";

/**
 * Une erreur du navigateur, envoyée au serveur pour qu'elle existe ailleurs que sur l'écran.
 *
 * Jusqu'au 21/09/2026, un plantage côté navigateur ne laissait aucune trace : les écrans d'erreur
 * écrivaient dans une console que personne n'ouvre sur un téléphone, et la barrière qui entoure le
 * lecteur à la racine faisait disparaître le film sans un mot. Le serveur, lui, a son journal
 * depuis le 08/09 — mais une erreur qui naît dans le navigateur n'y passait jamais. Sur dix-huit
 * comptes, on ne l'apprenait que si quelqu'un pensait à le dire.
 *
 * Même contrat que `reportPlayback` : envoyé sans attendre, `keepalive` pour survivre à une page
 * qui s'en va, et incapable d'échouer bruyamment — un rapport d'erreur qui lève sur le chemin
 * d'erreur de quelqu'un d'autre devient l'erreur.
 */

export type ClientErrorSource =
  /** Un `error.tsx` de Next, ou `global-error.tsx`. */
  | `boundary:${string}`
  /** Une barrière posée à la main (`ErrorBoundary`), nommée par ce qu'elle entoure. */
  | `component:${string}`
  /** Ce que rien n'a attrapé : `window.onerror`. */
  | "window"
  /** Une promesse rejetée que personne n'attendait. */
  | "rejection";

/**
 * Borné par page, et dédoublonné : une erreur jetée à chaque image d'une animation — ça arrive,
 * dans un rendu qui boucle — enverrait soixante requêtes par seconde et noierait le journal, au
 * point d'en faire tourner la rotation et d'effacer ce qu'il contenait d'utile.
 */
const MAX_PER_PAGE = 20;
const seen = new Set<string>();

/**
 * Le bruit qu'on ne veut pas lire.
 *
 * - `ResizeObserver loop…` : un avertissement du navigateur habillé en erreur, sans conséquence.
 * - `Script error.` : une erreur d'un script d'une autre origine, dont le navigateur masque tout
 *   — il n'y a rien à en apprendre.
 * - `AbortError` : une requête qu'on a annulée soi-même (un écran qu'on quitte, une recherche
 *   remplacée). C'est le fonctionnement normal, pas une panne.
 * - une pile qui passe par une extension : pas notre code, pas notre panne.
 */
function isNoise(name: string, message: string, stack: string): boolean {
  if (name === "AbortError") return true;
  if (/^ResizeObserver loop/.test(message)) return true;
  if (message === "Script error." || message === "Script error") return true;
  if (/(chrome|moz|safari(-web)?)-extension:\/\//.test(stack)) return true;
  return false;
}

export function reportClientError(error: unknown, source: ClientErrorSource, extra?: Record<string, string>): void {
  try {
    // Lu sur tout ce qui porte un nom et un message, pas seulement sur les `Error` : une
    // `DOMException` — l'`AbortError` d'une requête annulée — n'en est pas une partout, et elle
    // passait sinon le filtre du bruit, décrite comme « {} ».
    const described = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
    const errorLike = typeof error === "object" && error !== null && typeof described?.message === "string";
    const name = errorLike && typeof described?.name === "string" ? described.name : typeof error;
    const message = errorLike
      ? (described?.message as string)
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error) ?? String(error);
            } catch {
              return String(error);
            }
          })();
    const stack = errorLike && typeof described?.stack === "string" ? described.stack : "";
    if (isNoise(name, message, stack)) return;

    const key = `${source}|${message}`;
    if (seen.has(key) || seen.size >= MAX_PER_PAGE) return;
    seen.add(key);

    const digest = (error as { digest?: unknown } | null)?.digest;
    void fetch("/api/client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source,
        name,
        message,
        stack,
        // Le chemin et l'ancre : c'est dans l'ancre que vit la navigation du cinéma (quelle fiche,
        // quel onglet), c'est-à-dire l'endroit exact où l'on était.
        url: `${location.pathname}${location.hash}`,
        ...(typeof digest === "string" ? { digest } : {}),
        ...extra,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Rien ici ne vaut une page cassée.
  }
}

/** Pour les tests : chaque cas repart d'une page neuve. */
export function forgetReportedClientErrors(): void {
  seen.clear();
}
