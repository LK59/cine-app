import { execFile, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DATA_DIR } from "@/lib/db";
import { logError } from "@/lib/logger";

export type TrailerMediaType = "movie" | "series";

const TRAILERS_DIR = path.join(DATA_DIR, "trailers");
const TMP_DIR = path.join(TRAILERS_DIR, ".tmp");
// Optional, user-supplied: export cookies from a real logged-in YouTube session (e.g. via the
// "Get cookies.txt LOCALLY" browser extension, Netscape format) and drop the file here. Only
// used if present — see downloadTrailer's own note on why this sometimes becomes necessary.
const COOKIES_FILE = path.join(DATA_DIR, "youtube-cookies.txt");

// A few downloads at once (per the explicit ask), not more — yt-dlp/ffmpeg are real CPU/network
// work, and this runs on the same box serving the app. Also gentler on YouTube's own bot
// detection, which reads a tight burst of concurrent automated-looking requests as exactly the
// pattern to flag (see downloadTrailer's own note).
export const DOWNLOAD_CONCURRENCY = 2;

function finalPath(tmdbId: number, mediaType: TrailerMediaType): string {
  return path.join(TRAILERS_DIR, `${mediaType}-${tmdbId}.mp4`);
}

// Plain synchronous disk check, not a cache — this is a local fs.existsSync, not a slow network
// call like getTitleLogo/getImdbRating's withPersistentCache exists to avoid repeating.
export function getLocalTrailerPath(tmdbId: number, mediaType: TrailerMediaType): string | null {
  const p = finalPath(tmdbId, mediaType);
  return fs.existsSync(p) ? p : null;
}

// Every yt-dlp/ffmpeg child process currently in flight — tracked so a cancel request (see
// killActiveDownloads) can actually kill them, not just stop scheduling new ones. A plain
// promisify(execFile) doesn't expose the ChildProcess handle, hence this hand-rolled wrapper.
const activeProcesses = new Set<ChildProcess>();

export function killActiveDownloads(): void {
  for (const child of activeProcesses) child.kill("SIGTERM");
}

function run(cmd: string, args: string[], opts: { timeout: number; maxBuffer?: number }): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, opts, (err, stdout, stderr) => {
      activeProcesses.delete(child);
      if (err) reject(Object.assign(err, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    activeProcesses.add(child);
  });
}

// Parses the LAST "crop=W:H:X:Y" line ffmpeg's cropdetect filter writes to stderr — later
// samples are more representative than the first (which often catches an opening black/logo
// frame that isn't representative of the trailer's real letterboxing, if any).
function parseCropDetect(stderr: string): { w: number; h: number; x: number; y: number } | null {
  const matches = [...stderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (matches.length === 0) return null;
  const [, w, h, x, y] = matches[matches.length - 1];
  return { w: Number(w), h: Number(h), x: Number(x), y: Number(y) };
}

async function probeSourceDimensions(file: string): Promise<{ w: number; h: number } | null> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=x:p=0",
      file,
    ], { timeout: 30_000 });
    const [w, h] = stdout.trim().split("x").map(Number);
    return Number.isFinite(w) && Number.isFinite(h) ? { w, h } : null;
  } catch {
    return null;
  }
}

// Best-effort letterbox removal — skipped (original kept as-is) whenever detection is
// inconclusive or the detected crop is essentially the full frame already (no meaningful bars),
// so a properly-formatted 16:9 trailer is never touched. Runs on a short sample, not the whole
// file, to keep this fast per title.
async function cropIfLetterboxed(input: string, output: string): Promise<boolean> {
  const source = await probeSourceDimensions(input);
  if (!source) return false;

  let stderr = "";
  try {
    await run("ffmpeg", ["-ss", "5", "-i", input, "-vframes", "30", "-vf", "cropdetect", "-f", "null", "-"], { timeout: 60_000 });
  } catch (err) {
    // ffmpeg with -f null exits non-zero in some builds even on success; the stderr we need is
    // on the error object either way.
    stderr = (err as { stderr?: string }).stderr ?? "";
  }
  const crop = parseCropDetect(stderr);
  if (!crop) return false;

  const areaRatio = (crop.w * crop.h) / (source.w * source.h);
  if (areaRatio >= 0.98) return false; // no meaningful bars — leave the original alone

  try {
    await run(
      "ffmpeg",
      ["-y", "-i", input, "-vf", `crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`, "-c:v", "libx264", "-crf", "20", "-preset", "veryfast", "-c:a", "copy", output],
      { timeout: 180_000 }
    );
    return true;
  } catch (err) {
    logError("trailer.crop", err, { input });
    return false;
  }
}

export async function downloadTrailer(
  tmdbId: number,
  mediaType: TrailerMediaType,
  trailerKey: string
): Promise<{ ok: boolean; error?: string }> {
  // Desynchronizes the DOWNLOAD_CONCURRENCY workers, which would otherwise all launch their
  // first yt-dlp process in the same instant — same anti-burst reasoning as --sleep-requests
  // below, just covering the gap BETWEEN separate process launches, which that flag (only
  // affects requests within one already-running yt-dlp process) can't reach.
  await new Promise((r) => setTimeout(r, Math.random() * 2000));

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const suffix = crypto.randomBytes(4).toString("hex");
  const rawTmp = path.join(TMP_DIR, `${mediaType}-${tmdbId}-${suffix}-raw.mp4`);
  const croppedTmp = path.join(TMP_DIR, `${mediaType}-${tmdbId}-${suffix}-cropped.mp4`);
  const cleanup = () => {
    for (const f of [rawTmp, croppedTmp]) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* didn't exist — fine */
      }
    }
  };

  try {
    await run(
      "yt-dlp",
      [
        "-f", "bv*[height<=1080]+ba/b[height<=1080]",
        "--no-playlist",
        "--no-write-subs",
        "--no-embed-subs",
        "--merge-output-format", "mp4",
        // Deliberately NOT forcing a specific --extractor-args player_client here — tried
        // forcing android/tv during troubleshooting and neither was more reliable than yt-dlp's
        // own adaptive default (which tries several clients on its own); YouTube's "Sign in to
        // confirm you're not a bot" wall showed up regardless of which client was requested, on
        // some titles and not others in the same run — it reads as request-volume/IP-reputation
        // triggered rather than something a client choice alone fixes. --cookies (below, only
        // when the file exists) is the reliable mitigation: a request from a real signed-in
        // session gets a much higher tolerance before that wall appears. See COOKIES_FILE's own
        // comment for how to supply one, and the settings page's own hint once failures show up.
        ...(fs.existsSync(COOKIES_FILE) ? ["--cookies", COOKIES_FILE] : []),
        // A little unpredictability + a floor: bursts of identical, evenly-spaced automated
        // requests are exactly the pattern that trips volume-based bot detection, so this jitters
        // rather than sleeping a fixed amount every time.
        "--sleep-requests", String(1 + Math.random() * 2),
        "-o", rawTmp,
        `https://www.youtube.com/watch?v=${trailerKey}`,
      ],
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }
    );

    const cropped = await cropIfLetterboxed(rawTmp, croppedTmp);
    const source = cropped ? croppedTmp : rawTmp;

    fs.mkdirSync(TRAILERS_DIR, { recursive: true });
    fs.renameSync(source, finalPath(tmdbId, mediaType));
    cleanup();
    return { ok: true };
  } catch (err) {
    cleanup();
    const message = err instanceof Error ? err.message : String(err);
    logError("trailer.download", err, { tmdbId, mediaType });
    return { ok: false, error: message };
  }
}
