import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Un appui sur Lire qui attend, le temps que la cible soit confirmée (08/10/2026).
 *
 * La fiche d'une série jamais commencée montre « Lire S1·É1 » dès l'ouverture, d'après le catalogue
 * (`sheetPlayFacts`). Ce n'est qu'une supposition : le serveur peut répondre un autre épisode pour ce
 * compte. Le bouton s'affiche d'emblée, mais un appui qui précède la réponse est retenu, puis lancé
 * à son arrivée — avec ce que la réponse a dit, jamais la supposition. Une règle pour le bouton des
 * fiches du bureau (`PlayButton`) et celui du téléphone.
 *
 * `fire` est relu au moment de partir : c'est la cible de la réponse qu'on veut, pas celle du rendu
 * qui a reçu l'appui.
 */
export function useQueuedPlay(waiting: boolean, fire: () => void): () => void {
  const queued = useRef(false);
  const latest = useRef(fire);
  useLayoutEffect(() => {
    latest.current = fire;
  });
  useEffect(() => {
    if (waiting || !queued.current) return;
    queued.current = false;
    latest.current();
  }, [waiting]);
  return useCallback(() => {
    if (waiting) {
      queued.current = true;
      return;
    }
    latest.current();
  }, [waiting]);
}
