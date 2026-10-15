/**
 * Un titre que Sonarr laisse en attente (« TBA », « TBD ») n'en est pas un.
 *
 * À part, sans dépendance, pour servir des deux côtés : le serveur l'écarte du texte d'un épisode
 * (`episodeFallback.ts`), et la liste des épisodes à venir ne l'affiche plus comme un titre — huit
 * lignes « S3 · É1 — TBA » sous « 8 épisodes à venir », en anglais, à un public francophone (passe
 * de nuit du 15/10/2026, MOBILE-8). La date de diffusion dit alors seule ce qu'on veut savoir.
 */
export const isSonarrPending = (title: string | null | undefined): boolean => /^(tba|tbd)$/i.test((title ?? "").trim());
