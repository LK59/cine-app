// Les genres du catalogue, regroupés sous un seul nom (07/10/2026).
//
// Radarr et Sonarr donnent les genres en anglais (« Horror », « Comedy ») ; une autre source — des
// métadonnées Jellyfin dans une autre langue, un import — peut donner « Horreur » ou « Comédie »
// pour les mêmes films. Ce sont alors deux genres : deux rangées sur l'accueil, deux entrées dans
// le filtre, et la moitié des films d'horreur sous chacune. Le nom anglais est la clé des genres
// traduits (`genres.*` dans les dictionnaires) : tout s'y ramène, une fois, à la construction du
// catalogue (`/api/cinema/movies`, `/api/cinema/series`), et tout ce qui le lit en profite.
//
// Les alias viennent des quatre dictionnaires de l'application — un genre qu'on sait afficher, on
// sait le reconnaître —, plus les genres composés de TMDB pour les séries. Volontairement plus
// strict que la recherche en langage naturel (`GENRE_ALIASES`), où « suspense » trouve les
// thrillers : ici « Suspense » et « Musical » sont des genres à eux, que Sonarr distingue.

import fr from "@/locales/fr.json";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import de from "@/locales/de.json";
import { normalize } from "./search-natural-query";

/** « Science-Fiction », « science fiction », « SCIENCE FICTION » : une seule forme à comparer. */
function flat(name: string): string {
  return normalize(name).replace(/[^a-z0-9]/g, "");
}

/** Les genres composés que TMDB donne aux séries : un nom pour deux genres. */
const COMPOUNDS: Record<string, string[]> = {
  actionadventure: ["Action", "Adventure"],
  scififantasy: ["Science Fiction", "Fantasy"],
  warpolitics: ["War"],
};

/** Les synonymes que les dictionnaires ne portent pas. */
const EXTRA: Record<string, string> = {
  scifi: "Science Fiction",
  sf: "Science Fiction",
  kids: "Children",
  enfants: "Children",
  jeunesse: "Children",
  miniserie: "Mini-Series",
  miniseries: "Mini-Series",
  telerealite: "Reality",
  realitytv: "Reality",
  epouvante: "Horror",
  documentaire: "Documentary",
  docu: "Documentary",
};

const CANONICAL = new Map<string, string>();
for (const dictionary of [en, fr, es, de]) {
  for (const [key, label] of Object.entries((dictionary as { genres: Record<string, string> }).genres)) {
    // La clé d'abord, à elle-même : une traduction qui coïnciderait avec une autre clé ne la
    // détourne pas.
    CANONICAL.set(flat(key), key);
    if (!CANONICAL.has(flat(label))) CANONICAL.set(flat(label), key);
  }
}
for (const [alias, key] of Object.entries(EXTRA)) if (!CANONICAL.has(alias)) CANONICAL.set(alias, key);

/**
 * Les genres d'un titre sous leur nom commun, sans doublon et dans leur ordre d'origine. Un genre
 * inconnu de tous les dictionnaires est gardé tel quel — on ne jette pas ce qu'on ne connaît pas.
 */
export function canonicalGenres(raw: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const name of raw ?? []) {
    const key = flat(name);
    const mapped = COMPOUNDS[key] ?? [CANONICAL.get(key) ?? name.trim()];
    for (const genre of mapped) if (genre && !out.includes(genre)) out.push(genre);
  }
  return out;
}
