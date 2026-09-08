import { UPSTREAM_UNREACHABLE } from "@/lib/http";

/**
 * Le code d'une réponse, porté par l'erreur qu'on lève.
 *
 * Une erreur qui ne transporte qu'un message oblige l'écran à comparer des phrases — ce qui casse
 * à la première traduction et à la première reformulation. Le code reste là où il est né : dans la
 * réponse du serveur.
 */
export function withCode<E extends Error>(error: E, code: string | undefined): E {
  if (code) (error as E & { code?: string }).code = code;
  return error;
}

/**
 * Cette panne-là est-elle « le serveur média ne répond pas » ?
 *
 * Distinguée d'un refus (la clé est mauvaise) et d'une absence (le fichier n'est plus là), parce
 * que ces trois-là appellent trois phrases différentes — et surtout trois conduites différentes :
 * on ne réessaie pas un service absent comme on réessaie une requête malchanceuse.
 */
export function isUpstreamUnreachable(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: string }).code === UPSTREAM_UNREACHABLE;
}

/**
 * La phrase à montrer pour une erreur, quelle que soit l'écran.
 *
 * Quatre endroits affichaient une erreur de chargement — les deux lecteurs, la grille du cinéma et
 * sa jumelle du téléphone — et chacun décidait dans son coin quoi en dire. C'est une décision, pas
 * quatre : un serveur média absent se dit pareil partout, et le jour où la phrase change, elle
 * change une fois.
 *
 * Le repli reste au choix de l'appelant, parce que « impossible de lire ce fichier » et « le
 * catalogue n'a pas pu être chargé » ne sont pas la même phrase quand la cause, elle, est autre.
 */
export function errorMessage(error: unknown, t: (key: string) => string, fallback: string): string {
  if (isUpstreamUnreachable(error)) return t("player.libraryUnreachable");
  return (error instanceof Error && error.message) || fallback;
}
