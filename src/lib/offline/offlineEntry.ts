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
 * Demande au service worker de garder `/hors-ligne` et tout son code pour ce build — une fois par
 * build, il ne refait rien si c'est déjà fait. Seulement quand il y a des téléchargements : sans eux
 * la page n'a rien à montrer, et ce code (quelques Mo) n'a pas à être gardé sur tous les appareils.
 */
export function warmOfflineEntry(): void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.ready
    .then((registration) => registration.active?.postMessage({ type: WARM_OFFLINE_ENTRY }))
    .catch(() => {});
}
