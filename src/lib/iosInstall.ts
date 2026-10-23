/**
 * Un onglet de Safari (ou d'un autre navigateur) sur iPhone ou iPad, hors de l'application
 * installée sur l'écran d'accueil.
 *
 * iOS n'offre les notifications qu'à l'application installée, et n'a pas d'invitation à installer :
 * il faut le dire. Écrit une fois pour la bannière « Installer » et pour l'interrupteur des
 * notifications du Compte (15/10/2026, passe de nuit, MOBILE-4) — qui disait « non supportées sur
 * ce navigateur » quand l'accueil, lui, renvoyait justement au Compte après l'installation.
 */
export function isIosSafariBrowserTab(): boolean {
  if (typeof window === "undefined") return false;
  const ua = window.navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && "ontouchend" in document);
  if (!isIos) return false;
  return !isInstalledApp();
}

/**
 * L'application installée (écran d'accueil, application Android, application de bureau), et non un
 * onglet : `display-mode: standalone`, ou `navigator.standalone` sur les iOS qui ne disent rien au
 * premier. Le navigateur tient ses abonnements aux notifications par contexte — régler les
 * notifications dans un onglet de Safari n'abonne pas l'application installée ensuite.
 */
export function isInstalledApp(): boolean {
  if (typeof window === "undefined") return false;
  return (
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches)
  );
}
