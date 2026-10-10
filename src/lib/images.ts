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
 *
 * **Ce contrat est ouvert, et celui d'en face est fermé.** Ce qui sort d'ici part vers
 * `next/image` (`PosterImage`), donc vers `images.remotePatterns` de `next.config.js`, qui
 * n'autorise que `image.tmdb.org` et `artworks.thetvdb.com` — la directive `img-src` de la CSP,
 * juste en dessous, dit la même chose. Un `remoteUrl` de Radarr/Sonarr servi par un troisième
 * hôte traverse donc cette fonction sans encombre et se fait refuser en 400 par l'optimiseur,
 * ce que l'écran affiche en « No image », sans distinguer cela d'une affiche réellement absente.
 * Le cas n'est pas hypothétique : la ligne ci-dessous reconnaît `www.themoviedb.org`, qui n'est
 * dans aucune des deux listes. La restriction est délibérée (elle ferme un relais d'images
 * ouvert) et la liste a été relevée sur cette bibliothèque, pas devinée — mais elle décrit un
 * état, pas une garantie. `PosterImage` nomme désormais l'hôte fautif dans la console quand un
 * chargement échoue ; c'est là qu'on relie les deux.
 */
export function tmdbResize(url: string | null | undefined, size: string): string | null {
  if (!url) return null;
  if (!/^https?:\/\/(image\.tmdb\.org|www\.themoviedb\.org)\//.test(url)) return url;
  return url.replace(/\/(original|w\d+)\//, `/${size}/`);
}

/**
 * L'affiche d'un titre de la bibliothèque, dans la langue de qui regarde.
 *
 * Un seul endroit décide, et c'est tout l'objet de cette fonction. Avant elle, chaque écran
 * prenait l'affiche là où il en trouvait une : Radarr et Sonarr pour le catalogue et Ma liste,
 * TMDB interrogé dans la langue du site pour les recommandations. Radarr ne connaît qu'une
 * affiche par film — celle que TMDB sert par défaut, presque toujours l'originale —, si bien que
 * « Le Prénom » apparaissait sous ce nom dans une rangée et sous « What's in a Name? » dans la
 * suivante. Signalé le 19/09/2026, capture à l'appui.
 *
 * L'ordre est celui que Louis a demandé, et c'est aussi celui de TMDB lui-même : la langue de
 * l'application si elle existe, l'affiche d'origine sinon. Cette dernière est justement celle que
 * Radarr porte déjà — il n'y a donc aucun repli à aller chercher, et un titre sans affiche
 * localisée s'affiche exactement comme aujourd'hui.
 */
export function libraryPoster(
  posterByLang: Partial<Record<string, string>> | undefined,
  images: RadarrSonarrImage[] | undefined,
  locale: string,
  /** Avant l'affiche de Radarr/Sonarr : celle de Jellyfin pour une série (`jellyfinPoster`). */
  orElse: string | null = null
): string | null {
  return posterByLang?.[locale] ?? orElse ?? posterUrl(images, "thumb");
}

/**
 * L'affiche de Jellyfin redimensionnée, le repli d'une série entre celle de TMDB dans la langue de
 * qui regarde et l'original de TheTVDB que donne Sonarr — `libraryPoster(…, orElse)` (10/10/2026).
 *
 * Le repli de Sonarr est un original de TheTVDB servi sans aucune consigne de cache : après une
 * relance de l'appli, le navigateur le redemandait (une dizaine de séries de l'accueil), là où les
 * images de TMDB et de Jellyfin revenaient du disque. Même règle que `seriesBackdrop`.
 */
export function jellyfinPoster(jellyfinItem: { Id: string; ImageTags?: { Primary?: string } } | undefined): string | null {
  const tag = jellyfinItem?.ImageTags?.Primary;
  if (!jellyfinItem || !tag) return null;
  return `/api/jellyfin/image?${new URLSearchParams({ itemId: jellyfinItem.Id, kind: "poster", tag })}`;
}

/**
 * Le grand visuel d'une série (bannière de la fiche, fond du bureau, préchargements) — une seule
 * adresse, pour que tout ce qui la précharge la retrouve en cache (10/10/2026).
 *
 * Sonarr ne donne pour les séries que l'original de TheTVDB : 66 Ko à 2,1 Mo (relevé sur cette
 * bibliothèque), sans aucune consigne de cache — le navigateur pouvait le retélécharger après une
 * relance, et la première ouverture d'une fiche de série restait noire le temps de le recevoir.
 * Jellyfin a le même visuel et le sert redimensionné : 1 280 px de large, 70 à 160 Ko, par notre
 * relais `/api/jellyfin/image`, qui le marque immuable grâce à son `tag`. Repli : l'adresse de
 * TheTVDB comme avant, pour la série que Jellyfin n'a pas illustrée.
 */
export function seriesBackdrop(
  jellyfinItem: { Id: string; BackdropImageTags?: string[] } | undefined,
  images: RadarrSonarrImage[] | undefined
): string | null {
  const tag = jellyfinItem?.BackdropImageTags?.[0];
  if (jellyfinItem && tag) {
    return `/api/jellyfin/image?${new URLSearchParams({ itemId: jellyfinItem.Id, kind: "backdrop", tag })}`;
  }
  return tmdbResize(backdropUrl(images, "full"), "w1280");
}
