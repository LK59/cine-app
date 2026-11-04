import { APP_BUILD, APP_VERSION } from "@/lib/appBuild";
import { isAppleTouchDevice } from "@/lib/iosInstall";

/**
 * L'écran rétréci de l'application installée sur iPhone et iPad (04/11/2026).
 *
 * Le clavier ouvert dans une autre app, puis retour dans Laterna par un glissé de la barre d'accueil :
 * la page restait coupée aux deux tiers, la barre flottante au milieu de l'écran, du noir dessous —
 * à coup sûr. Elle ne se remettait qu'en ouvrant puis fermant le clavier chez nous (la recherche).
 * Défaut de WebKit en mode installé, signalé sur iOS 26 (WebKit 301857).
 *
 * **Mesuré le 05/11/2026** (`kind: "hauteur"` dans `startup.log`, iPhone 430 × 932) : au retour,
 * `innerHeight`, la vue visuelle, la racine et la coquille valent toutes 585 — la *fenêtre* elle-même
 * a la hauteur avec clavier ; `outerHeight` dit 932. Ce n'est donc pas notre mise en page : la
 * première réparation (10.13.10), retirer un instant la coquille du rendu, ne changeait rien — après
 * elle, toujours 585. Seule une vraie fermeture de clavier remet 932 (relevé du même soir).
 *
 * Un focus donné à un champ sans clavier (`inputmode="none"`, 10.13.12) ne changeait rien non plus,
 * même dans un toucher : 585 avant, 585 après. Pour iOS, sans clavier montré, il ne s'est rien passé.
 * D'où un vrai clavier, une fraction de seconde : au premier toucher après le retour (iOS n'ouvre
 * un clavier que dans un geste), un champ invisible prend le focus et le rend à l'image suivante.
 * Le clavier peut amorcer sa montée ; c'est le prix, accepté par le propriétaire le 05/11/2026.
 * Chaque tentative est relevée avec ce qu'elle a changé.
 *
 * Jamais quand un champ de la page a le focus (le clavier est là pour de bon), ni pendant un film.
 * Sur iPhone, la référence est aussi l'écran : en application installée, `black-translucent` et
 * `viewport-fit=cover`, la page en occupe toute la hauteur — elle peut *démarrer* coincée. Pas sur
 * iPad, où une fenêtre partagée (Split View, Stage Manager) est légitimement plus basse.
 */

const SETTLE_AFTER_BLUR_MS = 140;
const SETTLE_AFTER_SHOW_MS = 300;
/** Le temps laissé à iOS pour rendre la hauteur après le clavier refermé. */
const MEASURE_AFTER_NUDGE_MS = 700;
/** Le jeu toléré entre deux mesures de la même orientation. */
const SLACK_PX = 4;
const NUDGE_ATTR = "data-viewport-nudge";

export type ViewportHealDeps = {
  win: Window;
  /** L'élément de toute la hauteur de l'app, mesuré pour le relevé. */
  shell: () => HTMLElement | null;
  /** Un film à l'écran : on ne touche à rien. */
  playing: () => boolean;
  /** La hauteur que la page doit avoir, quand l'appareil la donne (iPhone) ; `null` sinon. */
  fullHeight?: () => number | null;
  /** Le relevé d'un retour, et de chaque tentative — voir `viewportSnapshot`. */
  report?: (snapshot: Record<string, unknown>) => void;
};

/** Ce que la page sait de sa hauteur à un instant : la fenêtre, la vue visuelle, la racine, la coquille. */
function viewportSnapshot(win: Window, shell: HTMLElement | null): Record<string, number | null> {
  const vv = win.visualViewport;
  const box = shell?.getBoundingClientRect();
  return {
    inner: win.innerHeight,
    outer: win.outerHeight,
    width: win.innerWidth,
    vv: vv ? Math.round(vv.height) : null,
    vvTop: vv ? Math.round(vv.offsetTop) : null,
    client: win.document.documentElement.clientHeight,
    shell: box ? Math.round(box.height) : null,
    shellTop: box ? Math.round(box.top) : null,
    scrollY: Math.round(win.scrollY),
  };
}

