import { config } from "@/lib/config";
import { taskLog } from "@/lib/taskLog";
import { logError } from "@/lib/logger";

/**
 * L'index des livres préparé d'avance (DECISIONS.md §127) : personne n'attend sa première construction.
 *
 * Option allumée, le serveur le construit en arrière-plan **après** ses propres préchauffages — les
 * listes de la bibliothèque et les deux catalogues (`catalogueWarm`, `selfWarm`), qu'il ne doit jamais
 * concurrencer : trente secondes après le démarrage, puis toutes les cinq secondes tant qu'ils ne sont
 * pas finis, deux minutes au plus. Et tout de suite quand l'administrateur allume l'option, sans
 * redémarrage (`/api/settings`). Ensuite il reste chaud : toutes les quatre minutes, l'index est
 * redemandé, ce qui le fait relire derrière s'il a vieilli (le même modèle que les requêtes : la
 * dernière version est servie aussitôt). Option coupée : rien ne tourne — la minuterie s'arrête au
 * premier tour qui la trouve coupée, et aucune n'est lancée au démarrage.
 */

const FIRST_DELAY_MS = 30_000;
const RETRY_MS = 5_000;
const MAX_WAIT_MS = 120_000;
const KEEP_WARM_MS = 4 * 60_000;
/** Posé par `catalogueWarm` quand ses listes et ses catalogues sont en mémoire. */
export const CATALOGUE_WARMED = Symbol.for("laterna.catalogueWarmedAt");

interface State {
  started: boolean;
  keepWarm: ReturnType<typeof setInterval> | null;
  running: Promise<void> | null;
}
const KEY = Symbol.for("laterna.books.prewarm");
function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { started: false, keepWarm: null, running: null });
}

const enabled = () => config.books?.enabled === true;
const catalogueWarmed = () => typeof (globalThis as unknown as Record<symbol, unknown>)[CATALOGUE_WARMED] === "number";

/** Construit l'index commun (rien si l'option est coupée) et le garde chaud. */
export function prewarmBooks(why: string): Promise<void> {
  const s = state();
  if (!enabled()) return Promise.resolve();
  s.running ??= (async () => {
    const startedAt = Date.now();
    try {
      // Importé ici : l'option coupée, rien de l'index n'est chargé.
      const { warmSharedIndex } = await import("@/lib/books/bookIndex");
      const count = await warmSharedIndex();
      taskLog("livres", "index préparé", { why, books: count, s: (Date.now() - startedAt) / 1000 });
      // Google Books (option) part derrière l'index, sans rien faire si elle est coupée.
      const { startGoogleEnrich } = await import("@/lib/books/googleBooks");
      startGoogleEnrich(why);
    } catch (err) {
      // Jellyfin absent : la première ouverture le construira, comme avant. Mais dit : un préchauffage
      // qui échouait en silence laissait chaque compte payer la première construction (28/10/2026).
      logError("livres.prechauffage", err, { why });
    } finally {
      s.running = null;
    }
  })();
  if (!s.keepWarm) {
    s.keepWarm = setInterval(() => {
      if (!enabled()) {
        if (s.keepWarm) clearInterval(s.keepWarm);
        s.keepWarm = null;
        return;
      }
      void import("@/lib/books/bookIndex").then(({ keepSharedIndexWarm }) => keepSharedIndexWarm()).catch(() => {});
    }, KEEP_WARM_MS);
    (s.keepWarm as { unref?: () => void }).unref?.();
  }
  return s.running;
}

/** Au démarrage : après les préchauffages du catalogue, ou deux minutes au plus. Rien option coupée. */
export function startBooksPrewarm(now = Date.now): void {
  const s = state();
  if (s.started) return;
  s.started = true;
  const startedAt = now();
  const attempt = () => {
    if (!enabled()) return;
    if (!catalogueWarmed() && now() - startedAt < MAX_WAIT_MS) {
      const t = setTimeout(attempt, RETRY_MS);
      (t as { unref?: () => void }).unref?.();
      return;
    }
    void prewarmBooks("démarrage");
  };
  const first = setTimeout(attempt, FIRST_DELAY_MS);
  (first as { unref?: () => void }).unref?.();
}

export const __testing = {
  reset: () => {
    const s = state();
    if (s.keepWarm) clearInterval(s.keepWarm);
    Object.assign(s, { started: false, keepWarm: null, running: null });
    delete (globalThis as unknown as Record<symbol, unknown>)[CATALOGUE_WARMED];
  },
  state,
};
