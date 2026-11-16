// Banc du son copié réparé de Lumen serveur (DECISIONS.md §159) — sauté sans LUMEN_SON_FILES.
//
// Sur de vrais fichiers, en lecture seule, avec ffmpeg (image `lumen-banc:etape2`) : pour chaque piste, des
// fenêtres de segments son construits **chacun seul** par le code de la route (`buildSegment`), recollés
// derrière leur init, puis jugés :
// - **décodage sans erreur** : ffmpeg `-err_detect crccheck+bitstream+explode` sur l'init + segments ;
// - **le son réel, au bit près** : les trames réelles de la fenêtre (octets copiés du fichier), écrites en
//   flux élémentaire (AC-3/E-AC-3 brut, AAC en ADTS **avec la configuration implicite d'origine**) et décodées
//   par le même ffmpeg depuis un décodeur neuf, contre le décodage de l'init + segments à partir de la
//   première trame réelle : écart maximal par échantillon. Pour le SBR, c'est la preuve que la configuration
//   réécrite rend exactement ce que le décodeur rendait en découvrant le SBR ; pour le silence devant, que le
//   silence laisse le décodeur dans l'état d'un décodeur neuf ;
// - **le silence** : zéros exacts (à la trame de recouvrement près, derrière) ; à la jointure, l'énergie de la
//   dérivée seconde sur ±2 ms rapportée à celle des 100 ms de son qui précèdent (« rapport de clic », la
//   mesure de 5-conversion-son.md) ;
// - **niveaux par canal** : `astats` (RMS) du son réel décodé des segments et de la référence ;
// - **durée** : fin du son (dernier segment son : tfdt + durées − D) contre fin de l'image (dernier segment
//   vidéo), en ms.
//
//   docker run --rm --name lumen-son-banc --cpus 2 -m 3g -v "$PWD":/app -v /mnt/media/video:/media:ro \
//     -v <sorties>:/out -w /app -e LUMEN_SON_FILES=/out/liste.tsv -e LUMEN_OUT=/out/resultats \
//     lumen-banc:etape2 npx vitest run lumen-son-bench.spec.ts
//
// LUMEN_SON_FILES : `chemin<TAB>étiquette[<TAB>piste]` par ligne (sans piste : la piste par défaut). Une ligne
// JSON par fichier dans LUMEN_OUT/resultats.jsonl ; les fichiers intermédiaires sont effacés (LUMEN_KEEP=1).
import { describe, it } from "vitest";
import { appendFileSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { FileByteSource } from "@/lib/lumenServer/fileSource";
import { buildLumenIndex } from "@/lib/lumenServer/lumenIndex";
import { buildSegment, segmentSpec } from "@/lib/lumenServer/segment";
import { defaultAudioTrack, lumenEligibility } from "@/lib/lumenServer/eligibility";
import { readAsc, readRawDataBlock } from "@/lib/lumenServer/audio/aacStream";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import type { LumenAudioTrack, LumenIndex, LumenRendition } from "@/lib/lumenServer/format";
import { endDecode, parseFragments } from "./src/__tests__/lumenServer-helpers";

const FILES = process.env.LUMEN_SON_FILES;
const OUT = process.env.LUMEN_OUT ?? "/out/resultats";
const KEEP = process.env.LUMEN_KEEP === "1";
const WINDOW_US = Number(process.env.LUMEN_SON_WINDOW_S ?? 40) * 1e6;

function sh(cmd: string, args: string[]): { code: number; out: string; err: string; bytes: Buffer } {
  const r = spawnSync(cmd, args, { maxBuffer: 1024 * 1024 * 1024 });
  return { code: r.status ?? -1, out: r.stdout?.toString("utf8") ?? "", err: r.stderr?.toString("utf8") ?? "", bytes: r.stdout ?? Buffer.alloc(0) };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** Les segments qui couvrent [from, from + span). */
function windowOf(index: LumenIndex, fromUs: number, spanUs: number): number[] {
  const out: number[] = [];
  index.segments.forEach((s, n) => {
    if (s.endUs > fromUs && s.startUs < fromUs + spanUs) out.push(n);
  });
  return out;
}

async function build(index: LumenIndex, rendition: LumenRendition, n: number): Promise<Uint8Array> {
  const spec = segmentSpec(index, rendition, n);
  const source = await FileByteSource.open(spec.path);
  try {
    return (await buildSegment(source, await openMediaFile(source), spec)).bytes;
  } finally {
    source.close();
  }
}

/** Un en-tête ADTS (7 octets, sans CRC) pour une trame AAC-LC de `size` octets. */
function adts(size: number, frequencyIndex: number, channelConfiguration: number): Uint8Array {
  const length = size + 7;
  return Uint8Array.of(
    0xff,
    0xf1,
    (1 << 6) | (frequencyIndex << 2) | (channelConfiguration >> 2),
    ((channelConfiguration & 3) << 6) | (length >> 11),
    (length >> 3) & 0xff,
    ((length & 7) << 5) | 0x1f,
    0xfc
  );
}

/** Décodé en f32le entrelacé, par ffmpeg : les échantillons, les canaux, la fréquence, les erreurs. */
function decode(path: string, format?: string): { pcm: Float32Array; channels: number; rate: number; errors: string } {
  const probe = sh("ffprobe", ["-v", "error", ...(format ? ["-f", format] : []), "-select_streams", "a:0", "-show_entries", "stream=channels,sample_rate,profile", "-of", "json", path]);
  const stream = (JSON.parse(probe.out || "{}").streams ?? [])[0] ?? {};
  const r = sh("ffmpeg", ["-v", "error", "-err_detect", "crccheck+bitstream+explode", ...(format ? ["-f", format] : []), "-i", path, "-map", "0:a:0", "-f", "f32le", "-acodec", "pcm_f32le", "pipe:1"]);
  const pcm = new Float32Array(r.bytes.buffer.slice(r.bytes.byteOffset, r.bytes.byteOffset + r.bytes.byteLength));
  return { pcm, channels: Number(stream.channels ?? 0), rate: Number(stream.sample_rate ?? 0), errors: (r.err.trim() + (r.code ? ` [code ${r.code}]` : "")).slice(0, 400) };
}

/** RMS (dB) par canal d'un passage entrelacé, par `astats`. */
function astats(pcm: Float32Array, channels: number, rate: number, dir: string, name: string): number[] {
  const path = join(dir, `${name}.f32`);
  writeFileSync(path, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  const r = sh("ffmpeg", ["-v", "info", "-f", "f32le", "-ar", String(rate), "-ac", String(channels), "-i", path, "-af", "astats=measure_overall=none:measure_perchannel=RMS_level", "-f", "null", "-"]);
  rmSync(path, { force: true });
  return [...r.err.matchAll(/RMS level dB: (-?[\d.]+|-inf)/g)].map((m) => (m[1] === "-inf" ? -Infinity : Number(m[1])));
}

/** Énergie de la dérivée seconde (somme sur les canaux) sur [from, to) en trames d'échantillons. */
function curvature(pcm: Float32Array, channels: number, from: number, to: number): number {
  let e = 0;
  for (let i = Math.max(1, from); i < Math.min(to, pcm.length / channels - 1); i++) {
    for (let c = 0; c < channels; c++) {
      const d = pcm[(i + 1) * channels + c] - 2 * pcm[i * channels + c] + pcm[(i - 1) * channels + c];
      e += d * d;
    }
  }
  return e / Math.max(1, to - from);
}

interface WindowResult {
  name: string;
  segments: number[];
  silentFrames: number;
  realFrames: number;
  errors: string;
  rate: number;
  channels: number;
  profile?: string;
  /** Écart maximal, échantillon par échantillon, entre le son réel décodé des segments et la référence. */
  maxDiff: number | null;
  compared: number;
  /** Silence : plus grand |échantillon| hors de la trame de recouvrement. */
  silenceMax: number | null;
  /** Énergie de la dérivée seconde sur ±2 ms à la jointure, rapportée aux 100 ms de son d'avant (derrière) ou d'après (devant). */
  clickRatio: number | null;
  rmsSegments: number[];
  rmsReference: number[];
  /** AAC : chaque trame réelle de la fenêtre parcourue par `readRawDataBlock` — lues jusqu'au bout, avec SBR. */
  aacParse?: { frames: number; exact: number; sbr: number; errors: number };
}

async function judgeWindow(index: LumenIndex, track: LumenAudioTrack, window: number[], name: string, dir: string): Promise<WindowResult> {
  const rendition: LumenRendition = { kind: "audio", track: track.number };
  const parts = [index.inits.audio[track.number]];
  const frames: Uint8Array[] = [];
  for (const n of window) {
    const bytes = await build(index, rendition, n);
    parts.push(bytes);
    for (const f of parseFragments(bytes)) frames.push(...f.data);
  }
  const mp4 = join(dir, `${name}.mp4`);
  writeFileSync(mp4, Buffer.concat(parts.map((p) => Buffer.from(p))));
  const silent = track.silence ? hex(track.silence.frame) : null;
  const isSilent = frames.map((f) => silent !== null && hex(f) === silent);
  const real = frames.filter((_, i) => !isSilent[i]);
  let leadSilent = 0;
  while (leadSilent < isSilent.length && isSilent[leadSilent]) leadSilent++;
  let tailSilent = 0;
  while (tailSilent < isSilent.length - leadSilent && isSilent[isSilent.length - 1 - tailSilent]) tailSilent++;

  // La référence : les trames réelles, en flux élémentaire, avec la configuration d'origine.
  let refPath: string | null = null;
  let refFormat: string | undefined;
  if (real.length > 0) {
    if (track.codecId === "A_AAC") {
      const asc = readAsc(track.codecPrivate!)!;
      refPath = join(dir, `${name}.aac`);
      writeFileSync(refPath, Buffer.concat(real.flatMap((f) => [Buffer.from(adts(f.length, asc.frequencyIndex, asc.channelConfiguration)), Buffer.from(f)])));
      refFormat = "aac";
    } else {
      refPath = join(dir, `${name}.${track.codecId === "A_AC3" ? "ac3" : "eac3"}`);
      writeFileSync(refPath, Buffer.concat(real.map((f) => Buffer.from(f))));
      refFormat = track.codecId === "A_AC3" ? "ac3" : "eac3";
    }
  }
  const served = decode(mp4);
  const probe = sh("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=profile", "-of", "csv=p=0", mp4]).out.trim();
  const reference = refPath ? decode(refPath, refFormat) : null;
  const ch = served.channels || 1;
  const perFrame = frames.length ? served.pcm.length / ch / frames.length : 0;
  const realFrom = Math.round(leadSilent * perFrame);
  let maxDiff: number | null = null;
  let compared = 0;
  if (reference && reference.channels === served.channels) {
    const count = Math.min(reference.pcm.length, served.pcm.length - realFrom * ch);
    maxDiff = 0;
    for (let i = 0; i < count; i++) maxDiff = Math.max(maxDiff, Math.abs(reference.pcm[i] - served.pcm[realFrom * ch + i]));
    compared = count / ch;
  }
  // Le silence devant : tout à zéro ; derrière : à zéro après la première trame (qui porte le recouvrement).
  let silenceMax: number | null = null;
  let clickRatio: number | null = null;
  const msSamples = Math.round(served.rate / 1000);
  if (leadSilent > 0) {
    silenceMax = 0;
    for (let i = 0; i < realFrom * ch; i++) silenceMax = Math.max(silenceMax, Math.abs(served.pcm[i]));
    const joint = curvature(served.pcm, ch, realFrom - 2 * msSamples, realFrom + 2 * msSamples);
    const after = curvature(served.pcm, ch, realFrom, realFrom + 100 * msSamples);
    clickRatio = after > 0 ? joint / after : joint === 0 ? 0 : null;
  } else if (tailSilent > 0) {
    const realEnd = Math.round((frames.length - tailSilent) * perFrame);
    silenceMax = 0;
    for (let i = (realEnd + Math.round(perFrame)) * ch; i < served.pcm.length; i++) silenceMax = Math.max(silenceMax, Math.abs(served.pcm[i]));
    const joint = curvature(served.pcm, ch, realEnd - 2 * msSamples, realEnd + 2 * msSamples);
    const before = curvature(served.pcm, ch, realEnd - 100 * msSamples, realEnd);
    clickRatio = before > 0 ? joint / before : joint === 0 ? 0 : null;
  }
  const realPcm = served.pcm.subarray(realFrom * ch, realFrom * ch + (reference ? Math.min(reference.pcm.length, served.pcm.length - realFrom * ch) : 0));
  const result: WindowResult = {
    name,
    segments: [window[0], window[window.length - 1]],
    silentFrames: isSilent.filter(Boolean).length,
    realFrames: real.length,
    errors: [served.errors, reference?.errors ?? ""].filter(Boolean).join(" | "),
    rate: served.rate,
    channels: served.channels,
    profile: probe,
    maxDiff,
    compared,
    silenceMax,
    clickRatio: clickRatio === null ? null : round(clickRatio, 3),
    rmsSegments: realPcm.length ? astats(realPcm, ch, served.rate, dir, `${name}-s`).map((v) => round(v)) : [],
    rmsReference: reference ? astats(reference.pcm, reference.channels || 1, reference.rate, dir, `${name}-r`).map((v) => round(v)) : [],
  };
  if (track.codecId === "A_AAC") {
    const asc = readAsc(track.codecPrivate!)!;
    const parse = { frames: real.length, exact: 0, sbr: 0, errors: 0 };
    for (const f of real) {
      try {
        const block = readRawDataBlock(f, asc.frequencyIndex);
        if (block.exact) parse.exact += 1;
        if (block.elements.some((e) => e.sbr)) parse.sbr += 1;
      } catch {
        parse.errors += 1;
      }
    }
    result.aacParse = parse;
  }
  if (!KEEP) for (const p of [mp4, refPath]) if (p) rmSync(p, { force: true });
  return result;
}

describe.skipIf(!FILES)("le son copié réparé, sur de vrais fichiers", () => {
  it("chaque piste : segments seuls, recollés, décodés, comparés", async () => {
    mkdirSync(OUT, { recursive: true });
    const rows = readFileSync(FILES!, "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"))
      .map((l) => {
        const [path, label, track] = l.split("\t");
        return { path, label, track: track ? Number(track) : null };
      });
    for (const row of rows) {
      const line: Record<string, unknown> = { label: row.label, path: row.path };
      const dir = join(OUT, "tmp");
      mkdirSync(dir, { recursive: true });
      try {
        const source = await FileByteSource.open(row.path, { chunkSize: 16 * 1024, chunks: 64 });
        const t0 = performance.now();
        let index: LumenIndex;
        try {
          index = await buildLumenIndex(source, source.identity);
        } finally {
          source.close();
        }
        const number = (row.track ?? defaultAudioTrack(index)) as number;
        const track = index.audio.find((a) => a.number === number)!;
        const verdict = lumenEligibility(index, number);
        Object.assign(line, {
          indexMs: Math.round(performance.now() - t0),
          indexMB: round(index.cost.bytes / 1048576, 1),
          track: number,
          codec: track.codecId,
          channels: track.channels,
          rate: track.sampleRate,
          verdict: verdict.ok ? "ok" : `${verdict.reason} ${verdict.detail ?? ""}`.trim(),
          signal: track.signal,
          configuration: track.configuration ? hex(track.configuration) : null,
          codecPrivate: track.codecPrivate ? hex(track.codecPrivate) : null,
          silence: track.silence ? { frameBytes: track.silence.frame.length, frameUs: round(track.silence.frameUs, 3), leadUntilS: track.silence.leadUntilUs === null ? null : round(track.silence.leadUntilUs / 1e6, 3), tailFromS: track.silence.tailFromUs === null ? null : round(track.silence.tailFromUs / 1e6, 3) } : null,
        });
        if (verdict.ok) {
          const windows: [string, number[]][] = [];
          const s = track.silence;
          if (s?.leadUntilUs != null) windows.push(["devant", windowOf(index, 0, s.leadUntilUs + WINDOW_US)]);
          if (s?.tailFromUs != null) windows.push(["derriere", windowOf(index, Math.max(0, s.tailFromUs - WINDOW_US), index.durationUs)]);
          if (!s) {
            windows.push(["debut", windowOf(index, 0, WINDOW_US)]);
            windows.push(["milieu", windowOf(index, index.durationUs / 2, WINDOW_US)]);
          }
          line.windows = [];
          for (const [name, window] of windows) (line.windows as WindowResult[]).push(await judgeWindow(index, track, window, `${row.label}-${name}`.replace(/[^\w.-]+/g, "_"), dir));
          // La durée : la fin du son (dernier segment son) contre la fin de l'image (dernière présentation du
          // dernier segment vidéo), toutes deux sur la chronologie de présentation (− D).
          const last = index.segments.length - 1;
          const audioEnd = endDecode(parseFragments(await build(index, { kind: "audio", track: number }, last))) - index.delayUs;
          const video = parseFragments(await build(index, { kind: "video" }, last));
          const videoEnd = Math.max(...video.flatMap((f) => f.samples.map((x) => x.decode + x.cto + x.duration))) - index.delayUs;
          const audioStart = parseFragments(await build(index, { kind: "audio", track: number }, 0))[0].baseDecode - index.delayUs;
          Object.assign(line, { audioStartMs: round(audioStart / 1000, 1), audioEndMinusVideoEndMs: round((audioEnd - videoEnd) / 1000, 1), videoEndS: round(videoEnd / 1e6, 3), durationS: round(index.durationUs / 1e6, 3) });
        }
      } catch (error) {
        line.error = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack?.split("\n").slice(1, 4).join(" ")}` : String(error);
      }
      appendFileSync(join(OUT, "resultats.jsonl"), `${JSON.stringify(line)}\n`);
      console.log(`[son] ${row.label} : ${JSON.stringify(line).slice(0, 600)}`);
    }
  }, 3_600_000);
});
