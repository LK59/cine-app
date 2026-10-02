/**
 * Les lignes du journal du lecteur déjà écrites, par leur identifiant — de quoi ne pas écrire deux
 * fois un renvoi.
 *
 * Le navigateur garde une ligne qu'il n'a pas pu envoyer et la renvoie plus tard (`unsentLines.ts`,
 * 01/10/2026). Il ne le fait que sans réponse de l'application ; mais une réponse peut se perdre
 * *après* l'écriture — la page qui s'en va, le réseau qui tombe au retour —, et la ligne repartirait.
 * La route note chaque identifiant écrit, et un renvoi déjà vu est accepté sans être réécrit.
 *
 * En mémoire, et borné : un renvoi arrive au plus tard au lancement suivant, et un compte n'envoie
 * pas plus de 120 lignes par minute. Un redémarrage du serveur l'oublie — seul le renvoi d'une ligne
 * écrite dans les millisecondes qui précèdent l'arrêt peut alors s'écrire deux fois.
 */

const MAX_IDS = 20_000;
const seen = new Set<string>();

/** Un identifiant tel que le navigateur le tire : rien d'autre n'est retenu. */
export function isLineId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9]{8,32}$/i.test(value);
}

/**
 * Note la ligne et dit si elle l'était déjà. Par compte : un identifiant tiré par un autre ne peut
 * pas faire taire les lignes de celui-ci.
 */
export function alreadyWritten(user: string, id: string): boolean {
  const key = `${user}\u0000${id}`;
  if (seen.has(key)) return true;
  seen.add(key);
  // Un `Set` garde l'ordre d'insertion : le plus ancien part le premier.
  if (seen.size > MAX_IDS) seen.delete(seen.values().next().value as string);
  return false;
}

/** Pour les tests. */
export function forgetLineIds(): void {
  seen.clear();
}
