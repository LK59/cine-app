// Banc de « Améliorer les dialogues » dans Lumen serveur (DECISIONS.md §193) — sauté sans LUMEN_DIALOGUE_FILES et sans
// ffmpeg.
//
// Sur de vrais fichiers, en lecture seule, avec le ffmpeg de l'image, par le code de la route (`convertRange` avec son
// traitement, `audio-feed`, le travail `dialogue` du fil de calcul) :
// - **identité** : chaque segment construit seul (son processus, son pré-roulement), et la même plage par une seule
//   tâche (l'avance) : segments fMP4 identiques à l'octet ; un segment refait : identique (déterminisme) ;
// - **jointures, avant l'encodeur** : le traitement de chaque segment depuis son pré-roulement R, contre UN traitement
//   continu de toute la plage (parti 40 s plus tôt) — l'écart maximal et l'écart RMS, en dB sous la pleine échelle et
//   sous le signal, pour R = 1, 2, 4, 6 (la règle) et 10 s ;
// - **jointures, après l'encodeur** : le décodage des segments servis (init + segments, détection d'erreurs stricte)
//   contre le traitement continu : rapport signal/écart, à comparer à celui d'un seul encodage du traitement continu
//   (ce que coûte l'E-AC-3 seul) ; et le « rapport de clic » à chaque jointure (dérivée seconde sur ±2 ms contre les
//   100 ms voisines), servi contre l'encodage continu au même endroit ;
// - **niveaux par canal** (`astats` de ffmpeg, RMS) : l'original replié, le rendu servi, et la chaîne du lecteur actuel
//   (`DialogueEnhancer` sur le même PCM, continu) — le rendu doit suivre la chaîne du lecteur actuel à l'encodage près ;
// - **coût** : un segment seul (lecture, ffmpeg, traitement), une tâche d'avance.
//
//   docker run --rm --name lumen-dlg-banc --cpus 2 -m 3g -v "$PWD":/app -v /mnt/media/video:/media:ro \
//     -v <sorties>:/out -w /app -e LUMEN_DIALOGUE_FILES=/out/liste.tsv -e LUMEN_OUT=/out/resultats \
//     lumen-banc:p2 npx vitest run lumen-dialogue-bench.spec.ts
//
// LUMEN_DIALOGUE_FILES : `chemin<TAB>étiquette<TAB>piste|auto[<TAB>départ en s]` par ligne (`auto` : chaque piste qui a
// un rendu « dialogues », deux au plus). Une ligne JSON par piste et par force dans LUMEN_OUT/dialogues.jsonl.
import { describe, it, expect } from "vitest";
import { appendFileSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { FileByteSource } from "@/lib/lumenServer/fileSource";
import { buildLumenIndex } from "@/lib/lumenServer/lumenIndex";
import { runLumenJob } from "@/lib/lumenServer/jobs";
import { convertRange, decoderStageArgs, encoderStageArgs, feedSpecOf, windowOf, type DialogueRun } from "@/lib/lumenServer/audio/convert";
import { CONVERT_RATE, EAC3_FRAME, ENCODER_PREROLL, inputWindow, segmentFrames, targetFor } from "@/lib/lumenServer/audio/convertGrid";
import { encoderArgs, splitEac3Frames } from "@/lib/lumenServer/audio/ffmpeg";
import { dialogueTrackView, withConversion, withDialogue, type ConversionContext } from "@/lib/lumenServer/audio/view";
import { DIALOGUE_PREROLL, enhanceWindow, planesOf, type LumenDialogueMode } from "@/lib/lumenServer/audio/dialogue";
import { DialogueEnhancer } from "@/lib/webcodecs/dialogueEnhance";
import type { AudioFeedSpec } from "@/lib/lumenServer/audio/feed";
import type { LumenAudioTrack, LumenIndex } from "@/lib/lumenServer/format";

/** Le segment qui contient l'instant `seconds` (la règle de `segmentAt`, sans les routes). */
function segmentAt(index: LumenIndex, seconds: number): number {
  let n = 0;
  while (n + 1 < index.segments.length && index.segments[n + 1].startUs <= seconds * 1e6) n++;
  return n;
}

const FILES = process.env.LUMEN_DIALOGUE_FILES;
const OUT = process.env.LUMEN_OUT ?? "/out/resultats";
const FFMPEG = process.env.LUMEN_FFMPEG_PATH || "/usr/local/bin/ffmpeg";
const HAS_FFMPEG = existsSync(FFMPEG);
const SEGMENTS = Number(process.env.LUMEN_DIALOGUE_SEGMENTS ?? 6);
const PREROLLS_S = [1, 2, 4, 6, 10];

function sh(args: string[], input?: Uint8Array): { code: number; err: string; bytes: Buffer } {
  const r = spawnSync(FFMPEG, args, { maxBuffer: 2 * 1024 * 1024 * 1024, input });
  return { code: r.status ?? -1, err: r.stderr?.toString("utf8") ?? "", bytes: r.stdout ?? Buffer.alloc(0) };
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex").slice(0, 16);
const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const db = (x: number) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

function interleavedPlanes(all: Float32Array, channels: number): Float32Array[] {
  const frames = Math.floor(all.length / channels);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) out[c][i] = all[i * channels + c];
  return out;
}
const bufPlanes = (b: Buffer, channels: number) => interleavedPlanes(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), channels);

