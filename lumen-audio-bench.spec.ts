// Banc de la conversion du son de Lumen serveur (DECISIONS.md §161, 5-conversion-son.md §5.8) — sauté sans
// LUMEN_AUDIO_FILES et sans ffmpeg.
//
// Sur de vrais fichiers, en lecture seule, avec le ffmpeg de l'étape `ffmpeg-lumen` du Dockerfile (le binaire que
// l'image porte), par le code de la route (`convertRange`, `audio-feed`) :
// - **jointures** : 10 segments consécutifs construits chacun par son propre processus, et la même plage par une
//   seule tâche (l'avance) : trames identiques à l'octet, segments fMP4 identiques ; le décodage de la concaténation
//   (init + segments) sans erreur (`crccheck+bitstream+explode`), et le « rapport de clic » à chaque jointure
//   (énergie de la dérivée seconde sur ±2 ms rapportée aux 100 ms voisines ; sous 1,5 : pas de clic) ;
// - **déterminisme** : un segment refait par un autre processus, SHA-256 des segments ; et **après un saut** : un
//   segment loin dans le film, construit à froid, contre le même pris dans une tâche de trois segments ;
// - **placement** : le décodage des segments, posé à son `tfdt`, contre la source décodée par ffmpeg depuis le
//   début de la piste et repliée par le même `pan` : intercorrélation, écart en échantillons (0 attendu) ;
// - **niveaux par canal** : `astats` (RMS) de ce décodage et de la source repliée sur les mêmes secondes ;
// - **synchro image-son** (`LUMEN_AUDIO_SYNC`) : une piste E-AC-3 copiable passée par la chaîne de conversion,
//   contre la copie que sert la phase 1, toutes deux posées à leur `tfdt` : écart en échantillons ;
// - **son en retard** (`late`) : silence exact avant le premier bloc, puis le son à sa place.
// Et, sans fichier : **l'ordre des canaux** par tonalités marquées (la méthode de DOC-TECH « Channel order ») à
// travers `panFor` et l'encodeur, et la disposition écrite (`acmod`, LFE) pour une entrée `5.1` comme `5.1(side)`.
//
//   docker run --rm --name lumen-son-p2 --cpus 2 -m 2g -v "$PWD":/app -v /mnt/media/video:/media:ro \
//     -v <sorties>:/out -w /app -e LUMEN_AUDIO_FILES=/out/liste.tsv -e LUMEN_OUT=/out/resultats \
//     lumen-banc:p2 npx vitest run lumen-audio-bench.spec.ts
//
// LUMEN_AUDIO_FILES : `chemin<TAB>étiquette<TAB>piste[<TAB>départ en s][<TAB>late|sync]` par ligne. Une ligne JSON
// par piste dans LUMEN_OUT/resultats.jsonl.
import { describe, it, expect } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { FileByteSource } from "@/lib/lumenServer/fileSource";
import { buildLumenIndex } from "@/lib/lumenServer/lumenIndex";
import { buildSegment, segmentSpec } from "@/lib/lumenServer/segment";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { runLumenJob } from "@/lib/lumenServer/jobs";
import { convertRange, windowOf } from "@/lib/lumenServer/audio/convert";
import { convertSourceOf, type LumenConvertSource } from "@/lib/lumenServer/audio/convertSource";
import { CONVERT_RATE, EAC3_FRAME, panFor, targetFor, TARGET_51, type ConvertTarget } from "@/lib/lumenServer/audio/convertGrid";
import { checkTargetFrame, encoderArgs, splitEac3Frames } from "@/lib/lumenServer/audio/ffmpeg";
import { withConversion } from "@/lib/lumenServer/audio/view";
import type { AudioFeed, AudioFeedSpec } from "@/lib/lumenServer/audio/feed";
import type { LumenIndex } from "@/lib/lumenServer/format";
import { parseFragments } from "./src/__tests__/lumenServer-helpers";

const FILES = process.env.LUMEN_AUDIO_FILES;
const OUT = process.env.LUMEN_OUT ?? "/out/resultats";
const FFMPEG = process.env.LUMEN_FFMPEG_PATH || "/usr/local/bin/ffmpeg";
const HAS_FFMPEG = existsSync(FFMPEG);
const SEGMENTS = Number(process.env.LUMEN_AUDIO_SEGMENTS ?? 10);

function sh(args: string[], input?: Uint8Array): { code: number; err: string; bytes: Buffer } {
  const r = spawnSync(FFMPEG, args, { maxBuffer: 2 * 1024 * 1024 * 1024, input });
  return { code: r.status ?? -1, err: r.stderr?.toString("utf8") ?? "", bytes: r.stdout ?? Buffer.alloc(0) };
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** Lit un f32le entrelacé en plans. */
function planes(buf: Buffer, channels: number): Float32Array[] {
  const all = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
  const frames = Math.floor(all.length / channels);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) out[c][i] = all[i * channels + c];
  return out;
}

const readFeed = async (spec: AudioFeedSpec) => {
  const began = performance.now();
  const r = await runLumenJob({ type: "audio-feed", spec });
  if (r.type !== "audio-feed") throw new Error("réponse inattendue");
  return { feed: r.feed, diskMs: r.cost.diskMs, ms: Math.round(performance.now() - began) };
};

