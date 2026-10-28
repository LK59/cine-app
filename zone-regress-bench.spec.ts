// Banc de non-régression de la détection des zones illisibles (DECISIONS.md §93) — sauté sans
// ZONE_REGRESS_FILES.
//
// Pour chaque fichier sain (une ligne par chemin dans ZONE_REGRESS_FILES) : ouvre le
// remultiplexeur comme le lecteur, lit le film ENTIER, segment après segment, et écrit l'empreinte
// de tout ce qui en sort — segments d'initialisation, fragments vidéo, son, sous-titres, instants
// de fin —, puis six sauts (au dixième, au quart, à la moitié… du film) et quatre segments après
// chacun, avec leur empreinte. Lancé sur deux versions du code (HEAD et la copie de travail), les
// lignes doivent être identiques octet pour octet : la détection ne doit rien changer à un fichier
// sain, ni lever, ni déplacer un échantillon.
//
// Puis le flux brut des échantillons, toutes pistes, par deux lecteurs menés de front sur le même
// cache : l'un strict (`{ unreadable: "throw" }`, celui du remultiplexeur), l'autre sans option (celui
// des transcodeurs, de la reprise instantanée, des répliques) — piste, instant, durée, clé, octets de
// chaque échantillon. Les deux empreintes doivent être égales entre elles et à celle de l'ancien code.
//
// Il n'importe que ce qui existait avant la détection (`openMediaFile`, `createSampleReader`,
// `Remuxer`) : il tourne tel quel sur l'ancien code, qui ignore l'option. Le débit est plafonné (ZONE_REGRESS_MBPS, 40 Mo/s par défaut) : la
// bibliothèque est lue par des spectateurs pendant ce temps.
//
//   docker run --rm --name cine-zone-regress -v "$PWD":/app -v /mnt/media/video:/media:ro -w /app \
//     -e ZONE_REGRESS_FILES=/app/files.txt -e ZONE_REGRESS_OUT=/app/out.jsonl \
//     node:26-alpine npx vitest run zone-regress-bench.spec.ts
import { describe, it } from "vitest";
import { appendFileSync, closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createHash, type Hash } from "node:crypto";
import { createSampleReader, openMediaFile } from "@/lib/webcodecs/mediaFile";
import { Remuxer } from "@/lib/webcodecs/remuxer";
import type { ByteSource } from "@/lib/webcodecs/byteSource";
import type { MatroskaTrack } from "@/lib/webcodecs/matroska";

// Tout est accepté : chaque piste est copiée telle quelle, aucun encodeur n'est demandé.
const anySource = { isTypeSupported: () => true };
(globalThis as unknown as { window: unknown }).window = { ManagedMediaSource: anySource };
(globalThis as unknown as { MediaSource: unknown }).MediaSource = anySource;

const BLOCK = 8 << 20;
const bytesPerMs = Number(process.env.ZONE_REGRESS_MBPS ?? 40) * 1000;

/** Un fichier lu par blocs de 8 Mio gardés (deux), au débit plafonné — le même dans les deux passes. */
function fileSource(path: string, stats: { bytes: number }): ByteSource {
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  const blocks = new Map<number, Uint8Array>();
  let budgetAt = Date.now();
  const block = async (index: number): Promise<Uint8Array> => {
    const kept = blocks.get(index);
    if (kept) return kept;
    const start = index * BLOCK;
    const length = Math.min(BLOCK, size - start);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    stats.bytes += read;
    budgetAt = Math.max(budgetAt, Date.now()) + read / bytesPerMs;
    const wait = budgetAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, read);
    blocks.set(index, bytes);
    while (blocks.size > 2) blocks.delete(blocks.keys().next().value!);
    return bytes;
  };
  return {
    size,
    read: async (offset: number, requested: number) => {
      const length = Math.max(0, Math.min(requested, size - offset));
      const out = new Uint8Array(length);
      let done = 0;
      while (done < length) {
        const at = offset + done;
        const b = await block(Math.floor(at / BLOCK));
        const inBlock = at % BLOCK;
        const n = Math.min(length - done, b.length - inBlock);
        if (n <= 0) break;
        out.set(b.subarray(inBlock, inBlock + n), done);
        done += n;
      }
      return out.subarray(0, done);
    },
    close: () => closeSync(fd),
  };
}

const short = (h: Hash) => h.digest("hex").slice(0, 20);

