/**
 * Whether a film is filling the whole screen right now.
 *
 * A module-level flag rather than a context, because the one thing that needs to read it — SWR's
 * global configuration — sits above every provider in the tree and cannot reach into one.
 *
 * What it is for: the page behind a full-screen player stays mounted, and every poll on it keeps
 * running. On this app that is qBittorrent every eight seconds, Jellyfin's sessions every ten,
 * pending requests every fifteen, the activity feed every thirty — each one a radio wake-up, a
 * parse and a re-render of a page nobody can see, competing for bandwidth with the very byte
 * ranges the film is reading. On a phone the radio is the expensive part.
 *
 * Deliberately only full screen. Minimised, the viewer is *using* the page behind the film, and
 * freezing its live data while they browse would be trading one annoyance for a worse one.
 */
let watchingFullScreen = false;

export function setWatchingFullScreen(watching: boolean): void {
  watchingFullScreen = watching;
}

export function isWatchingFullScreen(): boolean {
  return watchingFullScreen;
}
