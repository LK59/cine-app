// Empreintes du son décodé par les deux modules FFmpeg en WebAssembly (TrueHD et AAC) — sauté sans
// FFW_LIST. Le garde-fou d'une montée de version de FFmpeg (DECISIONS.md §62, « Pinned FFmpeg »).
//
// Pour chaque piste listée, passe par la chaîne que le lecteur emprunte (SoftwareAudioTrack →
// lecteur Matroska → décodeur WebAssembly → rangement des canaux, l'AAC forcé sur le décodeur
// WebAssembly comme « Améliorer les dialogues » le fait), et écrit, par position, le SHA-256 des
// flottants livrés, le nombre de canaux et le niveau de chaque canal :
//   - « 0 » : décodeur neuf, depuis le début ;
//   - « a », puis « b » : deux sauts sur le même décodeur (40 % et 75 % de la durée) ;
//   - « a-neuf » : un décodeur neuf ouvert directement à 40 % — une reprise.
// Chaque fenêtre dure FFW_SPAN secondes (60 par défaut). Une liste : une ligne par fichier,
// `chemin` ou `chemin<TAB>numéro de piste Matroska` (sinon toutes ses pistes TrueHD/MLP/AAC).
//
// Se lance deux fois, une par module, sur la même liste, et les deux sorties se comparent ligne à
// ligne (`jq -c '{k:[.fichier,.piste,.position],h:.sha256}'`). Toute empreinte qui change se
// vérifie ensuite canal par canal contre ffmpeg, sur les mêmes secondes :
//
//   docker run --rm -v "$PWD":/app -v /mnt/media/video:/media:ro -w /app \
//     -e FFW_LIST=/app/liste.tsv -e FFW_OUT=/app/avant.jsonl \
//     node:24-alpine npx vitest run ffmpeg-wasm-regress-bench.spec.ts
//   ffmpeg -ss <début> -t 60 -i "…mkv" -map 0:<piste> \
//     -af astats=measure_overall=none:measure_perchannel=RMS_level -f null -
//
// Mesuré le 14/10/2026 pour la montée de FFmpeg 7.1.2 à 7.1.5 : voir DOC-TECH.md « Audio delivery ».
import { it } from "vitest";
import { appendFileSync, closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseMatroska } from "@/lib/webcodecs/matroska";
import { SoftwareAudioTrack } from "@/lib/webcodecs/softwareAudio";
import type { ByteSource } from "@/lib/webcodecs/byteSource";

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

const CODECS = new Set(["A_TRUEHD", "A_MLP", "A_AAC"]);

async function window(audio: SoftwareAudioTrack, from: number, span: number) {
  const hash = createHash("sha256");
  const sums: number[] = [];
  let frames = 0;
  let first: number | null = null;
  let expected: number | null = null;
  let gaps = 0;
  let channels = 0;
  for await (const chunk of audio.samples(from)) {
    channels = chunk.planes.length;
    const kept: number[] = [];
    for (let i = 0; i < chunk.planes[0].length; i++) {
      const t = chunk.timestampSeconds + i / chunk.sampleRate;
      if (t >= from && t < from + span) kept.push(i);
    }
    if (kept.length > 0) {
      first ??= chunk.timestampSeconds + kept[0] / chunk.sampleRate;
      if (expected !== null && Math.abs(chunk.timestampSeconds - expected) > 0.002) gaps++;
      // Entrelacé, [image][canal] : un canal déplacé change l'empreinte.
      const out = new Float32Array(kept.length * channels);
      kept.forEach((i, k) => {
        chunk.planes.forEach((plane, c) => {
          out[k * channels + c] = plane[i];
          sums[c] = (sums[c] ?? 0) + plane[i] * plane[i];
        });
      });
      hash.update(new Uint8Array(out.buffer));
      frames += kept.length;
    }
    expected = chunk.timestampSeconds + chunk.planes[0].length / chunk.sampleRate;
    if (chunk.timestampSeconds >= from + span) break;
  }
  return {
    sha256: frames > 0 ? hash.digest("hex") : null,
    canaux: channels,
    images: frames,
    premierInstant: first === null ? null : +first.toFixed(4),
    trous: gaps,
    rmsDb: sums.map((sum) => +(10 * Math.log10(sum / Math.max(1, frames))).toFixed(2)),
  };
}

it.skipIf(!process.env.FFW_LIST)("empreintes du son des modules FFmpeg en WebAssembly", { timeout: 6 * 3_600_000 }, async () => {
  const span = Number(process.env.FFW_SPAN ?? 60);
  const lines = readFileSync(process.env.FFW_LIST!, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const [path, only] = line.split("\t");
    const source = fileSource(path);
    try {
      const file = await parseMatroska(source);
      const duration = file.durationSeconds ?? 0;
      const tracks = file.tracks.filter(
        (t) => t.type === "audio" && CODECS.has(t.codecId) && (only === undefined || t.number === Number(only))
      );
      const a = Math.floor(duration * 0.4);
      const b = Math.floor(duration * 0.75);
      for (const track of tracks) {
        const base = {
          fichier: path,
          piste: track.number,
          codec: track.codecId,
          langue: track.language,
          canauxEnTete: track.audio?.channels ?? null,
        };
        const write = (row: object) => appendFileSync(process.env.FFW_OUT!, JSON.stringify({ ...base, ...row }) + "\n");
        const open = () => SoftwareAudioTrack.open(source, track.number, track.codecId, file, { measuredAacDecoder: true });
        let audio: SoftwareAudioTrack | null = null;
        try {
          audio = await open();
          for (const [position, from] of [["0", 0], ["a", a], ["b", b]] as const) {
            try {
              write({ position, debut: from, format: audio.format, ...(await window(audio, from, span)) });
            } catch (e) {
              write({ position, debut: from, erreur: String(e instanceof Error ? e.message : e).slice(0, 200) });
            }
          }
        } catch (e) {
          write({ position: "ouverture", erreur: String(e instanceof Error ? e.message : e).slice(0, 200) });
        } finally {
          audio?.close();
        }
        // Une reprise : un décodeur neuf, ouvert au milieu du film.
        let fresh: SoftwareAudioTrack | null = null;
        try {
          fresh = await open();
          write({ position: "a-neuf", debut: a, format: fresh.format, ...(await window(fresh, a, span)) });
        } catch (e) {
          write({ position: "a-neuf", debut: a, erreur: String(e instanceof Error ? e.message : e).slice(0, 200) });
        } finally {
          fresh?.close();
        }
      }
    } catch (e) {
      appendFileSync(process.env.FFW_OUT!, JSON.stringify({ fichier: path, erreur: String(e instanceof Error ? e.message : e).slice(0, 200) }) + "\n");
    } finally {
      source.close();
    }
  }
});
