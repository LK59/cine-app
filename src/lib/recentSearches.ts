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
    const existantes = recentSearches();
    const bas = clean.toLowerCase();

    /**
     * « Hannib », « Hanniba », « Hannibal » sont **une** recherche en train de s'écrire.
     *
     * C'est la vraie cause du problème, et aucun délai ne la règle : quelqu'un qui hésite trois
     * secondes au milieu d'un nom laissait une ligne pour chaque hésitation. Trois lignes pour
     * « Ryan gosling », relevées à l'usage.
     *
     * Deux sens, et il faut les deux. Une entrée retenue qui n'est qu'un début de celle-ci
     * disparaît — c'était la même frappe, en cours. Et si celle-ci n'est que le début d'une entrée
     * déjà retenue, c'est **cette entrée-là** qui remonte en tête : la plus complète des deux
     * gagne toujours, ce qui est aussi la plus utile à relire.
     *
     * Remonter et non ignorer, et c'est tout le correctif. Ne rien faire du tout se voyait comme
     * une panne : quelqu'un qui cherche « Hann » alors que « Hannibal » est déjà retenu voyait sa
     * liste ne pas bouger d'un pouce, quoi qu'il tape et quoi qu'il ouvre — « l'historique ne
     * marche plus du tout ». Une recherche refaite est une recherche récente.
     */
    const plusComplete = existantes.find((q) => q.toLowerCase().startsWith(bas) && q.toLowerCase() !== bas);
    const tete = plusComplete ?? clean;
    const kept = existantes.filter((q) => q !== tete && !bas.startsWith(q.toLowerCase()));

    window.localStorage.setItem(KEY, JSON.stringify([tete, ...kept].slice(0, MAX)));
  } catch {
    // Stockage indisponible : on ne retient rien, et l'écran se contente du reste.
  }
}

/**
 * Retenir un titre qu'on vient d'ouvrir — tel quel, sans fusion par le début.
 *
 * La fusion par le début est faite pour une frappe en cours (« Hannib », « Hannibal ») : appliquée
 * à des titres, elle en effaçait de vrais — ouvrir « Alien: Romulus » supprimait « Alien », et
 * ouvrir « Dune » faisait seulement remonter « Dune: Part Two » (relevé le 23/09/2026). Seuls
 * disparaissent le même titre écrit autrement, et ce qui était tapé pour le trouver : c'est ce
 * fragment que le titre remplace.
 */
export function rememberTitle(title: string, typed?: string): void {
  const clean = title.trim();
  if (clean.length < 2) return;
  try {
    const bas = clean.toLowerCase();
    const tape = typed?.trim().toLowerCase();
    const kept = recentSearches().filter((q) => {
      const l = q.toLowerCase();
      return l !== bas && l !== tape;
    });
    window.localStorage.setItem(KEY, JSON.stringify([clean, ...kept].slice(0, MAX)));
  } catch {
    // Stockage indisponible : on ne retient rien.
  }
}

export function forgetSearches(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Voir ci-dessus.
  }
}