const readFeed = async (spec: AudioFeedSpec) => {
  const began = performance.now();
  const r = await runLumenJob({ type: "audio-feed", spec });
  if (r.type !== "audio-feed") throw new Error("réponse inattendue");
  return { feed: r.feed, diskMs: r.cost.diskMs, ms: Math.round(performance.now() - began) };
};

/** Le traitement par le travail `dialogue` (sur ce fil : le banc mesure le calcul, pas le transfert). */
const runOf = (mode: LumenDialogueMode): DialogueRun => ({
  mode,
  enhance: async (work) => {
    const began = performance.now();
    const r = await runLumenJob({ type: "dialogue", work });
    if (r.type !== "dialogue") throw new Error("réponse inattendue");
    return { segments: r.segments, ms: Math.round(performance.now() - began) };
  },
});

async function convert(index: LumenIndex, track: LumenAudioTrack, mode: LumenDialogueMode, n0: number, n1: number) {
  const view = dialogueTrackView(track, mode)!;
  const target = targetFor(view.convert!.channels);
  const began = performance.now();
  const r = await convertRange({ index, track: track.number, source: view.convert!, target, n0, n1, ffmpegPath: FFMPEG, readFeed, niceness: 0, timeoutMs: 300_000, dialogue: runOf(mode) });
  return { ...r, ms: Math.round(performance.now() - began) };
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

const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

/** RMS par canal (dBFS) d'un PCM f32le entrelacé, par `astats` de ffmpeg. */
function astats(pcm: Float32Array, channels: number, layout: string): number[] {
  const r = sh(["-nostdin", "-hide_banner", "-v", "info", "-f", "f32le", "-ar", "48000", "-ch_layout", layout, "-i", "pipe:0", "-af", "astats=measure_overall=none:measure_perchannel=RMS_level", "-f", "null", "-"], new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  const levels = [...r.err.matchAll(/RMS level dB: (-?[\d.]+|-inf)/g)].map((m) => (m[1] === "-inf" ? -Infinity : Number(m[1])));
  return levels.slice(0, channels).map((v) => round(v));
}

function interleave(planes: Float32Array[]): Float32Array {
  const n = planes[0].length;
  const out = new Float32Array(n * planes.length);
  for (let i = 0; i < n; i++) for (let c = 0; c < planes.length; c++) out[i * planes.length + c] = planes[c][i];
  return out;
}

describe.skipIf(!FILES || !HAS_FFMPEG)("« Améliorer les dialogues » dans Lumen serveur, sur de vrais fichiers", () => {
  it("identité seul/avance, jointures avant et après l'encodeur, clics, niveaux, coût", async () => {
    mkdirSync(OUT, { recursive: true });
    const ctx: ConversionContext = { ffmpegVersion: "7.1.5", ffmpegSha256: "banc", reference: {}, dolby: true };
    for (const channels of [6, 2] as const) {
      const target = targetFor(channels === 6 ? 6 : 2);
      const ref = splitEac3Frames(sh(["-nostdin", "-hide_banner", "-v", "error", "-f", "f32le", "-ar", "48000", "-ch_layout", target.layout, "-i", "pipe:0", ...encoderArgs(target)], new Uint8Array(4800 * target.channels * 4)).bytes)[0];
      (ctx.reference as Record<string, Uint8Array>)[target.id] = ref;
    }
    const lines = readFileSync(FILES as string, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    const failures: string[] = [];
    for (const l of lines) {
      const [path, label, trackRaw, fromRaw] = l.split("\t");
      const source = await FileByteSource.open(path);
      let raw: LumenIndex;
      try {
        raw = await buildLumenIndex(source, source.identity);
      } finally {
        source.close();
      }
      const index = withDialogue(withConversion(raw, ctx), ctx);
      const tracks = trackRaw === "auto" ? index.audio.filter((a) => a.dialogue).slice(0, 2) : index.audio.filter((a) => a.number === Number(trackRaw) && a.dialogue);
      if (tracks.length === 0) {
        appendFileSync(join(OUT, "dialogues.jsonl"), JSON.stringify({ label, path, error: "aucune piste à rendu « dialogues »", audio: index.audio.map((a) => `${a.number}:${a.codecId}:${a.channels}:${a.refusal?.reason ?? "ok"}`) }) + "\n");
        continue;
      }
      for (const track of tracks) {
        for (const mode of ["on", "strong"] as LumenDialogueMode[]) {
          const line: Record<string, unknown> = { label, track: track.number, codec: track.codecId, channels: track.channels, mode };
          try {
            const d = track.dialogue!;
            const target = targetFor(d.source.channels);
            const n0 = Math.min(index.segments.length - SEGMENTS - 1, segmentAt(index, Number(fromRaw ?? 600)));
            const n1 = n0 + SEGMENTS;
            line.from = round(index.segments[n0].startUs / 1e6, 1);

            // ── Identité : seul, avance, déterminisme ──
            const solo: Uint8Array[] = [];
            const soloMs: number[] = [];
            const soloFacts: unknown[] = [];
            for (let n = n0; n < n1; n++) {
              const r = await convert(index, track, mode, n, n + 1);
              solo.push(r.segments.get(n)!);
              soloMs.push(r.ms);
              soloFacts.push({ feedMs: r.facts.feedMs, ffmpegMs: r.facts.ffmpegMs });
            }
            const lead = await convert(index, track, mode, n0, n1);
            const identical = solo.filter((b, i) => sha(b) === sha(lead.segments.get(n0 + i)!)).length;
            const again = await convert(index, track, mode, n0 + 2, n0 + 3);
            line.identical = `${identical}/${SEGMENTS}`;
            line.deterministic = sha(again.segments.get(n0 + 2)!) === sha(solo[2]);
            line.soloMs = soloMs;
            line.soloFacts = soloFacts[0];
            line.leadMs = lead.ms;
            if (identical !== SEGMENTS) failures.push(`${label} a${track.number} ${mode} : ${identical}/${SEGMENTS} identiques`);
            if (!line.deterministic) failures.push(`${label} a${track.number} ${mode} : non déterministe`);

            // ── Le PCM de la plage, et le traitement continu de référence ──
            const whole = windowOf(index, n0, n1);
            const longStart = whole.start - 40 * CONVERT_RATE;
            const got = await readFeed(feedSpecOf(index, track.number, d.source, { ...whole, start: longStart }));
            if (!got.feed) throw new Error("plage dans le silence");
            const decoded = sh(decoderStageArgs(got.feed, d.source.channels, target), got.feed.bytes);
            if (decoded.code !== 0) throw new Error(`décodage : ${decoded.err.slice(0, 200)}`);
            const pcm = new Float32Array(decoded.bytes.buffer.slice(decoded.bytes.byteOffset, decoded.bytes.byteOffset + decoded.bytes.byteLength));
            const pcmStart = got.feed.startSample;
            const ch = target.channels;
            const mono = d.source.channels === 1;
            // Le traitement continu : un seul `DialogueEnhancer` de `longStart` à la fin de la plage — ce que ferait le
            // lecteur actuel en lisant le film d'un trait.
            const contFrom = Math.max(longStart, pcmStart);
            const contIn = planesOf(pcm, pcmStart, ch, contFrom, whole.end, mono ? 0 : undefined);
            const contOut = new DialogueEnhancer(CONVERT_RATE, mono ? 1 : ch, mode).process(contIn);
            const contAt = (c: number, abs: number) => contOut[mono ? 0 : c][abs - contFrom];

            // ── Jointures avant l'encodeur, pour chaque pré-roulement ──
            const sweep: Record<string, { maxDb: number; rmsDb: number; relDb: number }> = {};
            for (const R of PREROLLS_S) {
              let maxAbs = 0;
              let err2 = 0;
              let sig2 = 0;
              let count = 0;
              for (let n = n0; n < n1; n++) {
                const [a, b] = segmentFrames(index, n, n + 1);
                const w = inputWindow(a, b);
                const seg = enhanceWindow({ pcm, pcmStart, channels: ch, mono, mode, preroll: R * CONVERT_RATE }, w);
                // Seules les trames gardées comptent : [a·N, b·N) en absolu, P trames + 256 après le début de la fenêtre.
                const keepFrom = a * EAC3_FRAME;
                const keepTo = b * EAC3_FRAME;
                for (let s = keepFrom; s < keepTo; s++) {
                  for (let c = 0; c < ch; c++) {
                    const v = seg[(s - w.start) * ch + c];
                    const ref = contAt(c, s);
                    const e = Math.abs(v - ref);
                    if (e > maxAbs) maxAbs = e;
                    err2 += e * e;
                    sig2 += ref * ref;
                    count++;
                  }
                }
              }
              sweep[`${R}s`] = { maxDb: round(db(maxAbs), 1), rmsDb: round(db(Math.sqrt(err2 / count)), 1), relDb: round(10 * Math.log10(err2 / Math.max(1e-30, sig2)), 1) };
            }
            line.prerollSweep = sweep;
            const rule = sweep[`${DIALOGUE_PREROLL / CONVERT_RATE}s`];
            if (!(rule.maxDb < -60)) failures.push(`${label} a${track.number} ${mode} : écart de jointure ${rule.maxDb} dBFS au pré-roulement de la règle`);

            // ── Après l'encodeur : servi contre continu, et un seul encodage du continu ──
            const [a0] = segmentFrames(index, n0, n0 + 1);
            const [, bK] = segmentFrames(index, n1 - 1, n1);
            const work = join(OUT, "tmp");
            mkdirSync(work, { recursive: true });
            const servedPath = join(work, `${label.replace(/[^A-Za-z0-9_-]/g, "_")}-a${track.number}-${mode}.mp4`);
            writeFileSync(servedPath, Buffer.concat([d.init, ...solo]));
            const servedDec = sh(["-nostdin", "-hide_banner", "-v", "error", "-err_detect", "crccheck+bitstream+explode", "-i", servedPath, "-af", "aformat=sample_fmts=flt", "-f", "f32le", "pipe:1"]);
            line.decodeClean = servedDec.code === 0 && servedDec.err.trim() === "";
            if (!line.decodeClean) failures.push(`${label} a${track.number} ${mode} : décodage des segments ${servedDec.err.slice(0, 120)}`);
            const served = bufPlanes(servedDec.bytes, ch);
            // Un encodage du traitement continu sur la même plage (P trames devant, T derrière), décodé.
            const cw = inputWindow(a0, bK);
            const contWindow = new Float32Array((cw.end - cw.start) * ch);
            for (let s = cw.start; s < cw.end; s++) for (let c = 0; c < ch; c++) contWindow[(s - cw.start) * ch + c] = contAt(c, s);
            const contEnc = sh(encoderStageArgs(target), new Uint8Array(contWindow.buffer));
            const contFrames = splitEac3Frames(contEnc.bytes).slice(ENCODER_PREROLL, ENCODER_PREROLL + (bK - a0));
            const contDec = sh(["-nostdin", "-hide_banner", "-v", "error", "-f", "eac3", "-i", "pipe:0", "-af", "aformat=sample_fmts=flt", "-f", "f32le", "pipe:1"], Buffer.concat(contFrames));
            const contPlanes = bufPlanes(contDec.bytes, ch);
            // Le décodeur E-AC-3 rend la trame k à l'instant k·N : les deux décodages commencent à a0·N.
            const len = Math.min(served[0].length, contPlanes[0].length, (bK - a0) * EAC3_FRAME);
            const snr = (x: Float32Array[]) => {
              let e2 = 0;
              let s2 = 0;
              for (let c = 0; c < ch; c++) {
                for (let i = 0; i < len; i++) {
                  const ref = contAt(c, a0 * EAC3_FRAME + i);
                  e2 += (x[c][i] - ref) ** 2;
                  s2 += ref * ref;
                }
              }
              return round(10 * Math.log10(s2 / Math.max(1e-30, e2)), 2);
            };
            line.snrServedDb = snr(served);
            line.snrOneEncodeDb = snr(contPlanes);
            // Servi contre un seul encodage, directement : ce que les jointures ajoutent par-dessus l'encodage.
            let e2 = 0;
            let s2 = 0;
            for (let c = 0; c < ch; c++) for (let i = 0; i < len; i++) {
              e2 += (served[c][i] - contPlanes[c][i]) ** 2;
              s2 += contPlanes[c][i] ** 2;
            }
            line.servedVsOneEncodeDb = round(10 * Math.log10(s2 / Math.max(1e-30, e2)), 2);

            // ── Clics aux jointures : le canal des voix ──
            const voice = ch === 6 ? 2 : 0;
            const clicks: { at: number; served: number; oneEncode: number }[] = [];
            for (let n = n0 + 1; n < n1; n++) {
              const [a] = segmentFrames(index, n, n + 1);
              const at = (a - a0) * EAC3_FRAME;
              clicks.push({ at: round(index.segments[n].startUs / 1e6, 2), served: round(clickRatio(served[voice], at), 2), oneEncode: round(clickRatio(contPlanes[voice], at), 2) });
            }
            line.clicks = clicks;
            const worst = Math.max(...clicks.map((c) => c.served / Math.max(0.5, c.oneEncode)));
            line.clickWorstVsOneEncode = round(worst, 2);
            if (worst > 1.5) failures.push(`${label} a${track.number} ${mode} : clic ${round(worst, 2)} à une jointure`);

            // ── Niveaux par canal (astats) : original replié, servi, chaîne du lecteur actuel ──
            const origPlanes = planesOf(pcm, pcmStart, ch, a0 * EAC3_FRAME, a0 * EAC3_FRAME + len);
            const clientPlanes = Array.from({ length: ch }, (_, c) => Float32Array.from({ length: len }, (_, i) => contAt(c, a0 * EAC3_FRAME + i)));
            const layout = ch === 6 ? "5.1(side)" : "stereo";
            line.astats = {
              original: astats(interleave(origPlanes), ch, layout),
              client: astats(interleave(clientPlanes), ch, layout),
              served: astats(interleave(served.map((p) => p.subarray(0, len))), ch, layout),
            };
            line.voiceGainDb = round(db(rms(clientPlanes[voice]) / Math.max(1e-12, rms(origPlanes[voice]))), 2);
          } catch (error) {
            line.error = error instanceof Error ? error.message : String(error);
            failures.push(`${label} a${track.number} ${mode} : ${line.error}`);
          }
          appendFileSync(join(OUT, "dialogues.jsonl"), JSON.stringify(line) + "\n");
        }
      }
    }
    expect(failures).toEqual([]);
  }, 3_600_000);
});
