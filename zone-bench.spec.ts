// Banc de la zone illisible (DECISIONS.md §93) — sauté sans ZONE_BENCH_DIR.
//
// Prend `extrait.mkv` dans ZONE_BENCH_DIR (un extrait d'un vrai film, copié là par mkvmerge — jamais
// un fichier de la bibliothèque, jamais écrit sous /mnt/media), en fabrique quatre copies abîmées
// comme « Le Grinch » l'était, à côté de lui, puis lit chacune comme le lecteur natif : le
// remultiplexeur, segment après segment, jusqu'à la fin ou à l'erreur. Écrit, par copie, jusqu'où
// il est allé et comment il s'est arrêté — et, sur le code qui la porte, ce que la vérification de
// l'intégrité y trouve.
//
//   A  une zone continue à cheval sur deux en-têtes de grappe (8 Kio avant la première, 8 Kio après la seconde) ;
//   B  un bloc de 16 Kio au milieu d'une grappe ;
//   C  un bloc de 16 Kio sur deux, sur 4 Mio, à partir du milieu d'une grappe ;
//   D  un en-tête de grappe seul (16 Kio).
//
// Il n'importe statiquement que ce qui existait avant la détection : lancé sur l'ancien code (HEAD
// avant §93), il montre l'ancien comportement — « fin du fichier » au milieu du film, ou un trou.
//
//   docker run --rm --name cine-zone-bench -v "$PWD":/app -v <dossier>:/zone -w /app \
//     -e ZONE_BENCH_DIR=/zone node:26-alpine npx vitest run zone-bench.spec.ts
import { describe, it } from "vitest";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { Remuxer } from "@/lib/webcodecs/remuxer";
import { MemoryByteSource } from "@/lib/webcodecs/byteSource";

const anySource = { isTypeSupported: () => true };
(globalThis as unknown as { window: unknown }).window = { ManagedMediaSource: anySource };
(globalThis as unknown as { MediaSource: unknown }).MediaSource = anySource;

const ZONE = 16 * 1024;

async function readThrough(bytes: Uint8Array): Promise<Record<string, unknown>> {
  const source = new MemoryByteSource(bytes);
  const file = await openMediaFile(source);
  const video = file.tracks.find((t) => t.type === "video")!;
  const audio = file.tracks.find((t) => t.type === "audio") ?? null;
  const remuxer = await Remuxer.open(source, file, video, audio, { width: 1920, height: 1080 }, null, 0, { perTrack: true });
  let segments = 0;
  let end = 0;
  let previous = 0;
  let biggestGap = 0;
  try {
    for (;;) {
      const segment = await remuxer.nextSegment();
      if (!segment) return { segments, endSeconds: round(end), biggestGapS: round(biggestGap), stop: "fin du fichier (nextSegment null)", durationS: round(file.durationSeconds ?? 0) };
      segments++;
      biggestGap = Math.max(biggestGap, segment.endSeconds - previous);
      previous = segment.endSeconds;
      end = segment.endSeconds;
    }
  } catch (error) {
    return { segments, endSeconds: round(end), biggestGapS: round(biggestGap), stop: `${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`, durationS: round(file.durationSeconds ?? 0) };
  } finally {
    remuxer.close();
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

describe.skipIf(!process.env.ZONE_BENCH_DIR)("zone illisible — copies abîmées", () => {
  it("lit chaque copie comme le lecteur natif", { timeout: 600_000 }, async () => {
    const dir = process.env.ZONE_BENCH_DIR!;
    const out = `${dir}/zone-bench.jsonl`;
    const original = new Uint8Array(readFileSync(`${dir}/extrait.mkv`));
    const file = await openMediaFile(new MemoryByteSource(original));
    // Les grappes indexées de l'image, dans l'ordre du fichier.
    const video = file.tracks.find((t) => t.type === "video")!.number;
    const clusters = [...new Set(file.cues.filter((c) => c.track === video).map((c) => c.clusterOffset))].sort((a, b) => a - b);
    const at = Math.floor(clusters.length * 0.4);
    const middle = (k: number) => Math.floor((clusters[k] + clusters[k + 1]) / 2);
    const copies: Record<string, [number, number][]> = {
      A: [[clusters[at] - 8192, clusters[at + 1] + 8192 - (clusters[at] - 8192)]],
      B: [[middle(at), ZONE]],
      C: Array.from({ length: 128 }, (_, i) => [middle(at) + i * 2 * ZONE, ZONE] as [number, number]),
      D: [[clusters[at], ZONE]],
    };
    appendFileSync(out, JSON.stringify({ copy: "sain", clusterAt: clusters[at], clusterTimeS: round((file.cues.find((c) => c.clusterOffset === clusters[at])?.timeUs ?? 0) / 1e6), ...(await readThrough(original)) }) + "\n");
    for (const [name, zones] of Object.entries(copies)) {
      const bytes = original.slice();
      for (const [from, length] of zones) bytes.fill(0, from, from + length);
      const path = `${dir}/copie-${name}.mkv`;
      writeFileSync(path, bytes);
      const row: Record<string, unknown> = { copy: name, zeros: zones.length === 1 ? `${zones[0][0]}+${zones[0][1]}` : `${zones.length} × ${ZONE} dès ${zones[0][0]}`, ...(await readThrough(bytes)) };
      // La vérification de l'intégrité, sur le code qui la porte (absente de l'ancien : rien).
      try {
        const scan = (await import("@/lib/integrity/scan")) as typeof import("@/lib/integrity/scan");
        const result = await scan.scanMatroska(new MemoryByteSource(bytes));
        row.integrity = result.zones.map((z) => `${z.seconds}s@${z.byte}`).join(" ");
      } catch {
        row.integrity = "—";
      }
      appendFileSync(out, JSON.stringify(row) + "\n");
    }
  });
});
