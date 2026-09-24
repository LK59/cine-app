// Balayage de la bibliothèque : le remultiplexeur sur chaque fichier, à trois positions.
//
// La moitié « production » d'une chaîne en deux temps. Ceci ouvre chaque fichier avec le vrai code
// du lecteur (mediaFile, remuxer), en tire quelques secondes à 15 %, 50 % et 85 %, et dépose les
// segments produits là où un décodeur les attend (`tools/sweep/decode.sh`) : le GPU du serveur,
// par le conteneur Jellyfin, puis le processeur en cas d'erreur. Né le 24/09/2026 : les défauts les
// plus graves de la semaine — un en-tête HEVC vide sur 453 fichiers, des images clés H.264 que le
// lecteur ne reconnaissait pas — étaient dans les fichiers, et aucun test ne les aurait trouvés.
//
// Sauté sans liste de cibles. Voir `tools/sweep/run.sh` pour la commande complète.
//   SWEEP_LIST=/logs/cibles.tsv SWEEP_OUT=/shm SWEEP_LOG=/logs/remux.jsonl npx vitest run sweep.spec.ts

import { openSync, readSync, closeSync, statSync, writeFileSync, readFileSync, readdirSync, existsSync, appendFileSync } from "node:fs";
import { describe, it } from "vitest";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { Remuxer } from "@/lib/webcodecs/remuxer";
import type { ByteSource } from "@/lib/webcodecs/byteSource";
import { hevcRecordHasParameterSets } from "@/lib/webcodecs/codecConfig";

// Le remultiplexeur demande au navigateur ce qu'il accepte. Ici, tout : chaque piste passe telle
// quelle et aucun encodeur n'est nécessaire — c'est ce qu'on veut éprouver (voir bench.spec.ts).
const anySource = { isTypeSupported: () => true };
(globalThis as unknown as { window: unknown }).window = { ManagedMediaSource: anySource };
(globalThis as unknown as { MediaSource: unknown }).MediaSource = anySource;

/** Le même lecteur de fichier que bench.spec.ts — voir ses commentaires pour chaque détail. */
function fileSource(path: string): ByteSource {
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  return {
    size,
    read: async (start: number, requested: number) => {
      const length = Math.max(0, Math.min(requested, size - start));
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, start + read);
        if (n <= 0) break;
        read += n;
      }
      return new Uint8Array(buffer.subarray(0, read));
    },
    close: () => closeSync(fd),
  };
}

const LIST = process.env.SWEEP_LIST ?? "";
const OUT = process.env.SWEEP_OUT ?? "/shm";
const LOG = process.env.SWEEP_LOG ?? "/logs/remux.jsonl";
/** Positions éprouvées, en fraction de la durée. */
const POSITIONS = [0.15, 0.5, 0.85];
/** Ce qu'on lit à chaque position : quelques groupes d'images, de quoi passer une jonction. */
const SECONDS_PER_POSITION = 10;
const MAX_SEGMENTS = 12;
/** Au-delà, le producteur attend que le décodeur rattrape : la mémoire partagée n'est pas infinie. */
const MAX_PENDING = 16;

