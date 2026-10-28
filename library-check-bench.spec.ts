// Le contrôle de la bibliothèque (DECISIONS.md §90) lancé sur une vraie installation, en lecture seule.
//
// Écrit le 14/10/2026 pour donner les résultats de l'analyse sur la bibliothèque de production sans
// toucher à sa base : `DATA_DIR` pointe vers un dossier jetable (le résultat et les caches TMDB y sont
// écrits, nulle part ailleurs), les services sont lus avec les adresses et clés de la production, le
// dossier des médias est monté en lecture seule.
//
//   docker exec cine-app env | grep -E '^(JELLYFIN|RADARR|SONARR|TMDB)_' > /tmp/x/env
//   docker run --rm --network media_net --env-file /tmp/x/env -v "$PWD":/app -w /app --tmpfs /banc \
//     -v /mnt/media/video:/mnt/media/video:ro -e LIBRARY_CHECK_LIVE=/banc -e LIBRARY_CHECK_OUT=/app/…/out.json \
//     node:26-alpine npx vitest run library-check-bench.spec.ts
import { describe, it } from "vitest";
import { writeFileSync } from "node:fs";

const BANC = process.env.LIBRARY_CHECK_LIVE;
if (BANC) process.env.DATA_DIR = BANC;

describe.skipIf(!BANC)("contrôle de la bibliothèque, en vrai", () => {
  it("analyse et résume", async () => {
    const { startLibraryCheck, libraryCheckStatus } = await import("@/lib/libraryCheck/run");
    await startLibraryCheck();
    const { result, error } = libraryCheckStatus();
    if (!result) throw new Error(error ?? "pas de résultat");
    if (process.env.LIBRARY_CHECK_OUT) writeFileSync(process.env.LIBRARY_CHECK_OUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ durationMs: result.durationMs, sources: result.sources, counts: result.counts }));
  }, 600_000);
});
