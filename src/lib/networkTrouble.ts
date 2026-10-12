// « Connexion perdue ou instable… » : le lecteur natif est en train de réessayer (DECISIONS.md §78).
//
// Une plage refusée par le réseau est redemandée quatre fois par `HttpByteSource.fetchWithRetries`
// (délais de 200, 600 puis 1 500 ms, l'attente du retour du réseau quand le navigateur se dit hors
// ligne, et l'échéance de 25 s par requête) avant que l'écran « connexion perdue » ne prenne la
// main. Pendant ces tentatives, rien ne le disait : l'image figée ou la ligne de chargement
// ressemblaient à une lenteur — et une lenteur appelle la « version allégée », qu'une coupure nette
// ne doit jamais proposer (Louis, 12/10/2026). Ce module le dit à l'hôte : une tentative a échoué
// et une autre suit ; ou une requête vient d'aboutir, et le lien est vivant.
//
// Global, comme `playbackDiagnosis` : un lecteur natif à la fois. Une notification seulement — rien
// ici ne touche à la réception des octets, et rien ne lève.

type Listener = (unstable: boolean) => void;

/** Le nombre de morceaux qui réessaient en ce moment. */
let retrying = 0;
const listeners = new Set<Listener>();

function emit(): void {
  const value = networkUnstable();
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {
      /* un écouteur n'est pas une lecture */
    }
  }
}

/** Un morceau vient d'échouer une tentative et va réessayer (une fois par morceau). */
export function noteFetchRetrying(): void {
  retrying += 1;
  if (retrying === 1) emit();
}

/**
 * Ce morceau a fini de réessayer — arrivé, abandonné, ou épuisé (l'écran « connexion perdue » prend
 * alors la suite). Appelé dans un `finally` : un morceau ne peut pas laisser le message derrière lui.
 */
export function noteFetchSettled(): void {
  if (retrying === 0) return;
  retrying -= 1;
  if (retrying === 0) emit();
}

/** Des tentatives sont en cours, ou le navigateur se dit hors ligne. */
export function networkUnstable(): boolean {
  try {
    return retrying > 0 || (typeof navigator !== "undefined" && navigator.onLine === false);
  } catch {
    return retrying > 0;
  }
}

/** Écoute les changements (et ceux de `online`/`offline`). Rend la fonction qui arrête d'écouter. */
export function subscribeNetworkTrouble(listener: Listener): () => void {
  listeners.add(listener);
  const onLine = () => emit();
  if (typeof window !== "undefined") {
    window.addEventListener("online", onLine);
    window.addEventListener("offline", onLine);
  }
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") {
      window.removeEventListener("online", onLine);
      window.removeEventListener("offline", onLine);
    }
  };
}

/** Pour les tests. */
export function resetNetworkTrouble(): void {
  retrying = 0;
}
