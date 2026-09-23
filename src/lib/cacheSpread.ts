/**
 * La durée de vie d'une entrée, raccourcie d'une part propre à sa clé — jusqu'à 15 %.
 *
 * Tout ce qu'on remplit le même jour expirait le même jour : le catalogue entier se renouvelait
 * d'un coup, un millier d'appels à TMDB pendant qu'un spectateur attendait sa page. Chaque clé
 * expire maintenant à son heure, étalée sur le dernier septième de sa vie (un jour sur une
 * semaine). Tirée de la clé et non du hasard : la même entrée garde la même échéance d'un
 * redémarrage à l'autre, et un test peut la prévoir.
 */
export function spreadTtl(key: string, ttlMs: number): number {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return Math.round(ttlMs * (0.85 + 0.15 * ((hash % 1000) / 1000)));
}