function editableFocused(doc: Document): boolean {
  const el = doc.activeElement as HTMLElement | null;
  if (!el || el === doc.body || el.hasAttribute(NUDGE_ATTR)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(type);
}

/**
 * Le geste « ouvrir puis fermer un champ » : un champ invisible prend le focus — un vrai clavier,
 * appelé dans le toucher en cours — et le rend à l'image suivante ; le focus d'avant revient.
 */
export function flashKeyboard(win: Window): void {
  const doc = win.document;
  const previous = doc.activeElement as HTMLElement | null;
  const input = doc.createElement("input");
  input.type = "text";
  input.setAttribute(NUDGE_ATTR, "");
  input.setAttribute("aria-hidden", "true");
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("spellcheck", "false");
  input.tabIndex = -1;
  // 16 px : en dessous, iOS agrandit la page sur le champ qui prend le focus.
  Object.assign(input.style, { position: "fixed", top: "0", left: "0", width: "1px", height: "1px", opacity: "0", fontSize: "16px", pointerEvents: "none" });
  doc.body.appendChild(input);
  input.focus({ preventScroll: true });
  win.requestAnimationFrame(() => {
    input.blur();
    input.remove();
    if (previous && previous !== doc.body && previous.isConnected) previous.focus({ preventScroll: true });
  });
}

/**
 * Écoute la fenêtre et rend sa hauteur à la page quand elle est restée celle du clavier. Renvoie de
 * quoi se désabonner. Les dépendances sont injectées pour les tests ; `installViewportHeal` pose les vraies.
 */
export function watchViewportHeal({ win, shell, playing, fullHeight = () => null, report }: ViewportHealDeps): () => void {
  const doc = win.document;
  // La plus grande hauteur vue, par largeur : tourner l'appareil change légitimement la hauteur.
  const tallest = new Map<number, number>();
  const note = () => {
    const width = win.innerWidth;
    tallest.set(width, Math.max(tallest.get(width) ?? 0, win.innerHeight));
  };
  note();
  const expected = () => Math.max(tallest.get(win.innerWidth) ?? 0, fullHeight() ?? 0);
  const stuck = () => expected() - win.innerHeight > SLACK_PX;

  // Une hauteur coincée attend le premier toucher ; une tentative par toucher, tant qu'elle l'est.
  let armed = false;

  const relate = (trigger: string, decision: string, before: Record<string, unknown>, later = 0) => {
    if (!report) return;
    win.setTimeout(() => report({ trigger, best: expected(), decision, before, after: viewportSnapshot(win, shell()) }), later);
  };

  const onTouch = () => {
    armed = false;
    if (!stuck() || editableFocused(doc) || playing()) return;
    const before = viewportSnapshot(win, shell());
    flashKeyboard(win);
    relate("toucher", "clavier au toucher", before, MEASURE_AFTER_NUDGE_MS);
  };
  const arm = () => {
    if (armed) return;
    armed = true;
    doc.addEventListener("touchend", onTouch, { capture: true, once: true });
  };

  let timer: number | undefined;
  let trigger = "";
  const heal = () => {
    timer = undefined;
    if (doc.visibilityState === "hidden") return;
    const before = viewportSnapshot(win, shell());
    if (!stuck()) {
      // Un retour sans écart est relevé aussi (deux par onglet, `sendViewportDiag`).
      if (trigger === "retour") relate(trigger, "rien", before);
      return;
    }
    const skip = editableFocused(doc) ? "champ" : playing() ? "film" : null;
    if (skip) return relate(trigger, skip, before);
    arm();
    relate(trigger, "attend un toucher", before);
  };
  const later = (why: string, ms: number) => {
    if (timer !== undefined) win.clearTimeout(timer);
    trigger = why;
    timer = win.setTimeout(heal, ms);
  };

  const onFocusOut = (event: FocusEvent) => {
    // Le champ du geste lui-même : ce n'est pas un clavier qui se ferme.
    if ((event.target as Element | null)?.hasAttribute?.(NUDGE_ATTR)) return;
    later("clavier fermé", SETTLE_AFTER_BLUR_MS);
  };
  const onVisible = () => {
    if (doc.visibilityState === "visible") later("retour", SETTLE_AFTER_SHOW_MS);
  };
  const onPageShow = () => later("pageshow", SETTLE_AFTER_SHOW_MS);
  // Un rétrécissement sans champ actif chez nous : le clavier d'une autre app, appliqué au retour —
  // parfois après l'évènement de visibilité.
  const onResize = () => {
    note();
    later("redimensionné", SETTLE_AFTER_SHOW_MS);
  };
  win.addEventListener("resize", onResize);
  doc.addEventListener("focusout", onFocusOut);
  doc.addEventListener("visibilitychange", onVisible);
  win.addEventListener("pageshow", onPageShow);
  return () => {
    if (timer !== undefined) win.clearTimeout(timer);
    win.removeEventListener("resize", onResize);
    doc.removeEventListener("focusout", onFocusOut);
    doc.removeEventListener("visibilitychange", onVisible);
    win.removeEventListener("pageshow", onPageShow);
    doc.removeEventListener("touchend", onTouch, { capture: true });
  };
}

/** L'application installée sur iPhone ou iPad, et rien d'autre : ailleurs, la hauteur ne se coince pas. */
export function installViewportHeal(): () => void {
  if (typeof window === "undefined" || !isAppleTouchDevice()) return () => {};
  if (window.matchMedia?.("(display-mode: standalone)").matches !== true) return () => {};
  const iphone = /iPhone|iPod/.test(navigator.userAgent);
  return watchViewportHeal({
    win: window,
    // Les dimensions de `screen` sont celles du portrait, quelle que soit l'orientation : la largeur
    // de la page dit laquelle des deux est sa hauteur. Une largeur qui ne correspond à aucune : rien.
    fullHeight: () => {
      if (!iphone) return null;
      const { width, height } = window.screen;
      if (window.innerWidth === width) return height;
      if (window.innerWidth === height) return width;
      return null;
    },
    shell: () => document.querySelector<HTMLElement>(".app-viewport"),
    playing: () => Array.from(document.querySelectorAll("video")).some((v) => !v.paused && !v.ended),
    report: sendViewportDiag,
  });
}

/** Six relevés d'écart par onglet au plus : de quoi voir le défaut, pas un journal de chaque retour. */
const DIAG_MAX = 6;
/** Et deux retours sans écart, comptés à part pour ne pas manger la place des autres. */
const DIAG_PLAIN_MAX = 2;

function sendViewportDiag(snapshot: Record<string, unknown>): void {
  const plain = snapshot.decision === "rien";
  const key = plain ? "cine:viewport-diag-plain" : "cine:viewport-diag";
  try {
    const sent = Number(window.sessionStorage.getItem(key) ?? 0);
    if (sent >= (plain ? DIAG_PLAIN_MAX : DIAG_MAX)) return;
    window.sessionStorage.setItem(key, String(sent + 1));
  } catch {
    /* sans stockage : la limite de la route tient */
  }
  try {
    void fetch("/api/viewport-diag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...snapshot, screen: `${window.screen.width}x${window.screen.height}`, build: APP_BUILD, version: APP_VERSION }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* un relevé perdu ne coûte rien */
  }
}
