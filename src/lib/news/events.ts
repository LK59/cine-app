import { APP_BUILD, APP_VERSION } from "@/lib/appBuild";

/**
 * Les mesures des Nouveautés, côté navigateur (DECISIONS.md §73).
 *
 * - `closedBy` : OK (bouton, Entrée), Échap (ou la touche Retour d'une télécommande), un appui à
 *   côté de la carte, ou « Voir plus ».
 * - `shownMs` : le temps pendant lequel la page était **visible** — un téléphone verrouillé sur la
 *   fenêtre ouverte ne compte pas comme une lecture de dix minutes.
 */
export const NEWS_CLOSED_BY = ["ok", "echap", "dehors", "voir-plus"] as const;
export type NewsClosedBy = (typeof NEWS_CLOSED_BY)[number];

/** Jusqu'où la page Compte → Nouveautés a été lue : le haut, la liste des corrections, l'historique. */
export const NEWS_PAGE_SECTIONS = ["nouveautés", "corrections", "historique"] as const;
export type NewsPageSection = (typeof NEWS_PAGE_SECTIONS)[number];

/** La clé SWR de `/api/release-notes`. */
export const NEWS_KEY = "/api/release-notes";

/**
 * Un chronomètre qui ne compte que le temps où la page est visible.
 *
 * Une classe sans dépendance au navigateur : l'horloge et l'état de départ sont passés, ce qui la
 * rend vérifiable telle quelle. Le composant branche `hide`/`show` sur `visibilitychange`.
 */
export class VisibleStopwatch {
  private total = 0;
  private since: number | null;

  constructor(now: number, visible: boolean) {
    this.since = visible ? now : null;
  }

  hide(now: number): void {
    if (this.since === null) return;
    this.total += Math.max(0, now - this.since);
    this.since = null;
  }

  show(now: number): void {
    if (this.since === null) this.since = now;
  }

  elapsed(now: number): number {
    return Math.round(this.total + (this.since === null ? 0 : Math.max(0, now - this.since)));
  }
}

/**
 * Brancher le chronomètre sur la visibilité de la page — rend la fonction qui le lit et le
 * débranche. `performance.now()` plutôt que `Date.now()` : une horloge système qui saute ne doit
 * pas fabriquer une lecture.
 */
export function watchVisibleTime(): { read: () => number; stop: () => void } {
  const clock = () => performance.now();
  const watch = new VisibleStopwatch(clock(), document.visibilityState !== "hidden");
  const onChange = () => (document.visibilityState === "hidden" ? watch.hide(clock()) : watch.show(clock()));
  document.addEventListener("visibilitychange", onChange);
  return { read: () => watch.elapsed(clock()), stop: () => document.removeEventListener("visibilitychange", onChange) };
}

/**
 * Envoyer sans attendre. `keepalive` : la ligne d'une fermeture part souvent au moment où la page
 * change d'écran, ou se ferme. Aucune file d'attente : `unsentLines` est celle du journal du
 * lecteur (sa route, ses identifiants de ligne) ; une mesure de Nouveautés perdue ne coûte qu'une
 * ligne, et le drapeau, lui, est déjà éteint à l'affichage.
 */
function post(url: string, body: unknown): void {
  try {
    void fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
  } catch {
    /* rien : une mesure ne doit jamais casser l'écran qui l'envoie */
  }
}

export function markNewsSeen(ids: number[]): void {
  post("/api/release-notes/seen", { ids });
}

export function sendNewsEvent(event: "fenêtre" | "voir-plus" | "page", fields: Record<string, unknown>): void {
  post("/api/release-notes/event", { event, build: APP_BUILD, version: APP_VERSION, ...fields });
}
