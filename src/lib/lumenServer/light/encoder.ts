// L'encodeur de la version allégée : un ffmpeg avec VAAPI (le paquet Alpine `ffmpeg`, chemin `LUMEN_VIDEO_FFMPEG_PATH`,
// `/usr/bin/ffmpeg` par défaut) et le iGPU du serveur (`/dev/dri/renderD128`, à donner au conteneur). Distinct du
// ffmpeg épinglé de la conversion du son (`/usr/local/bin/ffmpeg`, §161), qui n'a aucun codec vidéo : rien de ce qui
// est mesuré pour le son ne dépend de celui-ci.
//
// **La détection** (`detectLightEncoder`, une fois par chemin, gardée sur `globalThis`) : le binaire répond, il a
// `hevc_vaapi` et `scale_vaapi`, le périphérique est lisible, et un encodage de deux images d'une mire 10 bits rend
// un flux HEVC. Elle note la version de ffmpeg et le pilote (« Intel iHD driver … 26.2.1 ») : tous deux entrent dans
// l'identité des échelons (`cid`), un autre pilote est une autre adresse. Absent ou en échec : pas de version allégée,
// et rien d'autre ne change.
//
// **Le lancement** : `spawn` sans shell, environnement vide (ni clé ni adresse ; le pilote se trouve seul), priorité
// abaissée (Jellyfin et la lecture passent devant), délai maximal puis `SIGKILL`, sortie bornée. ffmpeg lit le fichier
// lui-même (un chemin de l'index, jamais une entrée de requête : `-protocol_whitelist file`) — il lui faut chercher
// une clé et décoder depuis elle, ce qu'un flux sur l'entrée standard ne permet pas.

import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { setPriority } from "node:os";
import { config } from "@/lib/config";
import { shapeOf } from "./rungs";
import type { LumenLightRung } from "../format";

export const LIGHT_DEVICE = "/dev/dri/renderD128";

export type LightEncoderDetection =
  | { available: true; path: string; version: string; driver: string; detectedAt: number; ms: number }
  | { available: false; path: string; reason: string; detectedAt: number };

const STATE = Symbol.for("cine-app.lumenServer.lightEncoder");

interface State {
  path: string;
  promise: Promise<LightEncoderDetection>;
  result: LightEncoderDetection | null;
}

export interface EncodeRun {
  stdout: Uint8Array;
  stderr: string;
  ms: number;
}

export class EncodeError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "aborted" | "exit" | "spawn" | "output"
  ) {
    super(message);
    this.name = "EncodeError";
  }
}

/** Lance ffmpeg, attend la fin ; stdout borné, stderr gardé (les 16 premiers Ko : les horodatages y sont). */
export function runEncoder(path: string, args: readonly string[], options: { timeoutMs: number; niceness?: number; maxOutputBytes?: number; signal?: AbortSignal }): Promise<EncodeRun> {
  return new Promise((resolve, reject) => {
    const began = performance.now();
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(path, [...args], { shell: false, env: {} as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (error) {
      reject(new EncodeError(error instanceof Error ? error.message : String(error), "spawn"));
      return;
    }
    if (options.niceness && child.pid) {
      try {
        setPriority(child.pid, options.niceness);
      } catch {
        // Pas le droit de baisser la priorité : le processus tourne à la priorité normale.
      }
    }
    const max = options.maxOutputBytes ?? 128 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    let failure: EncodeError | null = null;
    const stop = (error: EncodeError) => {
      if (failure) return;
      failure = error;
      child.kill("SIGKILL");
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) return stop(new EncodeError(`ffmpeg : plus de ${max} octets en sortie`, "output"));
      chunks.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (stderr.length < 16384) stderr += chunk.toString("utf-8");
    });
    const timer = setTimeout(() => stop(new EncodeError(`ffmpeg : plus de ${options.timeoutMs} ms`, "timeout")), options.timeoutMs);
    const onAbort = () => stop(new EncodeError("ffmpeg : arrêté", "aborted"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (error) => stop(new EncodeError(error.message, "spawn")));
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new EncodeError(`ffmpeg : sortie ${code ?? signal} — ${stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 300)}`, "exit"));
      resolve({ stdout: new Uint8Array(Buffer.concat(chunks)), stderr, ms: performance.now() - began });
    });
  });
}

