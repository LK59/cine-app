import { catalogueMembers } from "@/lib/catalogueMembers";
import { taskLog } from "@/lib/taskLog";
import { setupDone } from "@/lib/settings/setup";
import { asJellyfinWitness } from "@/lib/jellyfinBreaker";
import {
  cachedJellyfinFirstEpisodes,
  cachedJellyfinRecentEpisodes,
  cachedJellyfinSeasons,
  startKeptCacheRefresh,
} from "@/lib/server-cache";

/**
 * Les listes de la bibliothèque en mémoire dès le démarrage, puis gardées chaudes (15/10/2026) —
 * voir `withKeptCache`.
 *
 * Chaque déploiement recrée le conteneur, plusieurs fois par jour : sans cette première lecture, la
 * première ouverture qui suivait attendait Jellyfin et Radarr (~1,1 s de route). Ce qu'elle lit est
 * ce que lisent les quatre routes de l'ouverture : les quatre listes du catalogue et leurs
 * rapprochements (`catalogueMembers`, épisodes comptés des séries « Jellyfin seul » compris), et ce
 * que la route des séries y ajoute. Rien de propre à un compte.
 */
const FIRST_READ_DELAY_MS = 2_000;

let started = false;
/** Une installation neuve attend la fin de l'assistant avant de lire ses services (voir plus bas). */
let awaitingSetup: ReturnType<typeof setInterval> | null = null;

export function startCatalogueWarm(): void {
  if (started) return;
  // Pas avant la fin de l'assistant (19/11/2026, installation à blanc) : sur une installation neuve, la
  // lecture partait vers l'adresse par défaut de Jellyfin, et une erreur « jellyfin:8096 ne répond pas »
  // était la première chose qu'on lisait dans les journaux en y cherchant le code d'installation.
  if (!setupDone()) {
    awaitingSetup ??= setInterval(() => {
      if (!setupDone()) return;
      if (awaitingSetup) clearInterval(awaitingSetup);
      awaitingSetup = null;
      startCatalogueWarm();
    }, 30_000);
    awaitingSetup.unref?.();
    return;
  }
  started = true;
  startKeptCacheRefresh();
  const first = setTimeout(() => {
    // Chacune pour soi : une source absente au démarrage ne retient pas les autres, et elle sera lue
    // à la première ouverture comme avant.
    // En témoin, comme les relectures du minuteur (`refreshKeptCache`) : quatre listes entières
    // demandées ensemble au démarrage ne doivent pas suffire à déclarer Jellyfin en panne.
    const startedAt = Date.now();
    void asJellyfinWitness(() =>
      Promise.allSettled([
        catalogueMembers(),
        cachedJellyfinFirstEpisodes(),
        cachedJellyfinSeasons(),
        cachedJellyfinRecentEpisodes(),
      ])
    )
      // Puis les deux catalogues par leurs propres routes, une fois les listes en mémoire — voir
      // `selfWarm.ts`. Importé ici et pas en tête : le module tire `node:crypto`.
      .then(() => import("@/lib/selfWarm"))
      .then(({ runSelfWarm }) => runSelfWarm())
      .then(() => taskLog("catalogue", "library lists and catalogues loaded in memory", { s: (Date.now() - startedAt) / 1000 }))
      .catch(() => {})
      // Fini, réussi ou non : ce qui attend son tour pour ne pas lui faire concurrence peut partir. Un
      // symbole partagé plutôt qu'un import : ce module ne dépend de rien d'autre.
      .finally(() => {
        (globalThis as unknown as Record<symbol, unknown>)[Symbol.for("laterna.catalogueWarmedAt")] = Date.now();
      });
  }, FIRST_READ_DELAY_MS);
  (first as { unref?: () => void }).unref?.();
}
