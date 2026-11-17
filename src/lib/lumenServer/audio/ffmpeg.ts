// ffmpeg pour la conversion du son de Lumen serveur : le trouver, le juger, le lancer (DECISIONS.md §161).
//
// **La détection** (`detectLumenFfmpeg`, au démarrage et à la première demande, gardée sur `globalThis`) dit si la
// conversion est possible ici, par trois preuves (5-conversion-son.md §5.3) :
// - `ffmpeg -version` dit la version attendue (`EXPECTED_FFMPEG_VERSION`, celle de `tools/ffmpeg-lumen/build.sh`) —
//   une autre version n'a pas été mesurée (jointures, déterminisme, niveaux) ;
// - l'encodeur E-AC-3, les décodeurs, les démultiplexeurs et les filtres dont la conversion a besoin sont là ;
// - un encodage de 0,1 s de silence par cible rend une trame E-AC-3 conforme (48 kHz, six blocs, `acmod` attendu).
//   Cette trame sert aussi à décrire l'init des rendus convertis (`dec3`) : sa signalisation ne dépend que des
//   réglages de l'encodeur, jamais du son.
// Une instance qui retire le binaire, le monte ailleurs (`LUMEN_FFMPEG_PATH`) ou le vide est vue comme sans
// conversion : Lumen serveur refuse ces pistes comme avant, le lecteur actuel les convertit dans la page.
//
// **Le lancement** (`runFfmpeg`) : `spawn` avec un tableau d'arguments, **jamais de shell** ; aucun chemin de
// fichier dans les arguments — le flux arrive par l'entrée standard, les trames repartent par la sortie standard,
// et `-protocol_whitelist pipe` interdit tout autre accès ; un environnement vide (aucune clé ne traverse) ; une
// priorité abaissée (`os.setPriority`, 10 pour une demande, 15 pour l'avance : Jellyfin et la lecture passent
// devant) ; un délai maximal, puis `SIGKILL` ; une sortie bornée. Rien n'est écrit sur le disque par ffmpeg.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { setPriority } from "node:os";
import { config } from "@/lib/config";
import { readDolbyHeader } from "./dolbySilence";
import { CONVERT_RATE, CONVERT_TARGETS, TARGET_CAST_AAC, type ConvertTarget } from "./convertGrid";

/** La version de FFmpeg mesurée (prototype et banc du 17/11/2026), celle que `tools/ffmpeg-lumen` construit. */
export const EXPECTED_FFMPEG_VERSION = "7.1.5";

/** Ce que la conversion demande au binaire. */
export const REQUIRED = {
  encoders: ["eac3"],
  decoders: ["truehd", "dca", "opus", "mp2float", "mp3float"],
  demuxers: ["truehd", "dts", "ogg", "mp3", "f32le"],
  filters: ["pan", "atrim", "apad", "adelay"],
} as const;

export type FfmpegDetection =
  | {
      available: true;
      path: string;
      version: string;
      /** SHA-256 du binaire : la clé du cache le porte (un autre chemin SIMD pourrait changer des bits). */
      sha256: string;
      /** Ce qu'il sait encoder parmi E-AC-3, AC-3, AAC, FLAC (pour la Configuration). */
      encoders: string[];
      /** La trame de référence de chaque cible (`TARGET_51.id` → octets), pour le `dec3` de l'init. */
      reference: Record<string, Uint8Array>;
      detectedAt: number;
      ms: number;
    }
  | { available: false; path: string; reason: string; version?: string; detectedAt: number };

const STATE = Symbol.for("cine-app.lumenServer.ffmpeg");

interface State {
  path: string;
  promise: Promise<FfmpegDetection>;
  result: FfmpegDetection | null;
}

/** Le résultat de la dernière détection terminée, sans en lancer une (la Configuration, l'éligibilité). */
export function ffmpegDetected(): FfmpegDetection | null {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  const s = g[STATE];
  return s && s.path === config.lumen.ffmpegPath ? s.result : null;
}

/**
 * La détection, faite une fois par chemin de binaire (relu à chaque appel : `LUMEN_FFMPEG_PATH` change avec un
 * redéploiement, pas en cours de route). `force` : la refaire (bouton de la Configuration, tests).
 */
export function detectLumenFfmpeg(options: { force?: boolean } = {}): Promise<FfmpegDetection> {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  const path = config.lumen.ffmpegPath.trim();
  const held = g[STATE];
  if (held && held.path === path && !options.force) return held.promise;
  const state: State = { path, result: null, promise: Promise.resolve(null as unknown as FfmpegDetection) };
  state.promise = detect(path).then((r) => {
    state.result = r;
    return r;
  });
  g[STATE] = state;
  return state.promise;
}

