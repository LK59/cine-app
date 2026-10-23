// « A renoncé » : combien de temps le spectateur a attendu avant de fermer une séance qui n'a jamais
// joué — `gaveUpAfterMs` au bilan `stop`, pour les deux lecteurs.
//
// Le natif le lisait sur le `ready` du pipeline courant, que chaque reconstruction remet à faux : une
// séance fermée pendant une reconstruction « avait renoncé depuis le montage » après avoir joué une
// heure. Le serveur le lisait déjà sur l'image jouée dans la séance. Une seule règle depuis le
// 23/10/2026 (audit F1-4, DECISIONS.md §116) : rien dès qu'une image a été jouée dans la séance.
export function gaveUpFields(played: boolean, now: number, since: number): { gaveUpAfterMs?: number } {
  return played ? {} : { gaveUpAfterMs: now - since };
}
