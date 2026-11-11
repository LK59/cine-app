/**
 * Les erreurs du chalet, envoyées au serveur comme celles du cinéma (`reportClientError` de l'application, route
 * `/api/client-error`, `scope: "client"` dans `data/logs/server.log`), avec une source `immersion:…` :
 * `immersion:window` (ce que rien n'a attrapé), `immersion:rejection` (une promesse rejetée que personne n'attendait),
 * `immersion:crash` (la barrière de l'écran « Crashed »), `immersion:webgl` (le contexte graphique perdu).
 *
 * Jusqu'en 10.37.3 le chalet n'envoyait aucune erreur : un visiteur a vu « des écrans noirs en marchant » et rien,
 * nulle part, n'en gardait la trace. Le code de l'application n'est pas importé tel quel (il ne s'arrête pas sur un
 * refus, voir plus bas) : même route, même forme de rapport.
 *
 * Borné : au plus `MAX_SENT` envois par visite, une seule fois par source et message — une erreur jetée à chaque
 * image enverrait sinon soixante requêtes par seconde. Et **une réponse 4xx arrête tout envoi** : le pare-feu du
 * serveur (CrowdSec, `http-probing`) bannit une adresse qui accumule les 400/403/404 en quelques secondes, et une
 * session expirée répondrait 403 à chaque erreur suivante. Incapable d'échouer bruyamment : un rapport qui lève
 * sur le chemin d'erreur de quelqu'un d'autre devient l'erreur.
 */
const MAX_SENT = 5;

type Source = "window" | "rejection" | "crash" | "webgl";

const state = {
  sent: 0,
  stopped: false,
  seen: new Set<string>(),
};

/** Ce que la ligne de visite (`autoLog.ts`) en dit : toutes les erreurs vues, envoyées ou non, et les pertes du contexte. */
export const visitErrors = { errors: 0, contextLost: 0 };

/** Le bruit qu'on ne veut pas lire — la même liste que l'application (`isNoise` de `reportClientError`). */
function isNoise(name: string, message: string, stack: string): boolean {
  if (name === "AbortError") return true;
  if (/^ResizeObserver loop/.test(message)) return true;
  if (message === "Script error." || message === "Script error") return true;
  return /(chrome|moz|safari(-web)?)-extension:\/\//.test(stack);
}

function describe(error: unknown): { name: string; message: string; stack: string } {
  const described = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
  const errorLike = typeof error === "object" && error !== null && typeof described?.message === "string";
  const name = errorLike && typeof described?.name === "string" ? described.name : typeof error;
  let message: string;
  if (errorLike) message = described?.message as string;
  else if (typeof error === "string") message = error;
  else {
    try {
      message = JSON.stringify(error) ?? String(error);
    } catch {
      message = String(error);
    }
  }
  const stack = errorLike && typeof described?.stack === "string" ? described.stack : "";
  return { name, message, stack };
}

/** Envoie une erreur (sans attendre). `count` : compter l'erreur dans la ligne de visite (pas pour une perte du contexte, comptée à part). */
export function reportError(error: unknown, source: Source, count = true): void {
  try {
    const { name, message, stack } = describe(error);
    if (isNoise(name, message, stack)) return;
    if (count) visitErrors.errors += 1;
    if (state.stopped || state.sent >= MAX_SENT) return;
    const key = `${source}|${message}`;
    if (state.seen.has(key)) return;
    state.seen.add(key);
    state.sent += 1;
    void fetch("/api/client-error", {
      method: "POST",
      credentials: "same-origin",
      keepalive: true,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: `immersion:${source}`, name, message, stack, url: `${location.pathname}${location.hash}` }),
    }).then(
      (response) => {
        if (response.status >= 400 && response.status < 500) state.stopped = true;
      },
      () => undefined
    );
  } catch {
    // Rien ici ne vaut une page cassée.
  }
}

/**
 * Le contexte WebGL perdu (`World.tsx`) : compté pour la ligne de visite, et envoyé comme une erreur, avec ce qui
 * aide à la lire — l'instant de la visite, la qualité et la pièce.
 */
export function reportContextLost(detail: string): void {
  visitErrors.contextLost += 1;
  reportError({ name: "WebGLContextLost", message: `Contexte WebGL perdu (${detail})` }, "webgl", false);
}

/** Écoute ce qu'aucune barrière React n'attrape. Rend la fonction qui cesse d'écouter. */
export function watchErrors(): () => void {
  const onError = (event: ErrorEvent) => reportError(event.error ?? event.message, "window");
  const onRejection = (event: PromiseRejectionEvent) => reportError(event.reason, "rejection");
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
