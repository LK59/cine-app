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

/**
 * Demande une taille à TMDB — et seulement à lui.
 *
 * Le nom disait déjà « tmdb », mais la fonction s'appliquait à n'importe quelle adresse. Or
 * Radarr et Sonarr renvoient aussi des visuels de TheTVDB, dont les chemins contiennent
 * eux aussi un segment `/original/` : la substitution le remplaçait par `/w1280/`, une taille
 * qui n'existe pas là-bas. Mesuré en direct sur cette bibliothèque —
 * `artworks.thetvdb.com/banners/fanart/original/82459-3.jpg` répond 200,
 * `…/fanart/w1280/82459-3.jpg` répond 403. C'est exactement pourquoi la bannière de certaines
 * séries manquait et pas d'autres : celles dont le visuel suit la disposition v4 de TheTVDB
 * n'ont pas de segment `/original/`, la substitution ne mordait pas, et elles s'affichaient.
 *
 * Une adresse qui n'est pas servie par le redimensionneur de TMDB est donc rendue telle quelle.
 */
export function tmdbResize(url: string | null | undefined, size: string): string | null {
  if (!url) return null;
  if (!/^https?:\/\/(image\.tmdb\.org|www\.themoviedb\.org)\//.test(url)) return url;
  return url.replace(/\/(original|w\d+)\//, `/${size}/`);
}
