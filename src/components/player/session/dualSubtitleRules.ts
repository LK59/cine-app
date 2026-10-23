// Deux sous-titres à la fois (DECISIONS.md §87) : les deux règles que le lecteur natif
// (`useNativeSubtitleLanes`) et le lecteur serveur (`ActivePlayer`, `PlayerHost.tsx`) écrivaient
// chacun — écrites une fois le 23/10/2026 (§115). Ici et non dans `src/lib/dualSubtitles.ts`, la
// mémoire du choix : hors des dossiers du lecteur, `decisions-partagees` ne la verrait plus.

/**
 * Le second sous-titre survit-il au nouveau principal `primary` ? Non s'il n'y a plus de principal
 * (un seul sous-titre, ou aucun), ni s'il devient lui-même le principal (les commandes rendent alors
 * l'ancien principal comme second). `bothGenerating` : le natif seul — une seule génération est
 * dessinée à la fois (§70, §87), le second ne survit pas à une seconde.
 */
export function secondSurvives(primary: number | null, second: number, bothGenerating = false): boolean {
  return !(primary === null || primary === second || bothGenerating);
}

/** Le second sous-titre `id` est-il permis sous le principal `primary` ? Jamais le principal, jamais sans principal. */
export function secondAllowed(id: number | null, primary: number | null): boolean {
  return !(id !== null && (id === primary || primary === null));
}
