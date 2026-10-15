/**
 * Le code des écrans du cinéma chargés à la demande, gardé sur l'appareil dès le premier lancement
 * (15/10/2026, passe de nuit, ROBUSTESSE-4 ; décision de Louis le matin même).
 *
 * Recherche, Ma liste, Compte, Signaler, Nouveautés, les fiches découverte et personne : chacun
 * arrive dans son propre morceau de JavaScript, au premier usage. Hors ligne, un écran jamais ouvert
 * dans ce build n'avait pas son morceau : Next relançait une navigation complète, et le service
 * worker servait `offline.html` *à la place de l'application* — l'accueil, qui marchait, était perdu.
 *
 * Une fois l'accueil installé et au repos, ces morceaux sont donc demandés à blanc, un par un. Ils
 * passent par le service worker, qui range tout `/_next/static/` dans le cache de code du build
 * (`cine-static-<build>`, `public/sw.js`) — sans rien changer au worker ni à `CACHE_NAME` : c'est le
 * mécanisme par génération qui fait le travail, et un morceau inchangé d'un déploiement au suivant y
 * est repris sans être retéléchargé.
 *
 * **Les chargeurs sont ceux de `next/dynamic`, passés par l'appelant, jamais un `import()` écrit
 * ici.** Turbopack découpe un morceau par endroit d'import : un `import()` du même fichier écrit dans
 * ce module produisait un *autre* morceau que celui que l'écran demande à son ouverture — vérifié
 * hors ligne dans Chromium, la Recherche réclamait encore le sien. Et un `import()` hors de
 * `next/dynamic` entre dans le rendu serveur : l'accueil « Bienvenue » y tirait le décodeur FLAC, et
 * la construction échouait.
 *
 * Pas en économie de données, ni l'activité des comptes, réservée à l'administrateur : personne
 * d'autre ne paie son code. Un échec ne coûte rien — le morceau sera demandé à l'ouverture.
 */
export type PanelLoader = () => Promise<unknown>;

/** Après le premier écran, ses affiches et le préchauffage des décodeurs. */
export const WARM_PANELS_DELAY_MS = 10_000;

export function scheduleWarmPanels({ loaders, delayMs = WARM_PANELS_DELAY_MS }: { loaders: PanelLoader[]; delayMs?: number }): () => void {
  if (typeof window === "undefined") return () => {};
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return () => {};
  let cancelled = false;
  const run = async () => {
    for (const load of loaders) {
      if (cancelled) return;
      await load().catch(() => {});
    }
  };
  const timer = window.setTimeout(() => {
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(() => void run(), { timeout: 5_000 });
    else void run();
  }, delayMs);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}