async function convert(index: LumenIndex, track: number, source: LumenConvertSource, target: ConvertTarget, n0: number, n1: number) {
  const began = performance.now();
  const r = await convertRange({ index, track, source, target, n0, n1, ffmpegPath: FFMPEG, readFeed, niceness: 0, timeoutMs: 300_000 });
  return { ...r, ms: Math.round(performance.now() - began) };
}

/** Les trames E-AC-3 d'un segment fMP4 (son `mdat`), et son `tfdt`. */
function framesOf(segment: Uint8Array): { tfdt: number; frames: Uint8Array[] } {
  const [fragment] = parseFragments(segment);
  return { tfdt: fragment.baseDecode, frames: fragment.data };
}

/** Décode init + segments par ffmpeg (détection d'erreurs stricte) en f32le, à la disposition de la cible. */
function decodeSegments(init: Uint8Array, segments: Uint8Array[], channels: number, dir: string, name: string): { ok: boolean; err: string; pcm: Float32Array[] } {
  const path = join(dir, `${name}.mp4`);
  writeFileSync(path, Buffer.concat([init, ...segments]));
  const r = sh(["-nostdin", "-hide_banner", "-v", "error", "-err_detect", "crccheck+bitstream+explode", "-i", path, "-af", "aformat=sample_fmts=flt", "-f", "f32le", "pipe:1"]);
  return { ok: r.code === 0 && r.err.trim() === "", err: r.err.trim().slice(0, 300), pcm: planes(r.bytes, channels) };
}

/** Rapport de clic à l'échantillon `at` : dérivée seconde sur ±2 ms, contre les 100 ms voisines. */
function clickRatio(x: Float32Array, at: number): number {
  const d2 = (i: number) => x[i + 1] - 2 * x[i] + x[i - 1];
  const energy = (from: number, to: number) => {
    let s = 0;
    for (let i = Math.max(1, from); i < Math.min(x.length - 1, to); i++) s += d2(i) ** 2;
    return s / Math.max(1, Math.min(x.length - 1, to) - Math.max(1, from));
  };
  const near = energy(at - 96, at + 96);
  const around = (energy(at - 4800 - 96, at - 96) + energy(at + 96, at + 4800 + 96)) / 2;
  return around > 1e-12 ? near / around : near > 1e-9 ? Infinity : 0;
}

/** Le décalage (échantillons) qui aligne `y` sur `x` au mieux, ±`span`, sur un plan. */
function lagOf(x: Float32Array, y: Float32Array, span = 960): { lag: number; score: number } {
  let best = { lag: 0, score: -2 };
  const from = span + 1;
  const to = Math.min(x.length, y.length) - span - 1;
  for (let lag = -span; lag <= span; lag++) {
    let dot = 0, n1 = 0, n2 = 0;
    for (let i = from; i < to; i += 2) {
      const a = x[i + lag], b = y[i];
      dot += a * b; n1 += a * a; n2 += b * b;
    }
    const score = dot / Math.sqrt(n1 * n2 + 1e-30);
    if (score > best.score) best = { lag, score };
  }
  return { lag: best.lag, score: round(best.score, 4) };
}

/** RMS par canal en dB. */
function rmsDb(p: Float32Array[], from: number, to: number): number[] {
  return p.map((x) => {
    let s = 0;
    for (let i = from; i < to; i++) s += x[i] * x[i];
    const r = Math.sqrt(s / Math.max(1, to - from));
    return r > 0 ? round(20 * Math.log10(r), 2) : -999;
  });
}

describe.skipIf(!HAS_FFMPEG)("la conversion du son, sans fichier", () => {
  it("l'ordre des canaux par tonalités marquées, et la disposition écrite", () => {
    // Une sinusoïde par rang source (ordre natif de FFmpeg pour « 7.1 » : FL FR FC LFE BL BR SL SR).
    const freqs = [300, 400, 500, 60, 700, 800, 900, 1000];
    const seconds = 3;
    const n = seconds * CONVERT_RATE;
    const make = (count: number) => {
      const buf = Buffer.alloc(n * count * 4);
      for (let i = 0; i < n; i++) for (let c = 0; c < count; c++) buf.writeFloatLE(0.1 * Math.sin((2 * Math.PI * freqs[c] * i) / CONVERT_RATE), (i * count + c) * 4);
      return buf;
    };
    const goertzel = (x: Float32Array, f: number) => {
      const k = (2 * Math.PI * f) / CONVERT_RATE, coeff = 2 * Math.cos(k);
      let s1 = 0, s2 = 0;
      for (let i = CONVERT_RATE / 2; i < x.length - CONVERT_RATE / 2; i++) { const s = x[i] + coeff * s1 - s2; s2 = s1; s1 = s; }
      return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2));
    };
    const dominant = (p: Float32Array[]) =>
      p.map((x) => {
        const e = freqs.map((f) => [f, goertzel(x, f)] as const);
        const max = Math.max(...e.map(([, v]) => v));
        return max < 1 ? "silence" : e.filter(([, v]) => v > max / 10).map(([f]) => f).sort((a, b) => a - b).join("+");
      });
    const chain = (count: number, layout: string) => {
      const target = targetFor(count);
      const enc = sh(["-nostdin", "-hide_banner", "-v", "error", "-f", "f32le", "-ar", "48000", "-ch_layout", layout, "-i", "pipe:0", "-af", panFor(count, target), ...encoderArgs(target)], make(count));
      expect(enc.code, enc.err).toBe(0);
      const frames = splitEac3Frames(enc.bytes);
      const check = checkTargetFrame(frames[1], target);
      const dec = sh(["-nostdin", "-hide_banner", "-v", "error", "-f", "eac3", "-i", "pipe:0", "-af", "aformat=sample_fmts=flt", "-f", "f32le", "pipe:1"], enc.bytes);
      return { check, channels: dominant(planes(dec.bytes, target.channels)) };
    };
    const results = {
      "7.1": chain(8, "7.1"),
      "5.1(side)": chain(6, "5.1(side)"),
      "5.1": chain(6, "5.1"),
      "3.0": chain(3, "3.0"),
      "stéréo": chain(2, "stereo"),
      mono: chain(1, "mono"),
    };
    if (FILES) {
      mkdirSync(OUT, { recursive: true });
      appendFileSync(join(OUT, "resultats.jsonl"), JSON.stringify({ kind: "tonalites", results }) + "\n");
    }
    // 7.1 → 5.1 : arrières et côtés repliés à −3 dB chacun (la règle de `fold`).
    expect(results["7.1"].channels).toEqual(["300", "400", "500", "60", "700+900", "800+1000"]);
    expect(results["5.1(side)"].channels).toEqual(["300", "400", "500", "60", "700", "800"]);
    expect(results["5.1"].channels).toEqual(["300", "400", "500", "60", "700", "800"]);
    expect(results["3.0"].channels).toEqual(["300", "400", "500", "silence", "silence", "silence"]);
    expect(results["stéréo"].channels).toEqual(["300", "400"]);
    expect(results.mono.channels).toEqual(["300", "300"]);
    // Le piège du PCE (AAC) ne touche pas l'E-AC-3 : `acmod` 7 + LFE pour `5.1` comme pour `5.1(side)`.
    for (const r of Object.values(results)) expect(r.check).toBeNull();
  });
});

