// L'analyse du stockage (page Statistiques) lancée sur la vraie bibliothèque, pour mesurer combien de temps
// elle tient la boucle d'évènements d'un trait (13/11/2026).
//
// Elle la tenait 3,7 à 5,8 s avant le découpage du rapprochement (`loopBreather`). Ce banc a ensuite trouvé
// ce qui restait : 250 à 770 ms pendant le parcours du disque (~35 000 `stat`/`readdir` lancés d'un coup,
// relus en une passe — `fsSlots`), ~150 ms à la sortie du parcours et 80 à 100 ms pour les dates d'import.
// Mesuré le 13/11/2026 après correction : 63 ms (premier passage) et 74 ms (second) au plus, la lecture de
// la liste qBittorrent (`res.json()`, d'un bloc), pour 6,6 à 6,9 s d'analyse et les mêmes résultats.
//
// En lecture seule : `DATA_DIR` jetable, Radarr/Sonarr/qBittorrent lus avec les adresses et clés de la
// production (sans clé TMDB : les titres traduits ne partent pas les chercher), médias en lecture seule.
//
//   docker exec cine-app env | grep -E '^(RADARR|SONARR|QBITTORRENT)_' > /tmp/x/env
//   docker run --rm --network <réseau de cine-app> --env-file /tmp/x/env -v "$PWD":/app -w /app --tmpfs /banc \
//     -v /mnt/media/video:/mnt/media/video:ro -e STATS_SCAN_LIVE=/banc node:26-alpine npx vitest run stats-scan-bench.spec.ts
import { describe, it } from "vitest";
import { monitorEventLoopDelay } from "node:perf_hooks";

const BANC = process.env.STATS_SCAN_LIVE;
if (BANC) process.env.DATA_DIR = BANC;

describe.skipIf(!BANC)("analyse du stockage, en vrai", () => {
  it("mesure le plus long blocage de la boucle", async () => {
    const { warmStorageStats, getStorageStats } = await import("@/lib/storage-scan");
    // Deux passages : le premier paie aussi le chargement des listes Radarr/Sonarr dans le cache.
    for (const pass of ["froid", "chaud"]) {
      const h = monitorEventLoopDelay({ resolution: 5 });
      h.enable();
      const startedAt = performance.now();
      await warmStorageStats();
      h.disable();
      const s = getStorageStats();
      console.log(JSON.stringify({
        pass,
        ms: Math.round(performance.now() - startedAt),
        maxBlockMs: Math.round(h.max / 1e6),
        p99BlockMs: Math.round(h.percentile(99) / 1e6),
        error: s.error,
        seedOrphans: s.seedOrphans.length,
        duplicates: s.duplicates.length,
      }));
      if (pass === "froid") {
        // Expiré d'office pour le second passage.
        const st = (globalThis as unknown as Record<symbol, { cached: { computedAt: number } | null }>)[Symbol.for("laterna.storageScan")];
        if (st.cached) st.cached.computedAt = 0;
      }
    }
  }, 600_000);
});
