// Banc de la vérification de l'intégrité (DECISIONS.md §93) — sauté sans INTEGRITY_BENCH_FILES.
//
// Mesure ce que coûte la relecture d'un fichier, en lecture seule : pour chaque ligne de
// INTEGRITY_BENCH_FILES (« raw:<chemin> » ou « scan:<chemin> ») —
//   raw   la lecture séquentielle seule, par blocs de 8 Mio, sans rien analyser : le débit du disque ;
//   scan  la relecture complète de la vérification (`SequentialFileSource` + `scanMatroska`, le
//         lecteur du lecteur natif en strict), sans plafond de débit ni attente.
// Un même fichier passé en `scan` après un `raw` est lu depuis le cache du noyau : c'est le coût du
// calcul seul. Rien n'est écrit hors de INTEGRITY_BENCH_OUT.
//
//   docker run --rm --name cine-integrity-bench -v "$PWD":/app -v /mnt/media/video:/media:ro -w /app \
//     -e INTEGRITY_BENCH_FILES=/app/f.txt -e INTEGRITY_BENCH_OUT=/app/out.jsonl node:26-alpine \
//     npx vitest run integrity-bench.spec.ts
import { describe, it } from "vitest";
import { appendFileSync, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { BLOCK_BYTES, scanMatroska, SequentialFileSource } from "@/lib/integrity/scan";
import { parseMatroska } from "@/lib/webcodecs/matroska";

describe.skipIf(!process.env.INTEGRITY_BENCH_FILES)("intégrité — débit", () => {
  it("mesure la lecture et la relecture", { timeout: 3 * 3_600_000 }, async () => {
    const lines = readFileSync(process.env.INTEGRITY_BENCH_FILES!, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const [mode, ...rest] = line.split(":");
      const path = rest.join(":");
      const t0 = performance.now();
      const row: Record<string, unknown> = { mode, file: path.split("/").pop() };
      if (mode === "raw") {
        const handle = await open(path, "r");
        const buffer = new Uint8Array(BLOCK_BYTES);
        let position = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, BLOCK_BYTES, position);
          if (bytesRead <= 0) break;
          position += bytesRead;
        }
        await handle.close();
        row.bytes = position;
      } else {
        // L'en-tête et l'index seuls (`parseMatroska`, servi de la mémoire une fois lu) : leur retard de boucle à part.
        {
          const header = await SequentialFileSource.open(path, { beforeBlock: async () => {} });
          let lag = 0;
          let at = performance.now();
          const watch = setInterval(() => {
            const now = performance.now();
            lag = Math.max(lag, now - at - 10);
            at = now;
          }, 10);
          await parseMatroska(header);
          await new Promise((r) => setTimeout(r, 30));
          clearInterval(watch);
          header.close();
          row.headerLoopLagMs = Math.round(lag);
        }
        let blocks = 0;
        let longestGapMs = 0;
        let last = performance.now();
        const source = await SequentialFileSource.open(path, {
          beforeBlock: async () => {
            blocks++;
            const now = performance.now();
            longestGapMs = Math.max(longestGapMs, now - last);
            last = now;
          },
        });
        // Le plus long retard de la boucle d'événements pendant la relecture : ce qu'elle coûterait au serveur.
        let lagMs = 0;
        let tick = performance.now();
        const monitor = setInterval(() => {
          const now = performance.now();
          lagMs = Math.max(lagMs, now - tick - 10);
          tick = now;
        }, 10);
        const result = await scanMatroska(source);
        clearInterval(monitor);
        row.loopLagMs = Math.round(lagMs);
        source.close();
        row.bytes = source.bytesRead;
        row.blocks = blocks;
        row.zones = result.zones.length;
        row.durationS = result.durationSeconds;
        // Le plus long entre deux blocs : ce que l'analyse d'un bloc tient, au plus (boucle rendue toutes les 256 lectures).
        row.longestBlockMs = Math.round(longestGapMs);
      }
      const ms = performance.now() - t0;
      row.seconds = Math.round(ms / 100) / 10;
      row.mbps = Math.round(((row.bytes as number) / 1e6 / (ms / 1000)) * 10) / 10;
      appendFileSync(process.env.INTEGRITY_BENCH_OUT!, JSON.stringify(row) + "\n");
    }
  });
});
