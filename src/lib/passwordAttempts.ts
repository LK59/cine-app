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
  const trimmed = password.replace(/\s+$/, "");
  return trimmed === password ? [password] : [password, trimmed];
}

/** Le mot de passe commence-t-il par une espace ? Sert à nommer l'échec, jamais à décider. */
export function hasLeadingSpace(password: string): boolean {
  return /^\s/.test(password);
}
