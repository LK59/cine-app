import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { DATA_DIR } from "@/lib/db";
import { logError } from "@/lib/logger";

const execFileAsync = promisify(execFile);

export type TrailerMediaType = "movie" | "series";

const TRAILERS_DIR = path.join(DATA_DIR, "trailers");
const TMP_DIR = path.join(TRAILERS_DIR, ".tmp");

// A few downloads at once (per the explicit ask), not more — yt-dlp/ffmpeg are real CPU/network
// work, and this runs on the same box serving the app.
export const DOWNLOAD_CONCURRENCY = 3;

function finalPath(tmdbId: number, mediaType: TrailerMediaType): string {
  return path.join(TRAILERS_DIR, `${mediaType}-${tmdbId}.mp4`);
}

// Plain synchronous disk check, not a cache — this is a local fs.existsSync, not a slow network
// call like getTitleLogo/getImdbRating's withPersistentCache exists to avoid repeating.
export function getLocalTrailerPath(tmdbId: number, mediaType: TrailerMediaType): string | null {
  const p = finalPath(tmdbId, mediaType);
  return fs.existsSync(p) ? p : null;
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
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=s=x:p=0",
      file,
    ]);
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
    await execFileAsync("ffmpeg", ["-ss", "5", "-i", input, "-vframes", "30", "-vf", "cropdetect", "-f", "null", "-"], {
      timeout: 60_000,
    });
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
    await execFileAsync(
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
    await execFileAsync(
      "yt-dlp",
      [
        "-f", "bv*[height<=1080]+ba/b[height<=1080]",
        "--no-playlist",
        "--no-write-subs",
        "--no-embed-subs",
        "--merge-output-format", "mp4",
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