/** Oublie la détection (tests). */
export function forgetFfmpegDetection(): void {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  g[STATE] = undefined;
}

async function detect(path: string): Promise<FfmpegDetection> {
  const began = performance.now();
  const at = Date.now();
  const no = (reason: string, version?: string): FfmpegDetection => ({ available: false, path, reason, detectedAt: at, ...(version ? { version } : {}) });
  if (!path) return no("LUMEN_FFMPEG_PATH vide");
  // Un chemin absolu seulement : jamais une recherche dans le PATH d'un processus dont l'environnement est vide.
  if (!path.startsWith("/")) return no("LUMEN_FFMPEG_PATH doit être absolu");
  if (!existsSync(/* turbopackIgnore: true */ path)) return no("ffmpeg absent");
  try {
    const versionOut = new TextDecoder().decode((await runFfmpeg(path, ["-hide_banner", "-version"], null, { timeoutMs: 5000 })).stdout);
    const version = parseFfmpegVersion(versionOut);
    if (!version) return no("version illisible");
    if (version !== EXPECTED_FFMPEG_VERSION) return no(`version ${version}, ${EXPECTED_FFMPEG_VERSION} attendue`, version);
    const lists: Record<keyof typeof REQUIRED, Set<string>> = {
      encoders: parseFfmpegList(new TextDecoder().decode((await runFfmpeg(path, ["-hide_banner", "-encoders"], null, { timeoutMs: 5000 })).stdout), "codec"),
      decoders: parseFfmpegList(new TextDecoder().decode((await runFfmpeg(path, ["-hide_banner", "-decoders"], null, { timeoutMs: 5000 })).stdout), "codec"),
      demuxers: parseFfmpegList(new TextDecoder().decode((await runFfmpeg(path, ["-hide_banner", "-demuxers"], null, { timeoutMs: 5000 })).stdout), "format"),
      filters: parseFfmpegList(new TextDecoder().decode((await runFfmpeg(path, ["-hide_banner", "-filters"], null, { timeoutMs: 5000 })).stdout), "filter"),
    };
    for (const kind of Object.keys(REQUIRED) as (keyof typeof REQUIRED)[]) {
      const missing = REQUIRED[kind].filter((name) => !lists[kind].has(name));
      if (missing.length > 0) return no(`${kind} absents : ${missing.join(", ")}`, version);
    }
    const reference: Record<string, Uint8Array> = {};
    for (const target of CONVERT_TARGETS) {
      const frame = await referenceFrame(path, target);
      const why = checkTargetFrame(frame, target);
      if (why || !frame) return no(`trame de référence ${target.id} : ${why}`, version);
      reference[target.id] = frame;
    }
    // La cible d'un récepteur Chromecast (§192), en plus : son absence ne retire rien à la conversion E-AC-3 — un binaire
    // sans encodeur AAC (ou sans décodeur AC-3/E-AC-3, dont l'AAC d'un Chromecast part pour la plupart des pistes) est
    // simplement sans Chromecast par Lumen serveur, et le récepteur garde le flux de Jellyfin.
    if (lists.encoders.has("aac") && lists.decoders.has("ac3") && lists.decoders.has("eac3") && lists.demuxers.has("eac3")) {
      const frames = await referenceFrame(path, TARGET_CAST_AAC).catch(() => null);
      if (frames) reference[TARGET_CAST_AAC.id] = AAC_LC_STEREO_48K;
    }
    const sha256 = createHash("sha256").update(readFileSync(/* turbopackIgnore: true */ path)).digest("hex");
    return {
      available: true,
      path,
      version,
      sha256,
      encoders: ["eac3", "ac3", "aac", "flac"].filter((e) => lists.encoders.has(e)),
      reference,
      detectedAt: at,
      ms: Math.round(performance.now() - began),
    };
  } catch (error) {
    return no(error instanceof Error ? error.message.slice(0, 200) : String(error));
  }
}

/** « ffmpeg version 7.1.5 Copyright … » → « 7.1.5 ». */
export function parseFfmpegVersion(text: string): string | null {
  return /^ffmpeg version (\S+)/m.exec(text)?.[1] ?? null;
}

