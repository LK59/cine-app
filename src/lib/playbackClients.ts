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
 */
export const PLAYBACK_CLIENTS = {
  /** Playing through Jellyfin's own negotiated stream. */
  stable: "CineApp",
  /** Playing the file directly, decoded or repackaged here. */
  engine: "CineEngine By CineApp",
} as const;

export type PlaybackClient = (typeof PLAYBACK_CLIENTS)[keyof typeof PLAYBACK_CLIENTS];

/**
 * Whether a value is one of the two.
 *
 * The name is chosen by the browser and lands in the server's session list and its history, so
 * it is matched against these rather than passed through.
 */
export function isPlaybackClient(value: unknown): value is PlaybackClient {
  return Object.values(PLAYBACK_CLIENTS).some((name) => name === value);
}
