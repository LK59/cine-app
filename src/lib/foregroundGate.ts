/**
 * Au retour au premier plan, la version d'abord — les relectures ensuite (06/11/2026, DECISIONS.md §134).
 *
 * Relevé au journal du relais le 06/11/2026 à 07:20 : après un déploiement, un iPhone revenu au premier
 * plan lançait tout à la fois — `/api/version` (`BuildRefresh`), les relectures au focus de SWR
 * (« Reprendre », « À suivre »), les deux catalogues (`useCatalogueRefresh`), Ma liste, la présence… —,
 * puis la réponse de version rechargeait la page, et la page neuve redemandait tout : 141 requêtes en
 * 8 s, le catalogue téléchargé deux fois, des rangées qui bougeaient peut-être sur l'ancienne page juste
 * avant qu'elle disparaisse. Sans nouveau build, le retour était propre (6 à 14 petites requêtes).
 *
 * D'où cette porte : au passage à « visible », la question de version part seule ; ce que le retour
 * déclenche attend sa réponse.
 * - même build, ou pas de réponse (hors ligne, serveur qui redémarre) en `ANSWER_TIMEOUT_MS` : la porte
 *   s'ouvre, tout part comme avant, un dixième de seconde plus tard ;
 * - nouveau build et `BuildRefresh` recharge maintenant : la porte reste fermée, la page s'en va ;
 * - nouveau build mais pas le moment (film ouvert, texte en cours…) : la porte s'ouvre.
 *
 * La porte n'est armée que si un rechargement était seulement possible au retour (`mayHold`, fourni
 * par `BuildRefresh` — le même `mayReloadNow`) : un film ouvert, même réduit, n'attend jamais rien. Sans
 * `BuildRefresh` monté (le cadre du lecteur de livres), elle ne s'arme pas du tout.
 *
 * **L'ordre.** La porte s'arme dans un écouteur de `visibilitychange` posé *en capture sur `window`*.
 * L'événement est envoyé au `document` et remonte ; la phase de capture passe par `window` avant
 * d'atteindre le `document` : cet écouteur court donc avant tout écouteur du `document` — celui de SWR,
 * ceux des crochets, celui de `BuildRefresh` —, quel que soit l'ordre dans lequel ils ont été inscrits.
 */

export type ForegroundOutcome = "go" | "reloading";

/** Au-delà, la question de version est tenue pour sans réponse : tout part comme avant. */
export const ANSWER_TIMEOUT_MS = 1500;
/**
 * Un rechargement annoncé qui n'a pas emporté la page en ce temps-là a échoué (navigation refusée,
 * réseau perdu entre-temps) : la porte s'ouvre plutôt que de laisser la page sans relectures. Large, parce
 * que l'ancienne page reste en place jusqu'à la réponse de la nouvelle, et le lien est lent en itinérance.
 */
export const RELOAD_GRACE_MS = 15_000;

interface PendingReturn {
  id: number;
  /** Ce qui attend la réponse — relancé à l'ouverture, oublié si la page repart en arrière-plan. */
  queue: (() => void)[];
  timer: ReturnType<typeof setTimeout>;
}

let mayHold: (() => boolean) | null = null;
let pending: PendingReturn | null = null;
let seq = 0;
const releaseListeners = new Set<() => void>();

function clearPending(): PendingReturn | null {
  const current = pending;
  if (current) clearTimeout(current.timer);
  pending = null;
  return current;
}

function release(current: PendingReturn): void {
  if (pending !== current) return;
  clearPending();
  for (const listener of releaseListeners) {
    try {
      listener();
    } catch {
      // Une relecture qui échoue n'empêche pas les autres de partir.
    }
  }
  for (const fn of current.queue) {
    try {
      fn();
    } catch {
      /* voir ci-dessus */
    }
  }
}

function arm(): void {
  clearPending();
  let hold = false;
  try {
    hold = mayHold?.() ?? false;
  } catch {
    hold = false;
  }
  if (!hold) return;
  const current: PendingReturn = { id: ++seq, queue: [], timer: setTimeout(() => release(current), ANSWER_TIMEOUT_MS) };
  pending = current;
}

function onVisibilityCapture(): void {
  // Repartie en arrière-plan avant la réponse : ce qui attendait est oublié — le prochain retour
  // relancera ses propres écouteurs, et rien ne doit partir page cachée.
  if (document.visibilityState === "hidden") clearPending();
  else arm();
}

/**
 * Branche la porte (par `BuildRefresh`, à son montage). `hold` dit si un rechargement est seulement
 * envisageable au moment du retour ; s'il dit non, rien n'attend.
 */
export function enableForegroundGate(hold: () => boolean): () => void {
  if (typeof window === "undefined") return () => {};
  mayHold = hold;
  window.addEventListener("visibilitychange", onVisibilityCapture, true);
  return () => {
    if (mayHold === hold) mayHold = null;
    window.removeEventListener("visibilitychange", onVisibilityCapture, true);
    const current = clearPending();
    // Démontée en plein retour : ce qui attendait part, comme sans la porte.
    if (current) for (const fn of current.queue) fn();
  };
}

/** Un retour attend sa réponse de version (ou un rechargement est en cours) : rien ne doit partir. */
export function foregroundHeld(): boolean {
  return pending !== null;
}

/** Le retour en cours, à rendre à `settleForegroundReturn` avec sa réponse ; `null` si rien n'attend. */
export function currentForegroundReturn(): number | null {
  return pending?.id ?? null;
}

/** La réponse de `BuildRefresh` pour ce retour-là. Une réponse d'un retour déjà passé ne change rien. */
export function settleForegroundReturn(id: number | null, outcome: ForegroundOutcome): void {
  const current = pending;
  if (id === null || !current || current.id !== id) return;
  if (outcome === "go") {
    release(current);
    return;
  }
  clearTimeout(current.timer);
  current.timer = setTimeout(() => release(current), RELOAD_GRACE_MS);
}

/**
 * Lancer une relecture déclenchée par le retour au premier plan : tout de suite si rien n'attend (le
 * comportement d'avant, à l'identique), sinon à l'ouverture de la porte — jamais si la page se recharge.
 */
export function afterForegroundCheck(fn: () => void): void {
  if (pending) pending.queue.push(fn);
  else fn();
}

/** Prévenu à chaque ouverture de la porte — pour rejouer les relectures au focus de SWR, qu'elle a retenues. */
export function onForegroundRelease(listener: () => void): () => void {
  releaseListeners.add(listener);
  return () => void releaseListeners.delete(listener);
}
