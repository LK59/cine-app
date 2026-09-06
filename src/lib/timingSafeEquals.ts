/**
 * Comparer deux secrets sans laisser le temps de réponse en dire quelque chose.
 *
 * Un `===` sur des chaînes s'arrête au premier caractère qui diffère : le temps de comparaison
 * révèle donc combien de caractères de tête sont justes. C'est une attaque théorique sur une
 * connexion HTTP, où la gigue du réseau noie largement quelques nanosecondes — mais elle n'a
 * aucune raison d'exister quand l'écarter tient en dix lignes.
 *
 * Les longueurs sont comparées d'abord et l'ensemble des octets ensuite, sans court-circuit. Une
 * longueur différente reste observable, ce qui est sans conséquence : la longueur d'un mot de
 * passe n'est pas le mot de passe.
 */
export function timingSafeEquals(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