/**
 * Les noms d'une liste de `ffmpeg -encoders`, `-decoders`, `-demuxers` ou `-filters`. Les deux premières ont une
 * colonne de six drapeaux (`A....D eac3  ATSC A/52 E-AC-3`), les démultiplexeurs deux (` D  dts  raw DTS`), les
 * filtres trois (` T.. adelay  A->A …`) ; une entrée peut grouper des noms (`D  f32le`, `D  mov,mp4,m4a,…`).
 */
export function parseFfmpegList(text: string, kind: "codec" | "format" | "filter"): Set<string> {
  const names = new Set<string>();
  const pattern = kind === "codec" ? /^\s*[VASDT.][A-Z.]{5}\s+(\S+)/ : kind === "format" ? /^\s*[D ][E ]d?\s+(\S+)/ : /^\s*[T.][S.C.]{1,2}\.?\s+(\S+)\s+\S+->\S+/;
  for (const line of text.split("\n")) {
    const m = pattern.exec(line);
    if (!m || m[1] === "=") continue;
    for (const name of m[1].split(",")) names.add(name);
  }
  return names;
}

/** Une trame produite pour `target` est-elle conforme ? null si oui, sinon la raison. */
export function checkTargetFrame(frame: Uint8Array | null | undefined, target: ConvertTarget): string | null {
  if (!frame) return "aucune trame";
  // L'AAC est vérifié en-tête par en-tête au découpage (`splitAdtsFrames`) : la trame brute n'a plus d'en-tête.
  if (target.codec === "aac") return frame.length > 0 ? null : "trame vide";
  const head = readDolbyHeader(frame);
  if (!head) return "en-tête illisible";
  if (head.kind !== "eac3" || head.bsid !== 16) return `bsid ${head.bsid}`;
  if (head.strmtyp !== 0 || head.substreamid !== 0) return `sous-flux ${head.strmtyp}/${head.substreamid}`;
  if (head.sampleRate !== CONVERT_RATE) return `${head.sampleRate} Hz`;
  if (head.blocks !== 6) return `${head.blocks} blocs`;
  if (head.acmod !== target.acmod || head.lfeon !== target.lfeon) return `acmod ${head.acmod}, lfeon ${head.lfeon}`;
  if (head.frameSize !== frame.length) return `taille ${frame.length} pour ${head.frameSize}`;
  return null;
}

/** Les trames d'un flux E-AC-3 brut, bout à bout. Lève si le flux ne se découpe pas exactement. */
export function splitEac3Frames(bytes: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; ) {
    if (at + 6 > bytes.length) throw new Error(`E-AC-3 : ${bytes.length - at} octets restants`);
    if (bytes[at] !== 0x0b || bytes[at + 1] !== 0x77) throw new Error(`E-AC-3 : synchronisation perdue à ${at}`);
    const size = ((((bytes[at + 2] & 0x07) << 8) | bytes[at + 3]) + 1) * 2;
    if (at + size > bytes.length) throw new Error(`E-AC-3 : trame tronquée à ${at}`);
    frames.push(bytes.subarray(at, at + size));
    at += size;
  }
  return frames;
}

/**
 * La configuration (AudioSpecificConfig, ISO/IEC 14496-3 §1.6.2.1) de la cible AAC d'un récepteur Chromecast : AAC-LC
 * (type 2), 48 kHz (indice 3), stéréo (configuration 2), trames de 1 024 — `0x11 0x90`. Constante : ce que l'encodeur
 * natif de FFmpeg écrit pour ces réglages, et ce que `splitAdtsFrames` vérifie sur chaque trame produite.
 */
export const AAC_LC_STEREO_48K = new Uint8Array([0x11, 0x90]);

/**
 * Les trames brutes d'un flux AAC en ADTS (ISO/IEC 13818-7 §6.2), sans leurs en-têtes : ce que le MP4 porte. Chaque
 * en-tête est vérifié — AAC-LC, 48 kHz, la configuration de canaux de la cible, un seul bloc par trame. Lève si le flux
 * ne se découpe pas exactement, comme `splitEac3Frames`.
 */
