import { taskLog } from "@/lib/taskLog";
import { logError } from "@/lib/logger";

/**
 * Les calculs de la page Statistiques préparés au démarrage (13/11/2026).
 *
 * Chaque déploiement recrée le conteneur ; la première ouverture de Statistiques qui suivait trouvait
 * tout à faire — la mesure du disque, l'analyse du stockage (8 à 13 s sur la vraie bibliothèque), les
 * acteurs et réalisateurs (un appel TMDB par titre, gardé une semaine sur disque) — et la page se
 * remplissait par morceaux, bloc après bloc. Ici ils partent seuls, **après** les préchauffages du
 * catalogue (`catalogueWarm`, qui pose `laterna.catalogueWarmedAt`), qu'ils ne doivent jamais
 * concurrencer : les mêmes listes Radarr/Sonarr sont alors en mémoire. Trente secondes après le
 * démarrage, puis toutes les cinq secondes tant que le catalogue n'est pas prêt, deux minutes au plus
 * — le modèle de `books/prewarm.ts`. L'un après l'autre : le disque et l'analyse, puis les personnes.
 *
 * L'analyse rend la main à la boucle toutes les ~20 ms (`loopBreather`) : préparée ici, elle ne fige
 * pas plus le serveur qu'ouverte par l'administrateur.
 *
 * Derrière `CINE_BACKGROUND_JOBS` (`instrumentation.ts`) : une copie de test n'a pas à parcourir le
 * disque ni à appeler TMDB d'elle-même. Elle calcule toujours à la première ouverture de la page.
 */

const FIRST_DELAY_MS = 30_000;
const RETRY_MS = 5_000;
const MAX_WAIT_MS = 120_000;
const CATALOGUE_WARMED = Symbol.for("laterna.catalogueWarmedAt");

interface State { started: boolean; running: Promise<void> | null }
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[Symbol.for("laterna.statsPrewarm")] ??= { started: false, running: null });
}

const catalogueWarmed = () => typeof (globalThis as unknown as Record<symbol, unknown>)[CATALOGUE_WARMED] === "number";

/** Les trois calculs, l'un après l'autre. Chacun pour soi : un échec ne retient pas le suivant. */
export function prewarmStats(): Promise<void> {
  const s = state();
  s.running ??= (async () => {
    const startedAt = Date.now();
    try {
      // Importés ici : le chargement de `disk-stats` lance sa mesure, et rien de tout ça ne doit
      // partir avant son tour.
      const { getDiskStats } = await import("@/lib/disk-stats");
      getDiskStats();
      const { warmStorageStats } = await import("@/lib/storage-scan");
      await warmStorageStats();
      const storageS = (Date.now() - startedAt) / 1000;
      const { warmPeopleStats } = await import("@/lib/peopleStats");
      await warmPeopleStats();
      taskLog("statistiques", "analyse du stockage et personnes préparées", { stockageS: storageS, s: (Date.now() - startedAt) / 1000 });
    } catch (err) {
      logError("stats.prechauffage", err);
    } finally {
      s.running = null;
    }
  })();
  return s.running;
}

export function startStatsPrewarm(now = Date.now): void {
  const s = state();
  if (s.started) return;
  s.started = true;
  const startedAt = now();
  const attempt = () => {
    if (!catalogueWarmed() && now() - startedAt < MAX_WAIT_MS) {
      const t = setTimeout(attempt, RETRY_MS);
      (t as { unref?: () => void }).unref?.();
      return;
    }
    void prewarmStats();
  };
  const first = setTimeout(attempt, FIRST_DELAY_MS);
  (first as { unref?: () => void }).unref?.();
}

export const __testing = {
  reset: () => {
    Object.assign(state(), { started: false, running: null });
    delete (globalThis as unknown as Record<symbol, unknown>)[CATALOGUE_WARMED];
  },
};