describe.skipIf(!FILES || !HAS_FFMPEG)("la conversion du son, sur de vrais fichiers", () => {
  it("chaque piste : segments seuls, tâche longue, saut, placement, niveaux, synchro", async () => {
    mkdirSync(OUT, { recursive: true });
    const lines = readFileSync(FILES as string, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const failures: string[] = [];
    for (const l of lines) {
      const [path, label, trackRaw, fromRaw, mode] = l.split("\t");
      const work = join(OUT, "tmp", label.replace(/[^A-Za-z0-9_-]/g, "_"));
      mkdirSync(work, { recursive: true });
      const line: Record<string, unknown> = { label, path, track: Number(trackRaw), mode: mode ?? "conv" };
      try {
        const source = await FileByteSource.open(path);
        let index: LumenIndex;
        try {
          index = await buildLumenIndex(source, source.identity);
        } finally {
          source.close();
        }
        // `auto` : la première piste convertible du fichier ; `copie` : la première E-AC-3 copiable.
        const track =
          trackRaw === "auto" ? index.audio.find((a) => a.convert) : trackRaw === "copie" ? index.audio.find((a) => a.codecId === "A_EAC3" && !a.refusal) : index.audio.find((a) => a.number === Number(trackRaw));
        line.track = track?.number;
        if (!track) throw new Error(`piste ${trackRaw} absente`);
        let conv = track.convert;
        if (!conv) {
          // Une piste copiable passée par la chaîne (synchro, son en retard) : ses faits, comme l'index les aurait.
          const file = await (async () => {
            const s = await FileByteSource.open(path);
            try {
              return await openMediaFile(s);
            } finally {
              s.close();
            }
          })();
          const t = file.tracks.find((x) => x.number === track.number)!;
          const v = convertSourceOf(
            { codecId: t.codecId, codecPrivate: t.codecPrivate, channels: t.audio?.channels ?? 2, sampleRate: t.audio?.sampleRate ?? 48000 },
            { firstUs: track.firstUs, firstFrame: track.firstFrame, lastBlockUs: null },
            "matroska",
            { bench: true }
          );
          if (!v.ok) throw new Error(`non convertible : ${v.detail}`);
          conv = v.source;
        }
        const target = targetFor(conv.channels);
        line.codec = conv.codec;
        line.channels = conv.channels;
        line.target = target.id;
        line.grid = conv.grid;
        line.firstSample = conv.firstSample;
        // L'init d'un rendu converti, par la vue de la route (trame de référence : une trame de la cible encodée ici).
        const ref = splitEac3Frames(sh(["-nostdin", "-hide_banner", "-v", "error", "-f", "f32le", "-ar", "48000", "-ch_layout", target.layout, "-i", "pipe:0", ...encoderArgs(target)], new Uint8Array(4800 * target.channels * 4)).bytes)[0];
        const viewed = withConversion(track.convert ? index : { ...index, audio: index.audio.map((a) => (a.number === track.number ? { ...a, convert: conv, refusal: { reason: "son-codec" as const } } : a)) }, {
          ffmpegVersion: "banc",
          ffmpegSha256: "banc",
          reference: { [TARGET_51.id]: target.id === TARGET_51.id ? ref : ref, [target.id]: ref },
        });
        const init = viewed.inits.audio[track.number];
        if (!init) throw new Error("pas d'init converti");

        const fromS = Number(fromRaw || 300);
        const n0 = index.segments.findIndex((s) => s.endUs > fromS * 1e6);
        const n1 = Math.min(index.segments.length, n0 + SEGMENTS);
        line.segments = [n0, n1];

        // 1. Chaque segment seul, par son propre processus.
        const single: Uint8Array[] = [];
        const singleMs: number[] = [];
        for (let n = n0; n < n1; n++) {
          const r = await convert(index, track.number, conv, target, n, n + 1);
          single.push(r.segments.get(n)!);
          singleMs.push(r.facts.ffmpegMs + r.facts.feedMs);
        }
        singleMs.sort((a, b) => a - b);
        line.segmentMs = { median: singleMs[singleMs.length >> 1], max: singleMs[singleMs.length - 1] };
        // 2. La même plage par une seule tâche.
        const long = await convert(index, track.number, conv, target, n0, n1);
        line.longTaskMs = long.ms;
        const identical = single.map((b, i) => sha(b) === sha(long.segments.get(n0 + i)!));
        const frameIdentical = single.reduce((sum, b, i) => {
          const x = framesOf(b).frames, y = framesOf(long.segments.get(n0 + i)!).frames;
          return sum + x.filter((f, k) => y[k] && sha(f) === sha(y[k])).length;
        }, 0);
        const frameTotal = single.reduce((sum, b) => sum + framesOf(b).frames.length, 0);
        // Où diffèrent les trames, quand elles diffèrent : rang dans le segment (un défaut de pré-roulement se voit
        // en tête de segment, un défaut de placement partout).
        const differ = single.map((b, i) => {
          const x = framesOf(b).frames, y = framesOf(long.segments.get(n0 + i)!).frames;
          return x.map((f, k) => (y[k] && sha(f) === sha(y[k]) ? -1 : k)).filter((k) => k >= 0).slice(0, 6);
        });
        line.joins = { segmentsIdentical: identical.filter(Boolean).length, of: identical.length, frames: `${frameIdentical}/${frameTotal}`, differ };
        // 3. Déterminisme : un segment refait par un autre processus.
        const again = await convert(index, track.number, conv, target, n0 + 3, n0 + 4);
        line.deterministic = sha(again.segments.get(n0 + 3)!) === sha(single[3]);
        // 4. Après un saut : un segment loin, à froid, contre le même pris dans une tâche de trois.
        const far = Math.min(index.segments.length - 2, Math.floor(index.segments.length * 0.6));
        const cold = await convert(index, track.number, conv, target, far, far + 1);
        const three = await convert(index, track.number, conv, target, far - 1, far + 2);
        line.afterSeek = { n: far, identical: sha(cold.segments.get(far)!) === sha(three.segments.get(far)!), ms: cold.ms };

        // 5. Décodage de la concaténation, jointures.
        const dec = decodeSegments(init, single, target.channels, work, "segments");
        line.decode = { ok: dec.ok, err: dec.err };
        const tfdt0 = framesOf(single[0]).tfdt;
        const joinsAt = single.slice(1).map((b) => Math.round(((framesOf(b).tfdt - tfdt0) * CONVERT_RATE) / 1e6));

        // 6. Placement et niveaux contre la source, décodée par ffmpeg depuis le début de la piste et repliée.
        const a0 = Math.round(((tfdt0 - index.delayUs) * CONVERT_RATE) / 1e6); // échantillon absolu du premier
        const span = dec.pcm[0].length;
        const streamIndex = (await (async () => {
          const s = await FileByteSource.open(path);
          try {
            return (await openMediaFile(s)).tracks.filter((t) => t.type === "audio").findIndex((t) => t.number === track.number);
          } finally {
            s.close();
          }
        })());
        const firstReal = conv.codec === "opus" ? conv.firstSample + (conv.opusHead ? conv.opusHead[10] | (conv.opusHead[11] << 8) : 0) : conv.firstSample;
        const until = (a0 + span) / CONVERT_RATE + 1;
        const ref2 = sh(["-nostdin", "-hide_banner", "-v", "error", "-i", path, "-map", `0:a:${streamIndex}`, "-t", String(until), "-af", `${panFor(conv.channels, target)},aformat=sample_fmts=flt`, "-f", "f32le", "pipe:1"]);
        const src = planes(ref2.bytes, target.channels);
        // La source commence à son premier échantillon réel ; on la pose sur l'axe absolu.
        const slice = (p: Float32Array) => {
          const out = new Float32Array(span);
          for (let i = 0; i < span; i++) {
            const j = a0 + i - firstReal;
            out[i] = j >= 0 && j < p.length ? p[j] : 0;
          }
          return out;
        };
        const srcWin = src.map(slice);
        // Le rapport de clic à chaque jointure, sur le décodage des segments et sur la source aux mêmes échantillons :
        // un transitoire du film y monte autant des deux côtés ; un clic de jointure, seulement dans les segments.
        const clickAt = (p: Float32Array[], at: number) => round(Math.max(...p.slice(0, Math.min(3, p.length)).map((x) => clickRatio(x, at))), 3);
        line.clicks = joinsAt.map((at) => ({ segments: clickAt(dec.pcm, at), source: clickAt(srcWin, at) }));
        line.clickExcess = round(Math.max(0, ...joinsAt.map((at) => clickAt(dec.pcm, at) - clickAt(srcWin, at))), 3);
        const lags = dec.pcm.slice(0, 3).map((p, c) => lagOf(srcWin[c], p));
        line.placement = lags;
        const from = Math.round(0.5 * CONVERT_RATE);
        const to = span - EAC3_FRAME;
        const rmsOut = rmsDb(dec.pcm, from, to);
        const rmsSrc = rmsDb(srcWin, from, to);
        line.rms = { sortie: rmsOut, source: rmsSrc, ecart: rmsOut.map((v, i) => round(v - rmsSrc[i], 2)) };

        // 7. Synchro image-son : la copie de la phase 1 contre la conversion de la même piste.
        if (mode === "sync" && track.codecId === "A_EAC3" && !track.refusal) {
          const copied: Uint8Array[] = [];
          for (let n = n0; n < n1; n++) {
            const spec = segmentSpec(index, { kind: "audio", track: track.number }, n);
            const s = await FileByteSource.open(path);
            try {
              copied.push((await buildSegment(s, await openMediaFile(s), spec)).bytes);
            } finally {
              s.close();
            }
          }
          const cdec = decodeSegments(index.inits.audio[track.number], copied, track.channels, work, "copie");
          const ctfdt = framesOf(copied[0]).tfdt;
          // Les deux décodages posés sur l'axe de leur `tfdt`.
          const shift = Math.round(((ctfdt - tfdt0) * CONVERT_RATE) / 1e6);
          const aligned = (p: Float32Array) => {
            const out = new Float32Array(span);
            for (let i = 0; i < span; i++) out[i] = i - shift >= 0 && i - shift < p.length ? p[i - shift] : 0;
            return out;
          };
          line.sync = { copyOk: cdec.ok, lag: dec.pcm.slice(0, 3).map((p, c) => lagOf(aligned(cdec.pcm[c]), p)), tfdtShiftSamples: shift };
        }
        // 8. Son en retard : le silence avant le premier bloc, exact.
        if (mode === "late") {
          // Avant le premier son, l'encodeur a reçu des zéros exacts ; le décodeur AC-3/E-AC-3 de FFmpeg y ajoute son
          // tramage (« dither ») sur les mantisses à zéro bit — sauf sur le LFE —, d'où un niveau et non des zéros.
          let silent = 0, nonZeroBefore = 0, peak = 0;
          const firstAt = conv.firstSample - a0;
          for (let i = 0; i < Math.min(firstAt - EAC3_FRAME, span); i++)
            for (const p of dec.pcm) {
              if (p[i] === 0) silent++;
              else nonZeroBefore++;
              peak = Math.max(peak, Math.abs(p[i]));
            }
          line.late = { firstAt, silentSamples: silent, nonZeroBefore, peakDbfs: peak > 0 ? round(20 * Math.log10(peak), 1) : -999 };
        }
        const ok =
          line.decode && (line.decode as { ok: boolean }).ok &&
          (line.joins as { segmentsIdentical: number; of: number }).segmentsIdentical === (line.joins as { of: number }).of &&
          line.deterministic === true &&
          (line.afterSeek as { identical: boolean }).identical &&
          lags.every((x) => x.lag === 0 || x.score < 0.2);
        line.ok = ok;
        if (!ok) failures.push(label);
      } catch (error) {
        line.error = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack?.split("\n").slice(1, 4).join(" ")}` : String(error);
        failures.push(label);
      }
      appendFileSync(join(OUT, "resultats.jsonl"), JSON.stringify(line) + "\n");
      if (process.env.LUMEN_KEEP !== "1") rmSync(work, { recursive: true, force: true });
    }
    expect(failures).toEqual([]);
  }, 3_600_000);
});

// ── La mise à l'échelle (LUMEN_AUDIO_LOAD) ─────────────────────────────────────
//
// N conversions simultanées (N = 0, 1, 2, 4, 8 — `LUMEN_AUDIO_LOAD_STEPS`), chacune une boucle de segments à froid
// tirés au hasard dans les pistes de LUMEN_AUDIO_LOAD (mêmes lignes que LUMEN_AUDIO_FILES), **pendant que le remux sert
// des segments vidéo** d'un 4K (`LUMEN_AUDIO_LOAD_VIDEO`) par le vrai moteur — trois fils de calcul empaquetés
// (`LUMEN_WORKER`, `tools/lumen-worker/build.mjs`), sa file —, une requête à la fois comme Safari en lecture. Par palier :
// le temps par segment converti (médiane, p95), le processeur du conteneur (cgroup `cpu.stat`), le pic de mémoire
// (`memory.current` toutes les 200 ms), et la latence des segments vidéo copiés (médiane, p95) contre le palier 0.
import { pathToFileURL } from "node:url";
import { workerExecutor } from "@/lib/lumenServer/pool";
import { LumenEngine } from "@/lib/lumenServer/engine";

const LOAD = process.env.LUMEN_AUDIO_LOAD;

describe.skipIf(!LOAD || !HAS_FFMPEG)("la conversion du son, mise à l'échelle", () => {
  it("1, 2, 4, 8 processus pendant que le remux sert", async () => {
    mkdirSync(OUT, { recursive: true });
    const steps = (process.env.LUMEN_AUDIO_LOAD_STEPS ?? "0,1,2,4,8").split(",").map(Number);
    const phaseMs = Number(process.env.LUMEN_AUDIO_LOAD_S ?? 40) * 1000;
    const executor = workerExecutor(pathToFileURL(process.env.LUMEN_WORKER as string), 3);
    const engine = new LumenEngine({ executor });
    // Les lectures du son sur leurs propres fils (`lumenFeedReader`, deux), comme en service.
    const feedExecutor = workerExecutor(pathToFileURL(process.env.LUMEN_WORKER as string), 2);
    const readFeedW = async (spec: AudioFeedSpec) => {
      const began = performance.now();
      const r = await feedExecutor.run({ type: "audio-feed", spec });
      if (r.type !== "audio-feed") throw new Error("réponse inattendue");
      return { feed: r.feed, diskMs: r.cost.diskMs, ms: Math.round(performance.now() - began) };
    };
    const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
    const pct = (xs: number[], p: number) => {
      const s = [...xs].sort((a, b) => a - b);
      return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null;
    };
    const tracks: { index: LumenIndex; track: number; source: LumenConvertSource; label: string }[] = [];
    for (const l of readFileSync(LOAD as string, "utf8").split("\n").map((x) => x.trim()).filter((x) => x && !x.startsWith("#"))) {
      const [path, label, trackRaw] = l.split("\t");
      const s = await FileByteSource.open(path);
      const index = await buildLumenIndex(s, s.identity);
      s.close();
      const t = trackRaw === "auto" ? index.audio.find((a) => a.convert) : index.audio.find((a) => a.number === Number(trackRaw));
      if (t?.convert) tracks.push({ index, track: t.number, source: t.convert, label });
    }
    const vs = await FileByteSource.open(process.env.LUMEN_AUDIO_LOAD_VIDEO as string);
    const video = await buildLumenIndex(vs, vs.identity);
    vs.close();
    const cpuUsec = () => Number(/usage_usec (\d+)/.exec(readFileSync("/sys/fs/cgroup/cpu.stat", "utf8"))?.[1] ?? 0);
    const memNow = () => Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8"));
    const results: Record<string, unknown>[] = [];
    for (const n of steps) {
      const until = performance.now() + phaseMs;
      const conv: number[] = [];
      const ffmpegMs: number[] = [];
      const feedMs: number[] = [];
      const videoMs: number[] = [];
      let memPeak = memNow();
      const sampler = setInterval(() => (memPeak = Math.max(memPeak, memNow())), 200);
      const cpu0 = cpuUsec();
      const t0 = performance.now();
      const converters = Array.from({ length: n }, async () => {
        while (performance.now() < until) {
          const t = pick(tracks);
          const k = 1 + Math.floor(Math.random() * (t.index.segments.length - 2));
          const began = performance.now();
          const r = await convertRange({ index: t.index, track: t.track, source: t.source, target: targetFor(t.source.channels), n0: k, n1: k + 1, ffmpegPath: FFMPEG, readFeed: readFeedW, niceness: 10, timeoutMs: 60_000 });
          conv.push(performance.now() - began);
          ffmpegMs.push(r.facts.ffmpegMs);
          feedMs.push(r.facts.feedMs);
        }
      });
      const server = (async () => {
        let k = Math.floor(video.segments.length * 0.3);
        while (performance.now() < until) {
          const began = performance.now();
          await engine.segment(video, { kind: "video" }, k++ % video.segments.length);
          videoMs.push(performance.now() - began);
        }
      })();
      await Promise.all([...converters, server]);
      clearInterval(sampler);
      const seconds = (performance.now() - t0) / 1000;
      const line = {
        kind: "charge",
        processes: n,
        seconds: round(seconds, 1),
        converted: conv.length,
        segmentMs: { median: round(pct(conv, 0.5) ?? 0, 0), p95: round(pct(conv, 0.95) ?? 0, 0), max: round(Math.max(0, ...conv), 0) },
        ffmpegMs: { median: round(pct(ffmpegMs, 0.5) ?? 0, 0), p95: round(pct(ffmpegMs, 0.95) ?? 0, 0) },
        feedMs: { median: round(pct(feedMs, 0.5) ?? 0, 0), p95: round(pct(feedMs, 0.95) ?? 0, 0) },
        cores: round((cpuUsec() - cpu0) / 1e6 / seconds, 2),
        memPeakMB: Math.round(memPeak / 1048576),
        videoSegments: videoMs.length,
        videoMs: { median: round(pct(videoMs, 0.5) ?? 0, 0), p95: round(pct(videoMs, 0.95) ?? 0, 0) },
        load1: round(Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]), 1),
      };
      results.push(line);
      appendFileSync(join(OUT, "resultats.jsonl"), JSON.stringify(line) + "\n");
      await new Promise((r) => setTimeout(r, 3000));
    }
    await executor.close();
    await feedExecutor.close();
    expect(results.length).toBe(steps.length);
  }, 3_600_000);
});

// ── Les leviers de lancement (LUMEN_AUDIO_LAUNCH) ──────────────────────────────
//
// La question de Louis du 17/11/2026 : ce que coûte le **lancement** d'un ffmpeg, séparé du calcul, et ce qu'y gagne
// un pool de processus pré-lancés. Sur les pistes de LUMEN_AUDIO_LAUNCH (mêmes lignes que LUMEN_AUDIO_FILES) :
// 1. **le lancement** : pour une fenêtre d'une seule trame cible (le calcul le plus petit possible), le temps jusqu'au
//    premier octet rendu par un processus lancé à l'instant, contre le même processus lancé une seconde plus tôt et
//    qui attendait ses données ; et `ffmpeg -version` seul (création du processus, chargement du binaire). Par format
//    d'entrée, et pour le f32le (l'encodeur seul). Variante : `-probesize`/`-analyzeduration` minimaux ;
// 2. **le premier segment converti disponible**, par la vraie conversion (`LumenAudio`), à des positions tirées au
//    hasard (des sauts imprévus) : (a) à froid, sans pool ; (b) à froid, par le pool ; (c) demandé 300 ms après une
//    préparation du même segment ; (d) relu de la mémoire, puis du disque ; et (e) un saut imprévu pendant que
//    l'avance de la lecture tourne. Médiane et p90 sur `LUMEN_AUDIO_LAUNCH_REPS` répétitions (10 par défaut) ; et les
//    octets du pool contre ceux d'un processus seul, segment par segment.
import { startFfmpeg } from "@/lib/lumenServer/audio/ffmpeg";
import { conversionArgs as convArgs, feedSpecOf, windowOf as winOf } from "@/lib/lumenServer/audio/convert";
import { LumenAudio } from "@/lib/lumenServer/audio/conversion";
import { relativePathOf } from "@/lib/lumenServer/audio/convertCache";
import { withConversion as viewOf, conversionId } from "@/lib/lumenServer/audio/view";

const LAUNCH = process.env.LUMEN_AUDIO_LAUNCH;

describe.skipIf(!LAUNCH || !HAS_FFMPEG)("la conversion du son, leviers de lancement", () => {
  it("lancement, pool, préparation, caches", async () => {
    mkdirSync(OUT, { recursive: true });
    const reps = Number(process.env.LUMEN_AUDIO_LAUNCH_REPS ?? 10);
    const stat = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      return { median: s.length ? round(s[s.length >> 1], 1) : null, p90: s.length ? round(s[Math.min(s.length - 1, Math.floor(s.length * 0.9))], 1) : null, n: s.length };
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // `ffmpeg -version` : la création du processus et le chargement du binaire, rien d'autre.
    const version: number[] = [];
    for (let i = 0; i < 20; i++) {
      const p = startFfmpeg(FFMPEG, ["-hide_banner", "-version"]);
      const r = await p.feed(null, { timeoutMs: 10_000 });
      version.push(performance.now() - p.spawnedAt);
      void r;
    }
    appendFileSync(join(OUT, "resultats.jsonl"), JSON.stringify({ kind: "lancement-version", ms: stat(version) }) + "\n");

    const lines = readFileSync(LAUNCH as string, "utf8").split("\n").map((x) => x.trim()).filter((x) => x && !x.startsWith("#"));
    const cache = mkdtempSync(join(tmpdir(), "lumen-audio-launch-"));
    const audio = new LumenAudio(cache);
    const ctx = { ffmpegVersion: "7.1.5", ffmpegSha256: "banc", reference: {} as Record<string, Uint8Array> };
    for (const target of [TARGET_51, targetFor(2)]) {
      ctx.reference[target.id] = splitEac3Frames(sh(["-nostdin", "-hide_banner", "-v", "error", "-f", "f32le", "-ar", "48000", "-ch_layout", target.layout, "-i", "pipe:0", ...encoderArgs(target)], new Uint8Array(4800 * target.channels * 4)).bytes)[0];
    }
    // Le f32le (l'encodeur seul) : une fenêtre silencieuse d'une trame.
    const formats: { label: string; args: string[]; input: Uint8Array }[] = [];
    const tracks: { label: string; index: LumenIndex; track: LumenIndex["audio"][number] }[] = [];
    for (const l of lines) {
      const [path, label, trackRaw] = l.split("\t");
      const s = await FileByteSource.open(path);
      const index = await buildLumenIndex(s, s.identity);
      s.close();
      const t = trackRaw === "auto" ? index.audio.find((a) => a.convert) : index.audio.find((a) => a.number === Number(trackRaw));
      if (!t?.convert) continue;
      const viewed = viewOf(index, ctx);
      tracks.push({ label, index: viewed, track: viewed.audio.find((a) => a.number === t.number)! });
      const target = targetFor(t.convert.channels);
      const k = Math.floor(index.segments.length / 2);
      const w = winOf(index, k, k + 1);
      const tiny = { ...w, b: w.a + 1, end: w.start + 4 * EAC3_FRAME };
      const feed = (await runLumenJob({ type: "audio-feed", spec: feedSpecOf(index, t.number, t.convert, tiny) })) as { feed: AudioFeed | null };
      if (feed.feed) formats.push({ label, args: convArgs(feed.feed, tiny, t.convert.channels, target), input: feed.feed.bytes });
      if (formats.length === 1) formats.push({ label: "f32le", args: convArgs(null, tiny, 6, TARGET_51), input: new Uint8Array(24) });
    }
    for (const f of formats) {
      const cold: number[] = [];
      const warm: number[] = [];
      const coldTotal: number[] = [];
      const probe: number[] = [];
      for (let i = 0; i < Math.max(10, reps); i++) {
        const c = startFfmpeg(FFMPEG, f.args);
        const rc = await c.feed(f.input, { timeoutMs: 30_000 });
        cold.push(rc.firstByteMs ?? NaN);
        coldTotal.push(rc.ms);
        const w = startFfmpeg(FFMPEG, f.args);
        await sleep(300);
        const rw = await w.feed(f.input, { timeoutMs: 30_000 });
        warm.push(rw.firstByteMs ?? NaN);
        // Sans sonder : la variante `-probesize 32 -analyzeduration 0` (si ffmpeg l'accepte, mêmes octets ?).
        const at = f.args.indexOf("-f");
        const lean = [...f.args.slice(0, at), "-probesize", "32", "-analyzeduration", "0", ...f.args.slice(at)];
        const p = startFfmpeg(FFMPEG, lean);
        try {
          const rp = await p.feed(f.input, { timeoutMs: 30_000 });
          probe.push(rp.firstByteMs ?? NaN);
          if (i === 0) appendFileSync(join(OUT, "resultats.jsonl"), JSON.stringify({ kind: "lancement-sonde", format: f.label, sameBytes: sha(rp.stdout) === sha(rc.stdout) }) + "\n");
        } catch (error) {
          if (i === 0) appendFileSync(join(OUT, "resultats.jsonl"), JSON.stringify({ kind: "lancement-sonde", format: f.label, error: String(error).slice(0, 200) }) + "\n");
        }
      }
      appendFileSync(join(OUT, "resultats.jsonl"), JSON.stringify({ kind: "lancement", format: f.label, firstByteCold: stat(cold), firstByteWarm: stat(warm), totalCold: stat(coldTotal), firstByteLeanProbe: stat(probe) }) + "\n");
    }

    // Le premier segment converti disponible, par la vraie conversion.
    const readFeed = async (spec: AudioFeedSpec) => {
      const began = performance.now();
      const r = await runLumenJob({ type: "audio-feed", spec });
      if (r.type !== "audio-feed") throw new Error("réponse inattendue");
      return { feed: r.feed, diskMs: r.cost.diskMs, ms: Math.round(performance.now() - began) };
    };
    for (const t of tracks) {
      const version = `4-${sha(new TextEncoder().encode(t.label)).slice(0, 12)}`;
      const ask = (n: number, session: string) => audio.segment({ index: t.index, version, track: t.track, n, readFeed, session });
      const timed = async (n: number, session: string) => {
        const began = performance.now();
        const r = await ask(n, session);
        return { ms: performance.now() - began, r };
      };
      const segs = t.index.segments.length;
      const used = new Set<number>();
      const fresh = () => {
        for (;;) {
          const n = 2 + Math.floor(Math.random() * (segs - 4));
          if (!used.has(n) && !used.has(n + 1) && !used.has(n - 1)) {
            used.add(n);
            return n;
          }
        }
      };
      const a: number[] = [], b: number[] = [], c: number[] = [], ram: number[] = [], disk: number[] = [], seek: number[] = [], seekPool: number[] = [];
      let identical = 0, compared = 0;
      audio.setPlaybackMode("froid", { cold: true, pool: false, lead: false });
      audio.setPlaybackMode("pool", { cold: true, pool: true, lead: false });
      await ask(fresh(), "pool"); // le pool se remplit
      await sleep(300);
      for (let i = 0; i < reps; i++) {
        const n = fresh();
        const ra = await timed(n, "froid");
        a.push(ra.ms);
        await sleep(300); // le remplaçant pré-lancé du pool
        const rb = await timed(n, "pool");
        b.push(rb.ms);
        compared += 1;
        if (sha(ra.r.bytes) === sha(rb.r.bytes)) identical += 1;
        // (c) préparé : la demande arrive 300 ms après la préparation du même segment.
        const m = fresh();
        audio.setPlaybackMode(`prep-${i}`, { lead: false });
        audio.setPlaybackMode(`relu-${i}`, { lead: false });
        const prepared = ask(m, `prep-${i}`);
        await sleep(300);
        const rc = await timed(m, `prep-${i}`);
        c.push(rc.ms);
        await prepared;
        // L'écriture sur le disque part après la conversion (sans l'attendre) : la mesure du disque l'attend.
        const rel = relativePathOf(audio.keyOf(version, t.track.number, t.track.converted!.target, t.track.converted!.cid, m));
        for (let w = 0; w < 200 && rel && !audio.disk.has(rel); w++) await sleep(10);
        // (d) relu : de la mémoire, puis du disque.
        ram.push((await timed(m, `relu-${i}`)).ms);
        audio.memory.clear();
        disk.push((await timed(m, `relu-${i}`)).ms);
        // (e) un saut imprévu pendant que l'avance de la lecture tourne.
        for (const [list, key] of [[seek, `lit-${i}`], [seekPool, `lit-pool-${i}`]] as const) {
          audio.setPlaybackMode(key, { cold: true, pool: key.startsWith("lit-pool") });
          await ask(fresh(), key);
          await sleep(150);
          list.push((await timed(fresh(), key)).ms);
          // L'avance de cette lecture s'arrête avant la mesure suivante.
          audio.setPlaybackMode(key, { lead: false });
          while (audio.queue.stats.running + audio.queue.stats.leadQueued > 0) await sleep(50);
        }
      }
      appendFileSync(
        join(OUT, "resultats.jsonl"),
        JSON.stringify({ kind: "premier-segment", label: t.label, froid: stat(a), pool: stat(b), prepare300: stat(c), ram: stat(ram), disque: stat(disk), sautPendantAvance: stat(seek), sautPendantAvancePool: stat(seekPool), poolIdentique: `${identical}/${compared}`, poolStats: (await import("@/lib/lumenServer/audio/ffmpegPool")).ffmpegPool(() => FFMPEG).stats }) + "\n"
      );
    }
    (await import("@/lib/lumenServer/audio/ffmpegPool")).ffmpegPool(() => FFMPEG).close();
    void conversionId;
    expect(tracks.length).toBeGreaterThan(0);
  }, 3_600_000);
});
