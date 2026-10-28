/**
 * Ce que le service worker a coûté à la première requête du flux d'une ouverture — mesuré, rien n'en
 * dépend (28/10/2026).
 *
 * Toute requête de la page passe par le worker, même celles qu'il laisse filer (le flux, ses plages) :
 * éveillé, quelques millisecondes ; endormi — iOS l'arrête après une trentaine de secondes sans
 * travail —, le relancer en coûte bien plus, et c'est souvent le cas à l'appui sur Lire après avoir
 * parcouru des fiches. Safari 27 permet de déclarer d'avance les adresses qui ne passent jamais par
 * lui (« static routing ») ; avant de toucher au worker, on mesure ce que ça rapporterait : `swMs`
 * sur la ligne `opening`, l'écart entre le moment où le navigateur se tourne vers le worker
 * (`workerStart`) et celui où la requête part vraiment (`fetchStart`). `sw: "hors"` : la requête n'a
 * pas touché de worker (page non contrôlée).
 *
 * Un observateur posé au montage du lecteur plutôt qu'une lecture à la fin : le tampon des mesures du
 * navigateur s'arrête à 250 entrées, que les affiches d'un accueil remplissent.
 */

const STREAM_PATH = "/api/jellyfin/stream/";

export interface StreamRequestWatch {
  /** Les champs de la ligne `opening`, vides tant que la requête n'est pas finie. */
  fields(): Record<string, unknown>;
  stop(): void;
}

/** @param since l'instant du montage du lecteur (`performance.now()`) : une requête d'avant n'est pas la sienne. */
export function watchFirstStreamRequest(since: number): StreamRequestWatch {
  let entry: PerformanceResourceTiming | null = null;
  let observer: PerformanceObserver | null = null;
  if (typeof PerformanceObserver !== "undefined") {
    try {
      observer = new PerformanceObserver((list) => {
        if (entry) return;
        for (const e of list.getEntries() as PerformanceResourceTiming[]) {
          if (e.startTime < since) continue;
          try {
            if (!new URL(e.name).pathname.startsWith(STREAM_PATH)) continue;
          } catch {
            continue;
          }
          entry = e;
          observer?.disconnect();
          break;
        }
      });
      // `buffered` : la requête a pu partir avant que l'observateur soit posé (effets du montage).
      observer.observe({ type: "resource", buffered: true });
    } catch {
      observer = null;
    }
  }
  return {
    fields() {
      if (!entry) return {};
      if (!(entry.workerStart > 0)) return { sw: "hors" };
      return { swMs: Math.max(0, Math.round(entry.fetchStart - entry.workerStart)) };
    },
    stop() {
      observer?.disconnect();
    },
  };
}