/**
 * Les arguments d'un encodage : `frames` images de la piste vidéo à partir de l'instant `fromUs` (temps du conteneur,
 * `-seek_timestamp` : ni le temps de départ du fichier ni rien d'autre ne s'y ajoute), décodées par le iGPU depuis la
 * clé d'avant (`-ss` précis : les RASL d'une CRA y sont décodées puis rendues, et rien d'avant `fromUs` ne sort),
 * réduites à la taille de l'échelon, encodées en HEVC sans image B, une seule IDR en tête (`-g` au-delà du segment),
 * en flux Annex B sur la sortie standard. `-stats_enc_pre` écrit sur la sortie d'erreur l'instant de chaque image
 * avant l'encodeur : la première dit si le départ est le bon (`firstEncodedMs`).
 */
export function encodeArgs(filePath: string, rung: Pick<LumenLightRung, "rung" | "width" | "height" | "tenBit" | "averageBps" | "peakBps">, fromUs: number, frames: number): string[] {
  const shape = shapeOf(rung.rung);
  // Une demi-milliseconde avant : l'instant en secondes ne doit pas tomber juste après l'image voulue par un arrondi.
  const from = Math.max(0, (fromUs - 500) / 1e6).toFixed(6);
  return [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-protocol_whitelist",
    "file",
    "-seek_timestamp",
    "1",
    "-copyts",
    "-hwaccel",
    "vaapi",
    "-hwaccel_device",
    LIGHT_DEVICE,
    "-hwaccel_output_format",
    "vaapi",
    "-ss",
    from,
    "-i",
    filePath,
    "-map",
    "0:v:0",
    "-an",
    "-sn",
    "-dn",
    "-frames:v",
    String(frames),
    "-vf",
    `scale_vaapi=w=${rung.width}:h=${rung.height}:format=${rung.tenBit ? "p010" : "nv12"}`,
    "-c:v",
    "hevc_vaapi",
    "-profile:v",
    rung.tenBit ? "main10" : "main",
    "-level",
    String(shape.level),
    "-b:v",
    String(rung.averageBps),
    "-maxrate",
    String(rung.peakBps),
    "-bufsize",
    String(rung.peakBps * 2),
    "-bf",
    "0",
    "-g",
    "100000",
    // Chaque image telle quelle, ni dupliquée ni jetée : sans cela, ffmpeg règle une cadence constante sur la base de
    // temps (1/1000 pour un Matroska) et répète la première image — 96 images couvrant 96 ms (banc du 17/11/2026).
    "-fps_mode",
    "passthrough",
    // `pipe:2` et non `/dev/stderr` : Node relie la sortie d'erreur par une socket, qu'un `open()` refuse (ENXIO).
    "-stats_enc_pre",
    "pipe:2",
    "-stats_enc_pre_fmt",
    "lumen-frame {n} {pts} {tb}",
    "-f",
    "hevc",
    "pipe:1",
  ];
}

/** L'instant (ms, temps du conteneur) de la première image donnée à l'encodeur, lu dans `-stats_enc_pre`, ou null. */
export function firstEncodedMs(stderr: string): number | null {
  const m = /^lumen-frame 0 (-?\d+) (\d+)\/(\d+)$/m.exec(stderr);
  if (!m) return null;
  return Math.floor((Number(m[1]) * Number(m[2]) * 1000) / Number(m[3]) + 1e-6);
}

