/**
 * Ouvrir l'application, c'est avoir vu ce qu'annonçaient ses notifications.
 *
 * Le service worker pose la pastille de l'icône à chaque notification (`setAppBadge`, que l'iPhone
 * applique aux applications de l'écran d'accueil depuis iOS 16.4), mais rien ne l'effaçait : la
 * pastille « 1 » restait sur l'icône et la notification dans le centre de notifications, l'app
 * ouverte ou non (relevé le 23/09/2026). Pas de centre de notifications à nous : l'ouverture — et
 * chaque retour au premier plan — vaut lecture. La pastille est effacée et les notifications
 * encore affichées sont retirées.
 *
 * Tout est au mieux et détecté : un navigateur sans l'une de ces API n'a rien à effacer, et ce qui
 * échoue ici ne doit jamais atteindre l'écran.
 */
export async function clearDeliveredNotifications(): Promise<void> {
  try {
    const nav = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
    await nav.clearAppBadge?.().catch(() => {});
  } catch {
    /* rien à effacer */
  }
  try {
    if (!("serviceWorker" in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration();
    const delivered = (await registration?.getNotifications?.()) ?? [];
    for (const notification of delivered) notification.close();
  } catch {
    /* rien à retirer */
  }
}
