"use client";

/**
 * Les dernières recherches, gardées sur l'appareil.
 *
 * Un écran de recherche vide est un écran gaspillé, au moment précis où quelqu'un cherche sans
 * savoir quoi. Ses propres recherches sont ce qu'il y a de plus utile à lui proposer : on cherche
 * souvent deux fois la même chose, à quelques jours d'écart.
 *
 * Sur l'appareil et pas sur le serveur : c'est une commodité, pas une donnée. La perdre en
 * changeant de navigateur ne coûte rien, et l'envoyer au serveur reviendrait à tenir un journal
 * de ce que les gens tapent, ce que personne n'a demandé.
 */
const KEY = "cine.player.recentSearches";
const MAX = 6;

/**
 * L'instantané est mis en cache contre le texte brut dont il vient.
 *
 * `useSyncExternalStore` exige une identité stable tant que rien n'a changé : rendre un nouveau
 * tableau à chaque lecture le ferait boucler sans fin. Le cache est comparé au contenu du
 * stockage, donc il se renouvelle exactement quand la liste change et pas avant.
 */
let cachedRaw: string | null = null;
let cachedList: string[] = [];

export function recentSearches(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY) ?? "";
    if (raw === cachedRaw) return cachedList;
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cachedRaw = raw;
    cachedList = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string").slice(0, MAX) : [];
    return cachedList;
  } catch {
    cachedRaw = null;
    cachedList = [];
    return cachedList;
  }
}

/**
 * Retenir une recherche.
 *
 * La casse est ignorée pour le dédoublonnage mais conservée à l'affichage : quelqu'un qui a tapé
 * « Nolan » doit relire « Nolan », et ne pas voir deux lignes parce qu'il avait tapé « nolan » la
 * fois d'avant.
 */
export function rememberSearch(query: string): void {
  const clean = query.trim();
  if (clean.length < 2) return;
  try {
    const kept = recentSearches().filter((q) => q.toLowerCase() !== clean.toLowerCase());
    window.localStorage.setItem(KEY, JSON.stringify([clean, ...kept].slice(0, MAX)));
  } catch {
    // Stockage indisponible : on ne retient rien, et l'écran se contente du reste.
  }
}

export function forgetSearches(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Voir ci-dessus.
  }
}
