/**
 * L'entrée hors ligne des téléchargements (bêta, DECISIONS.md §109) : `/hors-ligne`, une page publique
 * que le service worker garde pour chaque build et sert quand le serveur ne répond pas.
 *
 * Elle ne peut pas demander au serveur qui est connecté — c'est justement lui qui manque. Le compte
 * dont elle montre le dossier (`cine-offline/<compte>/`) est donc retenu sur l'appareil, ici, chaque
 * fois que le cinéma charge ses téléchargements, avec leur nombre : c'est ce que lisent la page, le
 * bouton « Accéder aux téléchargements » de l'écran de chargement et la page « Pas de connexion ».
 * Effacé à la déconnexion (`signOut`) : les fichiers restent sur l'appareil, mais la page ne les
 * montre plus à qui l'ouvre ensuite — le compte suivant les retrouvera en se connectant.
 *
 * Rien de confidentiel n'y est gardé : un nom de compte et un nombre. Les téléchargements eux-mêmes
 * sont déjà sur l'appareil.
 */

export const OFFLINE_ENTRY_PATH = "/hors-ligne";

const KEY = "cine-offline-entry";

/** Le message que la page envoie au service worker pour qu'il garde l'entrée de ce build. */
export const WARM_OFFLINE_ENTRY = "cine:warm-offline-entry";

export interface RememberedOfflineAccount {
  account: string;
  /** Les téléchargements de ce compte sur l'appareil, au dernier chargement. */
  downloads: number;
}

function parse(raw: string | null): RememberedOfflineAccount | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RememberedOfflineAccount>;
    if (typeof value.account !== "string" || !value.account) return null;
    return { account: value.account, downloads: typeof value.downloads === "number" ? value.downloads : 0 };
  } catch {
    return null;
  }
}

/** Le texte brut tel que rangé — stable entre deux lectures, ce que `useSyncExternalStore` exige. */
export function rememberedOfflineRaw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function rememberedOfflineAccount(): RememberedOfflineAccount | null {
  return parse(rememberedOfflineRaw());
}

/** Écrit seulement si quelque chose change : appelé à chaque mouvement de la liste. */
export function rememberOfflineAccount(account: string, downloads: number): void {
  const next = JSON.stringify({ account, downloads } satisfies RememberedOfflineAccount);
  try {
    if (localStorage.getItem(KEY) !== next) localStorage.setItem(KEY, next);
  } catch {
    /* stockage refusé (navigation privée) : l'entrée hors ligne ne saura pas quel compte montrer */
  }
}

export function forgetOfflineAccount(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* rien à faire */
  }
}

/**
 * Combien de livres l'appareil garde (option « Livres », DECISIONS.md §127) — écrit par `offlineBooks.ts`
 * à chaque relecture de son dossier, lu ici sans rien charger des livres. Les livres sont des
 * téléchargements comme les films : la page des téléchargements les montre dans leur section.
 */
export const OFFLINE_BOOKS_COUNT_KEY = "laterna:books:offline-count";

/**
 * Les livres étaient-ils affichés pour ce compte au dernier passage en ligne (« 1 » / « 0 ») ? Sans réseau la
 * configuration ne répond pas : c'est ce que la page des téléchargements suit pour montrer leur section.
 */
export const OFFLINE_BOOKS_SHOWN_KEY = "laterna:books:shown";

/** Le message qui demande au service worker de garder la page hors ligne des livres (`/livres/hors-ligne`). */
export const WARM_OFFLINE_BOOKS_ENTRY = "cine:warm-offline-books";

/** La place que prennent les livres gardés (octets) : la page des téléchargements l'ajoute à celle des films. */
export const OFFLINE_BOOKS_BYTES_KEY = "laterna:books:offline-bytes";

/**
 * Lue sans rien charger des livres. La page des téléchargements disait « 0 Mo » sur un appareil qui ne
 * gardait que des livres (29/10/2026).
 */
export function keptBooksBytes(): number {
  try {
    const n = Number(localStorage.getItem(OFFLINE_BOOKS_BYTES_KEY) ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function keptBooksCount(): number {
  try {
    const n = Number(localStorage.getItem(OFFLINE_BOOKS_COUNT_KEY) ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * L'appareil garde-t-il quelque chose à ouvrir sans réseau — un film, un épisode **ou un livre** ? C'est
 * la question que posent l'écran de chargement (« Accéder aux téléchargements ») et la garde de l'entrée
 * hors ligne. Elle ne lisait que les films : un appareil qui ne gardait qu'un livre n'avait, lancé sans
 * réseau, ni l'entrée gardée ni le bouton qui y mène (iPhone, 29/10/2026).
 */
export function deviceKeepsDownloads(): boolean {
  return (rememberedOfflineAccount()?.downloads ?? 0) > 0 || keptBooksCount() > 0;
}

function postToWorker(type: string): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready.then((registration) => registration.active?.postMessage({ type })).catch(() => {});
}

/**
 * Demande au service worker de garder `/hors-ligne` et tout son code pour ce build — une fois par
 * build, il ne refait rien si c'est déjà fait. Seulement quand il y a des téléchargements (films ou
 * livres, `deviceKeepsDownloads`) : sans eux la page n'a rien à montrer, et ce code (quelques Mo) n'a
 * pas à être gardé sur tous les appareils.
 */
export function warmOfflineEntry(): void {
  postToWorker(WARM_OFFLINE_ENTRY);
}

/**
 * Les deux entrées d'un appareil qui garde des livres : `/hors-ligne` — celle que la page « Pas de
 * connexion » et l'écran de chargement ouvrent, où les livres ont leur section — et `/livres/hors-ligne`,
 * la seule qui les lise sans réseau (sous la politique de sécurité des livres).
 */
export function warmBooksOfflineEntries(): void {
  postToWorker(WARM_OFFLINE_ENTRY);
  postToWorker(WARM_OFFLINE_BOOKS_ENTRY);
}
