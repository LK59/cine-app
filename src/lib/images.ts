interface RadarrSonarrImage {
  coverType: string;
  remoteUrl?: string;
  url?: string;
}

// images[].url points at Radarr/Sonarr's own internal Docker hostname
// (e.g. http://radarr:7878/MediaCover/...) which the browser — running on the
// user's machine, outside the docker network — can never reach. remoteUrl
// (TMDb's public CDN) is the only one actually loadable from the browser; we
// just ask TMDb for a smaller size instead of the original.
export function posterUrl(images?: RadarrSonarrImage[], size: "thumb" | "full" = "thumb"): string | null {
  const img = images?.find((i) => i.coverType === "poster");
  if (!img?.remoteUrl) return null;
  return size === "thumb" ? tmdbResize(img.remoteUrl, "w342") : tmdbResize(img.remoteUrl, "w500");
}

// Same remoteUrl-only constraint as posterUrl — Radarr/Sonarr's own `url` field points at their
// internal Docker hostname, unreachable from the browser.
export function backdropUrl(images?: RadarrSonarrImage[], size: "thumb" | "full" = "full"): string | null {
  const img = images?.find((i) => i.coverType === "fanart");
  if (!img?.remoteUrl) return null;
  return size === "thumb" ? tmdbResize(img.remoteUrl, "w780") : tmdbResize(img.remoteUrl, "original");
}

export function tmdbResize(url: string | null | undefined, size: string): string | null {
  if (!url) return null;
  return url.replace(/\/(original|w\d+)\//, `/${size}/`);
}
