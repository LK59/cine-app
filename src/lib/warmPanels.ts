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
 * Pas en économie de données, ni pendant un film (le réseau est à lui), ni l'activité des comptes,
 * réservée à l'administrateur : personne d'autre ne paie son code. Un échec ne coûte rien — le
 * morceau sera demandé à l'ouverture, comme avant.
 */
export type PanelLoader = () => Promise<unknown>;

/** Le même chemin que les `dynamic(() => import(…))` de `PlayerShell` — un test vérifie qu'aucun ne manque. */
export const PANEL_LOADERS: PanelLoader[] = [
  () => import("@/components/player/PlayerSearchPanel"),
  () => import("@/components/player/PlayerListPanel"),
  () => import("@/components/player/PlayerAccountPanel"),
  () => import("@/components/player/PlayerReportPanel"),
  () => import("@/components/player/PlayerNewsPanel"),
  () => import("@/components/player/PlayerDiscoverSheet"),
  () => import("@/components/player/PlayerPersonSheet"),
  // Pas l'accueil « Bienvenue » (`PlayerOnboarding`) : il importe le préchauffage des décodeurs, et
  // un `import()` écrit ici est aussi compilé pour le rendu serveur — le décodeur FLAC y casse la
  // construction (« Module not found », @eshaz/web-worker). C'est ce que `ssr: false` de
  // `next/dynamic` évite dans PlayerShell (voir decoderWarmup.ts). Il ne sert qu'au premier
  // lancement, en ligne par définition.
  () => import("@/components/player/NewsGate"),
  () => import("@/components/player/PushResumePrompt"),
  () => import("@/components/TrailerModal"),
];

/** Après le premier écran, ses affiches et le préchauffage des décodeurs. */
export const WARM_PANELS_DELAY_MS = 10_000;

export function scheduleWarmPanels(options: { loaders?: PanelLoader[]; delayMs?: number; busy?: () => boolean } = {}): () => void {
  if (typeof window === "undefined") return () => {};
  const { loaders = PANEL_LOADERS, delayMs = WARM_PANELS_DELAY_MS, busy = () => false } = options;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return () => {};
  let cancelled = false;
  const run = async () => {
    for (const load of loaders) {
      if (cancelled || busy()) return;
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