/** Les instants (ms, temps du conteneur) de chaque image reçue par l'encodeur (`-stats_enc_pre`), dans l'ordre. */
export function encodedFramesMs(stderr: string): number[] {
  return [...stderr.matchAll(/^lumen-frame \d+ (-?\d+) (\d+)\/(\d+)$/gm)].map((m) => Math.floor((Number(m[1]) * Number(m[2]) * 1000) / Number(m[3]) + 1e-6));
}

/** Combien d'images l'encodeur a reçues (`-stats_enc_pre`). */
export function encodedFrames(stderr: string): number {
  return encodedFramesMs(stderr).length;
}

function state(): State | undefined {
  return (globalThis as unknown as Record<symbol, State | undefined>)[STATE];
}

/** Le résultat de la dernière détection terminée, sans en lancer une. */
export function lightEncoderDetected(): LightEncoderDetection | null {
  const s = state();
  return s && s.path === config.lumen.videoFfmpegPath ? s.result : null;
}

/** La détection, une fois par chemin. `force` : la refaire (tests, Configuration). */
export function detectLightEncoder(options: { force?: boolean } = {}): Promise<LightEncoderDetection> {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  const path = config.lumen.videoFfmpegPath;
  const s = g[STATE];
  if (s && s.path === path && !options.force) return s.promise;
  const fresh: State = { path, promise: Promise.resolve(null as unknown as LightEncoderDetection), result: null };
  fresh.promise = probe(path).then((result) => {
    fresh.result = result;
    return result;
  });
  g[STATE] = fresh;
  return fresh.promise;
}

async function probe(path: string): Promise<LightEncoderDetection> {
  const detectedAt = Date.now();
  const began = performance.now();
  const no = (reason: string): LightEncoderDetection => ({ available: false, path, reason, detectedAt });
  if (!path) return no("chemin vide");
  try {
    accessSync(LIGHT_DEVICE, constants.R_OK | constants.W_OK);
  } catch {
    return no(`${LIGHT_DEVICE} inaccessible (périphérique non donné au conteneur, ou groupe render absent)`);
  }
  let version: string;
  try {
    const v = await runEncoder(path, ["-hide_banner", "-version"], { timeoutMs: 10_000 });
    const m = /ffmpeg version (\S+)/.exec(new TextDecoder().decode(v.stdout));
    if (!m) return no("version illisible");
    version = m[1];
    const enc = await runEncoder(path, ["-hide_banner", "-encoders"], { timeoutMs: 10_000 });
    if (!/\bhevc_vaapi\b/.test(new TextDecoder().decode(enc.stdout))) return no("pas de hevc_vaapi");
    const fil = await runEncoder(path, ["-hide_banner", "-filters"], { timeoutMs: 10_000 });
    if (!/\bscale_vaapi\b/.test(new TextDecoder().decode(fil.stdout))) return no("pas de scale_vaapi");
  } catch (error) {
    return no(error instanceof Error ? error.message.slice(0, 200) : "ffmpeg injoignable");
  }
  try {
    // Deux images d'une mire en Main10 : le pilote charge, l'encodeur accepte le profil et le niveau du premier échelon.
    const run = await runEncoder(
      path,
      [
        "-hide_banner", "-nostdin", "-v", "verbose", "-init_hw_device", `vaapi=va:${LIGHT_DEVICE}`, "-filter_hw_device", "va",
        "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-frames:v", "2", "-vf", "format=p010,hwupload",
        "-c:v", "hevc_vaapi", "-profile:v", "main10", "-level", "123", "-bf", "0", "-f", "hevc", "pipe:1",
      ],
      { timeoutMs: 20_000 }
    );
    if (run.stdout.length < 100) return no("mire non encodée");
    const driver = /VAAPI driver: ([^\n]+)/.exec(run.stderr)?.[1]?.trim() ?? "inconnu";
    return { available: true, path, version, driver: driver.slice(0, 120), detectedAt, ms: Math.round(performance.now() - began) };
  } catch (error) {
    return no(`essai VAAPI : ${error instanceof Error ? error.message.slice(0, 200) : "échec"}`);
  }
}