function feed(hash: Hash, segment: Awaited<ReturnType<Remuxer["nextSegment"]>>): number {
  if (!segment) return 0;
  let bytes = 0;
  for (const fragment of segment.video) {
    hash.update(fragment);
    bytes += fragment.byteLength;
  }
  if (segment.audio) {
    hash.update(segment.audio);
    bytes += segment.audio.byteLength;
  }
  hash.update(JSON.stringify(segment.subtitles));
  hash.update(segment.endSeconds.toFixed(6));
  return bytes;
}

async function openRemuxer(source: ByteSource, file: Awaited<ReturnType<typeof openMediaFile>>, video: MatroskaTrack, start: number): Promise<{ remuxer: Remuxer; audio: MatroskaTrack | null; refused: string[] }> {
  const refused: string[] = [];
  for (const audio of [...file.tracks.filter((t) => t.type === "audio"), null]) {
    try {
      const remuxer = await Remuxer.open(source, file, video, audio, { width: video.video?.width ?? 1920, height: video.video?.height ?? 1080 }, null, start, { perTrack: true });
      return { remuxer, audio, refused };
    } catch (error) {
      refused.push(`${audio?.number ?? "aucune"}: ${String(error instanceof Error ? error.message : error).slice(0, 80)}`);
    }
  }
  throw new Error(`aucune piste : ${refused.join(" | ")}`);
}

describe.skipIf(!process.env.ZONE_REGRESS_FILES)("non-régression des zones illisibles", () => {
  it("produit les mêmes octets sur des fichiers sains", { timeout: 6 * 3_600_000 }, async () => {
    const files = readFileSync(process.env.ZONE_REGRESS_FILES!, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    for (const path of files) {
      const stats = { bytes: 0 };
      const source = fileSource(path, stats);
      const row: Record<string, unknown> = { file: path.split("/").pop() };
      const t0 = Date.now();
      try {
        const file = await openMediaFile(source);
        const video = file.tracks.find((t) => t.type === "video");
        if (!video) throw new Error("aucune vidéo");
        const { remuxer, audio, refused } = await openRemuxer(source, file, video, 0);
        row.video = video.codecId;
        row.audio = audio ? `${audio.number}:${audio.codecId}` : null;
        if (refused.length) row.refused = refused;
        const plan = remuxer.plan();
        const init = createHash("sha256");
        init.update(plan.videoInit);
        if (plan.audioInit) init.update(plan.audioInit);
        init.update(`${plan.videoMimeType}|${plan.audioMimeType}`);
        row.init = short(init);
        // Le film entier.
        const all = createHash("sha256");
        let segments = 0;
        let produced = 0;
        let end = 0;
        for (;;) {
          const segment = await remuxer.nextSegment();
          if (!segment) break;
          segments++;
          produced += feed(all, segment);
          end = segment.endSeconds;
        }
        row.segments = segments;
        row.producedMB = Math.round(produced / 1e5) / 10;
        row.endSeconds = Math.round(end * 1000) / 1000;
        row.all = short(all);
        // Le flux brut, toutes pistes, strict et sans option, menés de front.
        const start = file.firstClusterOffset ?? file.segmentDataStart;
        const strict = createSampleReader(source, file, start, { unreadable: "throw" } as never);
        const loose = createSampleReader(source, file, start);
        const rawStrict = createHash("sha256");
        const rawLoose = createHash("sha256");
        let samples = 0;
        for (;;) {
          const a = await strict.next();
          const b = await loose.next();
          for (const [hash, sample] of [[rawStrict, a], [rawLoose, b]] as const) {
            if (!sample) continue;
            hash.update(`${sample.trackNumber}|${sample.timestampUs}|${sample.durationUs}|${sample.isKey}|`);
            hash.update(sample.data);
          }
          if (!a && !b) break;
          samples++;
        }
        row.samples = samples;
        row.rawStrict = short(rawStrict);
        row.rawLoose = short(rawLoose);
        // Six sauts, quatre segments chacun : `seekTo`, le recul d'index, les RASL écartées.
        const duration = file.durationSeconds ?? end;
        const seeks = createHash("sha256");
        for (const share of [0.1, 0.25, 0.5, 0.62, 0.8, 0.97]) {
          remuxer.seekTo(Math.round(duration * share * 10) / 10);
          for (let i = 0; i < 4; i++) feed(seeks, await remuxer.nextSegment());
        }
        row.seeks = short(seeks);
        remuxer.close();
      } catch (error) {
        row.error = String(error instanceof Error ? `${error.name}: ${error.message}` : error).slice(0, 200);
      } finally {
        source.close();
      }
      row.readGB = Math.round(stats.bytes / 1e7) / 100;
      row.seconds = Math.round((Date.now() - t0) / 1000);
      appendFileSync(process.env.ZONE_REGRESS_OUT!, JSON.stringify(row) + "\n");
    }
  });
});