function log(entry: Record<string, unknown>): void {
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

function join(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** Ce qui a déjà été traité : une reprise après un arrêt ne recommence pas tout. */
function alreadyDone(): Set<string> {
  if (!existsSync(LOG)) return new Set();
  const done = new Set<string>();
  for (const line of readFileSync(LOG, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as { kind?: string; id?: string };
      if (entry.kind === "file-done" && entry.id) done.add(entry.id);
    } catch {
      // Une ligne coupée par un arrêt brutal : ignorée.
    }
  }
  return done;
}

async function waitForRoom(): Promise<void> {
  for (;;) {
    const pending = readdirSync(OUT).filter((f) => f.endsWith(".ready")).length;
    if (pending < MAX_PENDING) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

describe.skipIf(!LIST)("balayage", () => {
  it("remultiplexe chaque fichier à trois positions", { timeout: 48 * 3600_000 }, async () => {
    const targets = readFileSync(LIST, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [kind, id, title, path] = line.split("\t");
        return { kind, id: `${kind}-${id}`, title, path };
      });
    const done = alreadyDone();
    log({ kind: "start", targets: targets.length, alreadyDone: done.size });

    let index = 0;
    for (const target of targets) {
      index += 1;
      if (done.has(target.id)) continue;
      const began = Date.now();
      let source: ByteSource | null = null;
      try {
        source = fileSource(target.path);
        const file = await openMediaFile(source, target.path);
        const video = file.tracks.find((t) => t.type === "video");
        if (!video) throw new Error("aucune piste vidéo");
        // Une piste que le remultiplexeur porte telle quelle : DTS et TrueHD passent par un
        // encodeur, qui n'existe pas ici. Faute d'en trouver une, l'image seule est éprouvée.
        const audio =
          file.tracks.filter((t) => t.type === "audio").find((t) => t.codecId !== "A_DTS" && t.codecId !== "A_TRUEHD") ?? null;
        const hevcHeaderComplete =
          video.codecId === "V_MPEGH/ISO/HEVC" && video.codecPrivate ? hevcRecordHasParameterSets(video.codecPrivate) : null;
        const duration = file.durationSeconds ?? 0;
        if (!(duration > 0)) throw new Error("durée inconnue");

        const remuxer = await Remuxer.open(
          source,
          file,
          video,
          audio,
          { width: video.video?.width ?? 1920, height: video.video?.height ?? 1080 },
          null,
          0,
          { perTrack: true }
        );
        const plan = remuxer.plan();

        for (let p = 0; p < POSITIONS.length; p++) {
          const target_s = Math.floor(duration * POSITIONS[p]);
          const item = `${String(index).padStart(4, "0")}-${p}`;
          const positionBegan = Date.now();
          try {
            remuxer.seekTo(target_s);
            const videoParts: Uint8Array[] = [plan.videoInit];
            const audioParts: Uint8Array[] = plan.audioInit ? [plan.audioInit] : [];
            let segments = 0;
            let firstStart: number | null = null;
            for (; segments < MAX_SEGMENTS; segments++) {
              const segment = await remuxer.nextSegment();
              if (!segment) break;
              videoParts.push(...segment.video);
              if (segment.audio) audioParts.push(segment.audio);
              firstStart ??= remuxer.diagnostics().segmentStartSeconds;
              if (segment.endSeconds > target_s + SECONDS_PER_POSITION) break;
            }
            await waitForRoom();
            writeFileSync(`${OUT}/${item}.video.mp4`, join(videoParts));
            if (audioParts.length > 1) writeFileSync(`${OUT}/${item}.audio.mp4`, join(audioParts));
            const meta = {
              item,
              id: target.id,
              title: target.title,
              path: target.path,
              position: target_s,
              videoCodec: video.codecId,
              audioCodec: audio?.codecId ?? null,
              mime: plan.videoMimeType,
              segments,
              // Où la lecture a réellement commencé : très loin avant la cible, c'est un index
              // qui ment ; après, une image clé manquée.
              landing: firstStart,
              clampedSamples: remuxer.diagnostics().clampedSamples,
              ms: Date.now() - positionBegan,
            };
            writeFileSync(`${OUT}/${item}.json`, JSON.stringify(meta));
            writeFileSync(`${OUT}/${item}.ready`, "");
            log({ kind: "position", ...meta });
          } catch (error) {
            log({
              kind: "position-error",
              item,
              id: target.id,
              title: target.title,
              path: target.path,
              position: target_s,
              error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            });
          }
        }
        remuxer.close();
        log({
          kind: "file-done",
          id: target.id,
          index,
          total: targets.length,
          title: target.title,
          videoCodec: video.codecId,
          audioCodec: audio?.codecId ?? null,
          hevcHeaderComplete,
          ms: Date.now() - began,
        });
      } catch (error) {
        log({
          kind: "file-error",
          id: target.id,
          index,
          title: target.title,
          path: target.path,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        // Compté comme fait : un fichier qui ne s'ouvre pas ne s'ouvrira pas mieux à la reprise.
        log({ kind: "file-done", id: target.id, index, total: targets.length, title: target.title, failed: true });
      } finally {
        try {
          source?.close();
        } catch {
          /* déjà fermé */
        }
      }
    }
    log({ kind: "end" });
  });
});
