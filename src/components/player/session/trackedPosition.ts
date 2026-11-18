/**
 * La position que l'hôte natif retient d'un `timeupdate` — un zéro qui ne vient de rien n'en est pas une.
 *
 * L'élément peut annoncer `currentTime = 0` sans que personne ne l'ait demandé : WebKit, quand son
 * décodeur lâche, remet l'horloge à zéro et peut envoyer `playing` / `timeupdate` à 0 juste avant
 * l'erreur ; et une source neuve part de zéro avant que la tête ne soit posée sur la position voulue.
 * Retenu tel quel, ce zéro devenait la position de la reconstruction qui suivait la perte : un iPad à
 * 3 588 s d'*Aftersun* est reparti du début du film (chasse du 18/11/2026, WebKit émulé ; l'erreur
 * elle-même y arrive déjà avec `currentTime` à 0). Un vrai retour au début passe par un saut — l'élément
 * dit `seeking` à son premier `timeupdate` — et une ouverture du début part d'une position connue à 0 :
 * ni l'un ni l'autre n'est écarté.
 */
export function trackedPosition(previous: number, element: { currentTime: number; seeking: boolean }): number {
  if (element.currentTime === 0 && previous > 1 && !element.seeking) return previous;
  return element.currentTime;
}
