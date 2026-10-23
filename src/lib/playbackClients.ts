/**
 * The two names this app plays under, as Jellyfin's dashboard and its history will show them.
 *
 * Jellyfin takes a client's identity from the `MediaBrowser` authorization header of each
 * request, not from the token — a token registered as one client at login can report playback as
 * another. That is what lets one account show which of the two players is actually running.
 *
 * Kept in a module of its own, with no imports: both the browser and the server need these
 * names, and reaching into the Jellyfin client for them would pull the server's configuration —
 * API keys included — into the browser's bundle.
 *
 * **Every name this app has ever announced lives here, and nowhere else.** The app was called
 * « CineApp » before « Laterna », and its engine « CineEngine By CineApp » before « Lumen ». The old
 * names stay recognised for good: a tab left open across the deploy keeps sending them, Jellyfin
 * keeps devices registered under them (`AppName`) until the daily clean-up retires them, and its
 * history holds them forever. Whatever compares a client or device name against "ours" reads
 * `isPlaybackClient` / `isOwnAppName` — never a literal.
 */
export const PLAYBACK_CLIENTS = {
  /** Playing through Jellyfin's own negotiated stream (the server player). */
  stable: "Laterna",
  /** Playing the file directly, decoded or repackaged here (Lumen, the in-browser engine). */
  engine: "Lumen by Laterna",
} as const;

export type PlaybackClient = (typeof PLAYBACK_CLIENTS)[keyof typeof PLAYBACK_CLIENTS];

/**
 * The names announced before the rename, each with the one it became. A body still carrying one
 * is reported under the new name: the start of the same session was reported by the server with
 * the new one, and Jellyfin keys a session by client — passed through as-is, the progress of an
 * old tab would open a second session beside the first.
 */
export const LEGACY_PLAYBACK_CLIENTS: Readonly<Record<string, PlaybackClient>> = {
  CineApp: PLAYBACK_CLIENTS.stable,
  "CineEngine By CineApp": PLAYBACK_CLIENTS.engine,
};

/**
 * The application names (`AppName` in Jellyfin's device list) under which a login of ours registers
 * its device — the current one first. Only the stable client logs in, so only its names are here.
 */
export const OWN_APP_NAMES: readonly string[] = [PLAYBACK_CLIENTS.stable, "CineApp"];

/**
 * Whether a value is one of ours — today's two names or the ones they replaced.
 *
 * The name is chosen by the browser and lands in the server's session list and its history, so
 * it is matched against these rather than passed through.
 */
export function isPlaybackClient(value: unknown): value is string {
  return currentPlaybackClient(value) !== null;
}

/** The name to report a value under today: itself when current, its successor when legacy, else `null`. */
export function currentPlaybackClient(value: unknown): PlaybackClient | null {
  if (typeof value !== "string") return null;
  if (Object.values(PLAYBACK_CLIENTS).some((name) => name === value)) return value as PlaybackClient;
  return Object.prototype.hasOwnProperty.call(LEGACY_PLAYBACK_CLIENTS, value) ? LEGACY_PLAYBACK_CLIENTS[value] : null;
}

/** Whether a Jellyfin device's `AppName` is one this app registered, under any of its names. */
export function isOwnAppName(value: unknown): boolean {
  return typeof value === "string" && OWN_APP_NAMES.includes(value);
}
