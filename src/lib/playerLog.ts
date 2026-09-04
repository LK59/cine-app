import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "@/lib/db";

/**
 * What actually happened during playback, for everybody, written to a file.
 *
 * The player steps aside to the stable one without asking and without saying so — which is the
 * right thing for whoever is watching and the wrong thing for whoever maintains it: on a server
 * with eighteen accounts, a path that fails silently fails invisibly, and the only person who
 * would ever notice is the one who happens to open the technical panel. This is the record that
 * makes it noticeable.
 *
 * A file rather than a table: it is read by a human with `tail` and `grep`, it is append-only,
 * and it must survive the database being rebuilt. One JSON object per line, the same shape the
 * rest of the app already logs in.
 */

const LOG_DIR = path.join(DATA_DIR, "logs");
const LOG_FILE = path.join(LOG_DIR, "player.log");

/** Rotated at this size, keeping one previous file. Bounded on purpose: this is a diary, not an archive. */
const MAX_BYTES = 5 * 1024 * 1024;

/** What the browser is allowed to report. Anything else is dropped rather than written. */
const KINDS = new Set(["start", "fallback", "network", "rebuild", "error", "stop"]);

export type PlayerEventKind = "start" | "fallback" | "network" | "rebuild" | "error" | "stop";

export function isPlayerEventKind(value: unknown): value is PlayerEventKind {
  return typeof value === "string" && KINDS.has(value);
}

/**
 * Trims a value from the browser down to something safe to write.
 *
 * Everything here is chosen by the client, so it is the client that decides how much disk this
 * costs. Strings are cut, numbers must be numbers, and nothing nested is accepted at all.
 */
function clean(fields: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (kept >= 24 || key.length > 40) continue;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = Math.round(value * 1000) / 1000;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "string" && value) out[key] = value.slice(0, 500);
    else continue;
    kept += 1;
  }
  return out;
}

function rotate(): void {
  try {
    if (fs.statSync(LOG_FILE).size < MAX_BYTES) return;
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // No file yet, or a rename that lost a race with another write: either way the append below
    // is what matters and it creates what it needs.
  }
}

/**
 * Appends one event. Never throws: a player must not fail because a log could not be written.
 *
 * `user` comes from the session on the server, never from the request body — otherwise the one
 * field that says who this was about would be the one field anybody could forge.
 */
export function logPlaybackEvent(
  user: string,
  kind: PlayerEventKind,
  fields: Record<string, unknown>
): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotate();
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      kind,
      user,
      ...clean(fields),
    });
    fs.appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // A disk that will not take a diary entry is not a reason to stop a film.
  }
}

/** Where it is, so the settings page and the documentation can say so without guessing. */
export const PLAYER_LOG_PATH = LOG_FILE;