export function splitAdtsFrames(bytes: Uint8Array, channels = 2): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; ) {
    if (at + 7 > bytes.length) throw new Error(`ADTS : ${bytes.length - at} octets restants`);
    if (bytes[at] !== 0xff || (bytes[at + 1] & 0xf6) !== 0xf0) throw new Error(`ADTS : synchronisation perdue à ${at}`);
    const protectionAbsent = bytes[at + 1] & 0x01;
    const profile = bytes[at + 2] >> 6; // type d'objet − 1 : 1 = AAC-LC
    const frequency = (bytes[at + 2] >> 2) & 0x0f;
    const config = ((bytes[at + 2] & 0x01) << 2) | (bytes[at + 3] >> 6);
    const size = ((bytes[at + 3] & 0x03) << 11) | (bytes[at + 4] << 3) | (bytes[at + 5] >> 5);
    const blocks = (bytes[at + 6] & 0x03) + 1;
    const header = protectionAbsent ? 7 : 9;
    if (profile !== 1 || frequency !== 3 || config !== channels || blocks !== 1) throw new Error(`ADTS : trame ${frames.length} hors cible (profil ${profile}, fréquence ${frequency}, canaux ${config}, blocs ${blocks})`);
    if (size <= header || at + size > bytes.length) throw new Error(`ADTS : trame tronquée à ${at}`);
    frames.push(bytes.subarray(at + header, at + size));
    at += size;
  }
  return frames;
}

/** Les trames d'une sortie de l'encodeur, selon la cible. */
export function splitTargetFrames(bytes: Uint8Array, target: ConvertTarget): Uint8Array[] {
  return target.codec === "aac" ? splitAdtsFrames(bytes, target.channels) : splitEac3Frames(bytes);
}

/** Les arguments de l'encodeur pour une cible : les mêmes partout (détection, conversion, banc). */
export function encoderArgs(target: ConvertTarget): string[] {
  // L'AAC sort en ADTS : un flux qui se découpe trame par trame sans conteneur (`splitAdtsFrames`).
  if (target.codec === "aac") return ["-threads", "1", "-c:a", "aac", "-b:a", String(target.bitrate), "-f", "adts", "pipe:1"];
  return ["-threads", "1", "-c:a", "eac3", "-b:a", String(target.bitrate), "-f", "eac3", "pipe:1"];
}

async function referenceFrame(path: string, target: ConvertTarget): Promise<Uint8Array | null> {
  const samples = CONVERT_RATE / 10;
  const input = new Uint8Array(samples * target.channels * 4); // f32le, des zéros
  const { stdout } = await runFfmpeg(
    path,
    ["-nostdin", "-hide_banner", "-nostats", "-v", "error", "-protocol_whitelist", "pipe", "-f", "f32le", "-ar", String(CONVERT_RATE), "-ch_layout", target.layout, "-i", "pipe:0", ...encoderArgs(target)],
    input,
    { timeoutMs: 10_000 }
  );
  return splitTargetFrames(stdout, target)[0] ?? null;
}

// ── Le lancement ─────────────────────────────────────────────────────────────

export interface RunOptions {
  /** Au-delà, `SIGKILL` et une erreur. */
  timeoutMs: number;
  /** La priorité du processus (`nice`) : 0 par défaut, 10 pour une demande, 15 pour l'avance. */
  niceness?: number;
  /** La sortie standard au-delà de laquelle le processus est tué (64 Mo par défaut). */
  maxOutputBytes?: number;
  /** Arrêter avant la fin (une tâche d'avance qui cède sa place à une demande). */
  signal?: AbortSignal;
}

