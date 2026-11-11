import { blockedTagsOf, carriesBlockedTag } from "@/lib/blockedTags";
import { matchMovies } from "@/lib/catalogueMembers";
import { toCinemaMovie } from "@/lib/cinemaEntries";
import type { Locale } from "@/lib/i18n";
import { cachedJellyfinMoviesAdmin, cachedMovies } from "@/lib/server-cache";
import type { QuizTitle } from "./build";

/** Seules les images de TMDB entrent dans une partie : la route des images ne va chercher qu'elles. */
const tmdbImage = (url: string | null | undefined) => (typeof url === "string" && url.startsWith("https://image.tmdb.org/") ? url : null);

/**
 * Les films de la bibliothèque que **tous** ces comptes peuvent voir (DECISIONS.md §54 : les tags bloqués de
 * chacun), sous la forme qu'il faut à une partie. Un compte local (l'administrateur sans identité Jellyfin, `local:…`)
 * n'a pas de tag bloqué.
 */
export async function quizTitlesFor(subs: string[], locale: Locale): Promise<QuizTitle[]> {
  const [movies, jellyfinMovies] = await Promise.all([cachedMovies(), cachedJellyfinMoviesAdmin()]);
  const matched = matchMovies(movies, jellyfinMovies);
  const jfIds = subs.filter((sub) => !sub.startsWith("local:"));
  const blocked = [...new Set((await Promise.all(jfIds.map((id) => blockedTagsOf(id)))).flat())];
  const visible = blocked.length ? matched.filter((x) => !carriesBlockedTag(x.jfItem.Tags, blocked)) : matched;
  const cards = await Promise.all(visible.map(({ m, jfItem }) => toCinemaMovie(m, jfItem, locale)));
  return cards.map((c) => ({
    title: c.title,
    year: c.year ?? null,
    genres: c.genres ?? [],
    // L'affiche sans texte d'abord : l'autre porte le titre, qui finirait par se lire.
    poster: tmdbImage(c.posterTextlessUrl) ?? tmdbImage(c.posterUrl),
    backdrop: tmdbImage(c.backdropUrl),
    tagline: c.tagline || null,
    cast: c.castNames ?? [],
  }));
}
