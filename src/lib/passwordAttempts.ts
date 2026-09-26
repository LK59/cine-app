/**
 * Les formes d'un mot de passe à essayer, et dans quel ordre.
 *
 * Un mot de passe collé arrive régulièrement lesté d'une espace finale — le gestionnaire qui la
 * copie avec, la sélection qui déborde d'un caractère. Il a l'air juste, il ne marche pas, et
 * l'écran ne répond que « identifiants invalides ». Louis a réinitialisé le sien plusieurs fois
 * avant de soupçonner ça.
 *
 * **La forme donnée passe toujours en premier.** C'est ce qui distingue ceci d'un rognage : le mot
 * de passe ne vit pas ici, il vit dans Jellyfin. Le rogner d'autorité ferait qu'un compte dont le
 * mot de passe finit vraiment par une espace — improbable, pas impossible — s'ouvrirait chez
 * Jellyfin et se fermerait ici. Deux systèmes en désaccord sur ce qu'est un mot de passe, c'est
 * une panne pire que celle qu'on répare, et sans aucun moyen de la diagnostiquer.
 *
 * La seconde forme n'est donc essayée qu'après un échec, et seulement si elle diffère : dans le
 * cas courant il n'y a qu'une tentative, exactement comme avant.
 *
 * Seulement la fin, pas le début. C'est ce qui a été demandé, et c'est aussi le plus sûr : une
 * espace de tête se voit à la saisie dès que le champ est révélé, et l'écran la nomme désormais.
 */
export function passwordAttempts(password: string): string[] {
  // `trimEnd` et non `replace(/\s+$/, "")` : même jeu de blancs, mais la regex est quadratique —
  // le moteur retente `\s+` depuis chaque espace d'une longue suite qui ne finit pas la chaîne.
  // 40 000 espaces suivies d'un « x » tenaient la boucle 1,5 s, 1 Mo environ un quart d'heure,
  // et ceci tourne sur la route de connexion, publique par définition (26/09/2026).
  const trimmed = password.trimEnd();
  return trimmed === password ? [password] : [password, trimmed];
}

/** Le mot de passe commence-t-il par une espace ? Sert à nommer l'échec, jamais à décider. */
export function hasLeadingSpace(password: string): boolean {
  return /^\s/.test(password);
}

/**
 * Bornes des identifiants reçus par les routes de connexion. Généreuses pour un humain comme pour
 * un gestionnaire de mots de passe (qui propose rarement plus de 128 caractères), et assez basses
 * pour qu'aucun travail — comparaison, appel à Jellyfin, ligne d'`auth.log` — ne dépende de ce
 * qu'un inconnu choisit d'envoyer.
 */
export const MAX_USERNAME_LENGTH = 256;
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * Lit identifiant et mot de passe d'un corps de requête, ou `null` s'ils manquent, ne sont pas
 * des chaînes ou dépassent les bornes. Partagé par les deux routes de connexion (Jellyfin et
 * compte local), qui refusaient chacune à leur façon : un `password` numérique passait le test
 * `!password` puis faisait lever `.replace` — un 500 au lieu d'un 400.
 */
export function readCredentials(body: unknown): { username: string; password: string } | null {
  if (!body || typeof body !== "object") return null;
  const { username, password } = body as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") return null;
  if (!username || !password) return null;
  if (username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH) return null;
  return { username, password };
}
