/**
 * Ce que le lecteur de livres demande d'avance (DECISIONS.md §127) : le fichier du livre, dès que sa
 * fiche est ouverte — avant même « Lire » —, et pendant que la page des livres démarre.
 *
 * Mesuré le 28/10/2026 (iPhone émulé, cache chaud) : « Lire » → première page prenait ~1,9 s, dont près
 * d'une seconde avant que le fichier ne soit seulement demandé — le code de la page, puis celui du
 * lecteur, puis le compte, puis le fichier, l'un après l'autre. Demandé ici une fois par livre, gardé
 * le temps d'une page (trois livres au plus) ; la réponse est aussi gardée une heure par le navigateur
 * (`Cache-Control` de la route), si bien que la fiche du cinéma, qui change ensuite de page, a déjà
 * fait le travail pour la page des livres. Rien sur une connexion qui demande l'économie de données.
 */

const MAX_HELD = 3;
const held = new Map<string, Promise<Blob | null>>();

export function saveData(): boolean {
  try {
    return (navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData === true;
  } catch {
    return false;
  }
}

/** Le fichier de ce livre, demandé une seule fois ; `null` s'il n'a pas pu l'être (on redemandera). */
export function preloadBookFile(id: string): Promise<Blob | null> {
  const known = held.get(id);
  if (known) return known;
  const job = fetch(`/api/books/${id}/file`)
    .then((res) => (res.ok ? res.blob() : null))
    .catch(() => null)
    .then((blob) => {
      if (!blob) held.delete(id);
      return blob;
    });
  held.set(id, job);
  if (held.size > MAX_HELD) held.delete(held.keys().next().value as string);
  return job;
}

export const __testing = { reset: () => held.clear(), held };
