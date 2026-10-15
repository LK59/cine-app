/**
 * Le temps passé dans une route, dit au navigateur : `Server-Timing: app;dur=…` (15/10/2026).
 *
 * L'ouverture attendait le catalogue 1,2 à 2,2 s une fois le code démarré (startup.log, médiane de
 * la semaine du 8 au 15/10), et rien ne disait si c'était le serveur ou la route entre l'appareil
 * et lui. Même en-tête que le relais vidéo (`stream/[itemId]`), lu de la même façon
 * (`serverTimingApp`). Il ne compte que la route : la session vérifiée par le proxy, la file
 * d'attente de Node et le réseau sont dans l'écart entre ce nombre et l'attente que le navigateur
 * mesure (`routeTimingsOf`, persistentCache.ts).
 */
export function timedRoute<Args extends unknown[]>(handler: (...args: Args) => Promise<Response>) {
  return async (...args: Args): Promise<Response> => {
    const startedAt = performance.now();
    const res = await handler(...args);
    try {
      res.headers.append("Server-Timing", `app;dur=${Math.round(performance.now() - startedAt)}`);
    } catch {
      /* des en-têtes figés : la réponse part sans la mesure */
    }
    return res;
  };
}