export interface RunResult {
  stdout: Uint8Array;
  ms: number;
  /** Du don des données au premier octet de sortie (ms), ou null s'il n'y en a pas eu. */
  firstByteMs: number | null;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "aborted" | "exit" | "spawn" | "output"
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

const STDERR_KEEP = 4096;

/** Un processus ffmpeg lancé, qui attend ses données sur son entrée standard (`feed`). */
export interface FfmpegProcess {
  readonly pid: number | undefined;
  /** L'instant du lancement (`performance.now()`). */
  readonly spawnedAt: number;
  /** Donne `input` (puis ferme l'entrée) et attend la sortie. Une seule fois par processus. */
  feed(input: Uint8Array | null, options: Pick<RunOptions, "timeoutMs" | "signal">): Promise<RunResult>;
  /** Le tue s'il n'a pas fini (un processus pré-lancé jamais servi, un arrêt). */
  kill(): void;
  /** Déjà sorti (tué, mort seul) : un processus pré-lancé dans cet état ne se sert plus. */
  readonly exited: boolean;
}

/**
 * Lance `path` avec `args` (sans shell) et rend la main tout de suite : le processus attend ses données. C'est la
 * forme du pool de processus pré-lancés (`ffmpegPool.ts`) ; `runFfmpeg` l'appelle et donne ses données aussitôt.
 * `RunResult.ms` compte du `feed` à la fin ; `firstByteMs`, du `feed` au premier octet de sortie (le coût de
 * lancement d'un processus froid s'y voit, celui d'un processus pré-lancé n'y est plus).
 */
export function startFfmpeg(path: string, args: readonly string[], options: Pick<RunOptions, "niceness" | "maxOutputBytes"> = {}): FfmpegProcess {
  const spawnedAt = performance.now();
  let child: ReturnType<typeof spawn> | null = null;
  let spawnError: FfmpegError | null = null;
  try {
    // Un environnement vide : aucune clé ni adresse de service ne traverse.
    child = spawn(path, [...args], { shell: false, env: {} as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  } catch (error) {
    spawnError = new FfmpegError(error instanceof Error ? error.message : String(error), "spawn");
  }
  if (child && options.niceness && child.pid) {
    try {
      setPriority(child.pid, options.niceness);
    } catch {
      // Un conteneur sans le droit de baisser une priorité : le processus tourne à la priorité normale.
    }
  }
  const max = options.maxOutputBytes ?? 64 * 1024 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  let stderr = "";
  let failure: FfmpegError | null = spawnError;
  let exited = !child;
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let firstByteAt: number | null = null;
  let settle: ((r: { code: number | null; signal: NodeJS.Signals | null }) => void) | null = null;
  const kill = (error: FfmpegError) => {
    if (failure || exited) return;
    failure = error;
    child?.kill("SIGKILL");
  };
  if (child) {
    child.stdout!.on("data", (chunk: Buffer) => {
      firstByteAt ??= performance.now();
      size += chunk.length;
      if (size > max) return kill(new FfmpegError(`ffmpeg : plus de ${max} octets en sortie`, "output"));
      chunks.push(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf-8")).slice(-STDERR_KEEP);
    });
    // ffmpeg peut se terminer avant d'avoir tout lu (une erreur) : EPIPE n'est pas l'erreur à rapporter.
    child.stdin!.on("error", () => {});
    child.on("error", (error) => kill(new FfmpegError(error.message, "spawn")));
    child.on("close", (code, signal) => {
      exited = true;
      exitInfo = { code, signal };
      settle?.(exitInfo);
    });
  }
  let fed = false;
  return {
    pid: child?.pid,
    spawnedAt,
    get exited() {
      return exited;
    },
    kill: () => kill(new FfmpegError("ffmpeg arrêté", "aborted")),
    feed(input, run) {
      return new Promise<RunResult>((resolve, reject) => {
        if (fed) return reject(new FfmpegError("processus déjà servi", "spawn"));
        fed = true;
        const began = performance.now();
        if (run.signal?.aborted) {
          kill(new FfmpegError("arrêté avant le lancement", "aborted"));
          return reject(failure ?? new FfmpegError("arrêté avant le lancement", "aborted"));
        }
        const timer = setTimeout(() => kill(new FfmpegError(`ffmpeg : plus de ${run.timeoutMs} ms`, "timeout")), run.timeoutMs);
        const onAbort = () => kill(new FfmpegError("ffmpeg arrêté (place cédée)", "aborted"));
        run.signal?.addEventListener("abort", onAbort, { once: true });
        const finish = ({ code, signal }: { code: number | null; signal: NodeJS.Signals | null }) => {
          clearTimeout(timer);
          run.signal?.removeEventListener("abort", onAbort);
          if (failure) return reject(failure);
          if (code !== 0) return reject(new FfmpegError(`ffmpeg : code ${code ?? signal} — ${stderr.trim().split("\n").slice(-3).join(" / ")}`, "exit"));
          const out = Buffer.concat(chunks);
          resolve({ stdout: new Uint8Array(out.buffer, out.byteOffset, out.byteLength), ms: Math.round(performance.now() - began), firstByteMs: firstByteAt === null ? null : Math.round(Math.max(0, firstByteAt - began)) });
        };
        if (exitInfo) return finish(exitInfo);
        settle = finish;
        if (!child) return;
        if (input) child.stdin!.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength));
        else child.stdin!.end();
      });
    },
  };
}

/**
 * Lance `path` avec `args` (sans shell), écrit `input` sur son entrée standard, rend sa sortie standard.
 * Lève `FfmpegError` pour un code de sortie non nul (avec la fin de stderr), un délai dépassé, une sortie trop
 * grosse ou un arrêt demandé — le processus est alors tué, jamais laissé derrière.
 */
export function runFfmpeg(path: string, args: readonly string[], input: Uint8Array | null, options: RunOptions): Promise<RunResult> {
  return startFfmpeg(path, args, options).feed(input, options);
}
