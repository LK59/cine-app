// Banc de la signalisation HLS de Lumen serveur (étape 1) — sauté sans LUMEN_FILES.
//
// Deux usages, une ligne JSON par fichier et par piste :
//
// 1. **Identité du chemin MediaSource** : ouvre le remultiplexeur comme le lecteur (par piste, sans
//    option `signalling`) et écrit l'empreinte des segments d'initialisation vidéo — sans Dolby
//    Vision, puis avec l'enregistrement du fichier (la forme `dvh1` que MSE reçoit quand le
//    navigateur l'accepte) — et audio, piste par piste. Lancé sur le code d'avant et sur celui
//    d'après, les lignes doivent être identiques.
// 2. **Signalisation HLS** (LUMEN_HLS=1, code d'après seulement) : les mêmes ouvertures avec
//    `signalling: "hls"`, l'entrée d'échantillon et ses boîtes en hexadécimal, `CODECS`,
//    `SUPPLEMENTAL-CODECS`, `VIDEO-RANGE`, `CHANNELS`, et deux contre-épreuves lues dans le flux :
//    le `dec3` complet est-il le même sur les 200 premiers blocs, et la trame porte-t-elle un
//    conteneur EMDF avec une charge JOC (identifiant 14, ETSI TS 103 420) — indépendamment du
//    drapeau d'`addbsi` que le `dec3` recopie.
//
//   docker run --rm -v "$PWD":/app -v /mnt/media/video:/media:ro -w /app \
//     -e LUMEN_FILES=/app/liste.txt -e LUMEN_OUT=/app/sortie.jsonl [-e LUMEN_HLS=1] \
//     node:26-alpine npx vitest run lumen-signal-bench.spec.ts
//
// Lecture seule : les médias sont montés `:ro`, rien n'est écrit ailleurs que dans LUMEN_OUT.
import { describe, it } from "vitest";
import { openSync, readSync, statSync, closeSync, readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { openMediaFile, createSampleReader } from "@/lib/webcodecs/mediaFile";
import { Remuxer } from "@/lib/webcodecs/remuxer";
import type { ByteSource } from "@/lib/webcodecs/byteSource";
import type { MatroskaTrack } from "@/lib/webcodecs/matroska";

// Un moteur qui accepte tout : la décision de copie se prend comme dans Safari, qui lit l'(E-)AC-3.
Object.defineProperty(globalThis, "navigator", {
  value: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15" },
  configurable: true,
});
const anySource = { isTypeSupported: () => true };
(globalThis as unknown as { window: unknown }).window = { ManagedMediaSource: anySource };
(globalThis as unknown as { MediaSource: unknown }).MediaSource = anySource;

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

const sha = (b: Uint8Array | null | undefined) => (b ? createHash("sha256").update(b).digest("hex").slice(0, 16) : null);
const hex = (b: Uint8Array | null | undefined) => (b ? Buffer.from(b).toString("hex") : null);

/** Trouve une boîte par son type, n'importe où dans l'arbre (sans interpréter les autres). */
function findBox(bytes: Uint8Array, type: string): Uint8Array | null {
  const needle = Buffer.from(type, "latin1");
  const at = Buffer.from(bytes).indexOf(needle);
  if (at < 4) return null;
  const size = new DataView(bytes.buffer, bytes.byteOffset).getUint32(at - 4);
  return bytes.subarray(at - 4, at - 4 + size);
}

/** Le type de l'entrée d'échantillon : premier enfant de `stsd` (8 octets de boîte + 8 de champs). */
function sampleEntryType(init: Uint8Array): string | null {
  const stsd = findBox(init, "stsd");
  return stsd ? Buffer.from(stsd.subarray(20, 24)).toString("latin1") : null;
}

/** variable_bits(n) d'EMDF (ETSI TS 102 366, H.2.1.2.1). */
function variableBits(read: (n: number) => number, n: number): number {
  let value = 0;
  for (;;) {
    value += read(n);
    if (!read(1)) return value;
    value = (value << n) + (1 << n);
  }
}

/**
 * Les identifiants de charge des conteneurs EMDF d'une trame (ETSI TS 102 366 Annexe H). Les
 * conteneurs vivent dans `auxdata` ou les `skipfld`, à une position de bit quelconque : on cherche
 * le mot de synchronisation 0x5838 partout, on n'accepte qu'un conteneur dont la longueur tient
 * dans la trame et dont la liste de charges se termine par 0 — un faux positif aléatoire n'y
 * survit pas. Contre-épreuve seulement : le `dec3` lit `addbsi`, pas l'EMDF.
 */
function emdfPayloadIds(frame: Uint8Array): number[] {
  const ids = new Set<number>();
  const total = frame.length * 8;
  const bitAt = (p: number) => (frame[p >> 3] >> (7 - (p & 7))) & 1;
  for (let start = 0; start + 32 <= total; start++) {
    let p = start;
    const read = (n: number) => {
      let v = 0;
      for (let i = 0; i < n; i++, p++) v = (v << 1) | (p < total ? bitAt(p) : 0);
      return v;
    };
    if (read(16) !== 0x5838) continue;
    const length = read(16);
    if (length === 0 || p + length * 8 > total) continue;
    const end = p + length * 8;
    try {
      let version = read(2);
      if (version === 3) version += variableBits(read, 2);
      if (version !== 0) continue;
      let key = read(3);
      if (key === 7) key += variableBits(read, 3);
      const found: number[] = [];
      let ok = false;
      for (let guard = 0; guard < 32 && p < end; guard++) {
        let id = read(5);
        if (id === 0x1f) id += variableBits(read, 5);
        if (id === 0) {
          ok = true;
          break;
        }
        // emdf_payload_config (H.2.1.3)
        const smploffste = read(1);
        if (smploffste) read(12);
        if (read(1)) variableBits(read, 11);
        if (read(1)) variableBits(read, 2);
        if (read(1)) read(8);
        if (!read(1)) {
          let aligned = 0;
          if (!smploffste) {
            aligned = read(1);
            if (aligned) read(2);
          }
          if (smploffste || aligned) read(7);
        }
        const size = variableBits(read, 8);
        p += size * 8;
        found.push(id);
      }
      if (ok && p <= end) for (const id of found) ids.add(id);
    } catch {
      // un faux départ : on continue la recherche
    }
  }
  return [...ids].sort((a, b) => a - b);
}

async function firstBlocks(source: ByteSource, file: Awaited<ReturnType<typeof openMediaFile>>, track: MatroskaTrack, count: number): Promise<Uint8Array[]> {
  const reader = createSampleReader(source, file, file.firstClusterOffset ?? file.segmentDataStart);
  const out: Uint8Array[] = [];
  for (let i = 0; i < 20000 && out.length < count; i++) {
    const sample = await reader.next();
    if (!sample) break;
    if (sample.trackNumber === track.number) out.push(sample.data.slice());
  }
  return out;
}

describe.skipIf(!process.env.LUMEN_FILES)("signalisation Lumen serveur", () => {
  it("chemin MSE inchangé, et signalisation HLS", { timeout: 3_600_000 }, async () => {
    const hls = process.env.LUMEN_HLS === "1";
    // Import dynamique : le banc tourne aussi sur le code d'avant, où ce module n'existe pas.
    const signal = hls ? await import("@/lib/lumenServer/hlsSignal") : null;
    const entries = hls ? await import("@/lib/webcodecs/mp4SampleEntries") : null;
    const files = readFileSync(process.env.LUMEN_FILES!, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
    const write = (row: Record<string, unknown>) => appendFileSync(process.env.LUMEN_OUT!, JSON.stringify(row) + "\n");

    for (const path of files) {
      const source = fileSource(path);
      try {
        const file = await openMediaFile(source);
        const video = file.tracks.find((t) => t.type === "video");
        if (!video) continue;
        const name = path.split("/").pop();
        const dims = { width: video.video?.width ?? 1920, height: video.video?.height ?? 1080 };
        const audios = file.tracks.filter((t) => t.type === "audio");

        // Vidéo, chemin MSE : sans DV, puis avec l'enregistrement (forme `dvh1`).
        const vrow: Record<string, unknown> = { file: name, kind: "video", codec: video.codecId, dv: video.dolbyVision ? hex(video.dolbyVision.record.subarray(0, 5)) : null };
        try {
          const plain = await Remuxer.open(source, file, video, null, dims, null, 0, { perTrack: true });
          vrow.mseInit = sha(plain.plan().videoInit);
          vrow.mseMime = plain.plan().videoMimeType;
          if (video.dolbyVision) {
            const dv = await Remuxer.open(source, file, video, null, dims, video.dolbyVision, 0, { perTrack: true });
            vrow.mseDvInit = sha(dv.plan().videoInit);
            vrow.mseDvMime = dv.plan().videoMimeType;
            vrow.mseDvEntry = sampleEntryType(dv.plan().videoInit);
          }
          if (hls && signal) {
            const h = await Remuxer.open(source, file, video, null, dims, video.dolbyVision ?? null, 0, { perTrack: true, signalling: "hls" });
            const init = h.plan().videoInit;
            vrow.hlsEntry = sampleEntryType(init);
            vrow.hlsMime = h.plan().videoMimeType;
            vrow.hlsHvcC = sha(findBox(init, "hvcC") ?? findBox(init, "avcC"));
            vrow.hlsDvBox = hex(findBox(init, "dvcC") ?? findBox(init, "dvvC"));
            const s = signal.hlsVideoSignal(video);
            vrow.signal = s;
            vrow.mkvTransfer = video.video?.colour?.transferCharacteristics ?? null;
            vrow.spsTransfer =
              video.codecId === "V_MPEGH/ISO/HEVC" && video.codecPrivate
                ? signal.hevcTransferCharacteristics(video.codecPrivate)
                : video.codecId === "V_MPEG4/ISO/AVC" && video.codecPrivate
                  ? signal.avcTransferCharacteristics(video.codecPrivate)
                  : null;
          }
        } catch (e) {
          vrow.error = String(e instanceof Error ? e.message : e).slice(0, 200);
        }
        write(vrow);

        for (const audio of audios) {
          const row: Record<string, unknown> = { file: name, kind: "audio", track: audio.number, codec: audio.codecId, channels: audio.audio?.channels, lang: audio.language };
          try {
            const remuxer = await Remuxer.open(source, file, video, audio, dims, null, 0, { perTrack: true });
            const plan = remuxer.plan();
            row.mseInit = sha(plan.audioInit);
            row.mseMime = plan.audioMimeType;
            row.transcoded = remuxer.diagnostics().transcodedAudio;
            if (audio.codecId === "A_EAC3") row.mseDec3 = hex(findBox(plan.audioInit!, "dec3"));
            if (hls && signal && entries && !remuxer.diagnostics().transcodedAudio) {
              const h = await Remuxer.open(source, file, video, audio, dims, null, 0, { perTrack: true, signalling: "hls" });
              const init = h.plan().audioInit!;
              row.hlsInit = sha(init);
              if (audio.codecId === "A_EAC3") row.hlsDec3 = hex(findBox(init, "dec3"));
              if (audio.codecId === "A_AC3") row.hlsDac3 = hex(findBox(init, "dac3"));
              const blocks = await firstBlocks(source, file, audio, 200);
              row.signal = blocks[0] ? signal.hlsAudioSignal(audio, blocks[0]) : null;
              if (audio.codecId === "A_EAC3" && blocks.length) {
                // Le `dec3` dit-il la même chose sur 200 blocs ? (débit variable mis à part)
                const shapes = new Set(blocks.map((b) => {
                  const d = entries.describeEac3(b);
                  return JSON.stringify({ s: d.substreams, joc: d.joc, ch: d.channels });
                }));
                row.stableShape = shapes.size === 1;
                row.maxRate = Math.max(...blocks.map((b) => entries.describeEac3(b).dataRate));
                const emdf = new Set<number>();
                for (const b of blocks.slice(0, 20)) for (const id of emdfPayloadIds(b)) emdf.add(id);
                row.emdfIds = [...emdf].sort((a, b) => a - b);
              }
            }
          } catch (e) {
            row.error = String(e instanceof Error ? e.message : e).slice(0, 200);
          }
          write(row);
        }
      } finally {
        source.close();
      }
    }
  });
});
