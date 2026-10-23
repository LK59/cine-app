/**
 * iPhone, iPod ou iPad — l'iPad qui se dit Mac compris (Safari pour iPadOS demande le site de bureau
 * par défaut : seul `ontouchend` le trahit). Une seule détection pour l'installation, le passage
 * d'adresse et les notifications.
 */
export function isAppleTouchDevice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && typeof document !== "undefined" && "ontouchend" in document);
}

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
  return isAppleTouchDevice() && !isInstalledApp();
}

/**
 * Cet onglet a été ouvert par un **lien** de passage d'adresse (`/passage#t=…`, DECISIONS.md §119) —
 * dans `sessionStorage` : l'onglet, pas l'appareil. Posé par `PassageEntry` dès qu'il lit le jeton.
 */
export const PASSAGE_LINK_TAB_KEY = "cine:passage-link-tab";

export function noteOpenedByPassageLink(): void {
  try {
    window.sessionStorage.setItem(PASSAGE_LINK_TAB_KEY, "1");
  } catch {
    /* stockage refusé : l'onglet se lira comme avant */
  }
}

function openedByPassageLink(): boolean {
  try {
    return window.sessionStorage.getItem(PASSAGE_LINK_TAB_KEY) !== null;
  } catch {
    return false;
  }
}

/**
 * L'application installée (écran d'accueil, application Android, application de bureau), et non un
 * onglet : `display-mode: standalone`, ou `navigator.standalone` sur les iOS qui ne disent rien au
 * premier. Le navigateur tient ses abonnements aux notifications par contexte — régler les
 * notifications dans un onglet de Safari n'abonne pas l'application installée ensuite.
 *
 * **Sauf, sur iPhone et iPad, une page ouverte par un lien de passage** (23/10/2026, iPhone du
 * propriétaire en 10.0.0). « Passer » ouvre la nouvelle adresse depuis l'ancienne application
 * installée, et iOS la montre dans la vue intégrée de *cette* application — qui s'est dite encore
 * « standalone », avec `PushManager` : seule lecture qui explique ce qu'il a vu (pas d'aide à
 * l'installation, et l'invitation « application installée sans abonnement » proposant aussitôt les
 * notifications — pour un contexte qu'on va quitter), reproduite telle quelle sous WebKit. Sur iOS, un lien n'ouvre jamais
 * une application de l'écran d'accueil : un onglet arrivé par le lien n'est pas celle-ci. Sur Android,
 * où un lien peut ouvrir l'application installée, `display-mode` dit vrai et rien ne change.
 */
export function isInstalledApp(): boolean {
  if (typeof window === "undefined") return false;
  const standalone =
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
    (typeof window.matchMedia === "function" && window.matchMedia("(display-mode: standalone)").matches);
  if (!standalone) return false;
  return !(isAppleTouchDevice() && openedByPassageLink());
}

/**
 * Peut-on, ici, **proposer** d'activer les notifications — bannière, étape d'accueil, bouton qui
 * demanderait la permission (DECISIONS.md §17) ? La seule réponse, lue par toutes les invitations.
 *
 * Sur iPhone et iPad, jamais hors de l'application installée : iOS ne donne les notifications web
 * qu'à l'application de l'écran d'accueil, et un abonnement pris dans un onglet (ou dans la vue
 * intégrée d'une autre application) n'appartient qu'à lui. Là, on renvoie à l'installation. Ailleurs
 * (Android, ordinateur), la seule condition est que le navigateur sache s'abonner (service worker,
 * `PushManager`) — comme avant.
 */
export function canOfferPush(): boolean {
  if (typeof window === "undefined") return false;
  if (isIosSafariBrowserTab()) return false;
  return "serviceWorker" in navigator && "PushManager" in window;
}
