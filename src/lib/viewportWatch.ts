import { APP_BUILD, APP_VERSION } from "@/lib/appBuild";
import { isAppleTouchDevice } from "@/lib/iosInstall";

/**
 * L'écran rétréci de l'application installée sur iPhone et iPad (04/11/2026) — **relevé, pas réparé**.
 *
 * Le clavier ouvert dans une autre app, puis retour dans Laterna par un glissé de la barre d'accueil :
 * la page reste coupée aux deux tiers, la barre flottante au milieu de l'écran, du noir dessous. Elle
 * ne se remet qu'en ouvrant puis fermant le clavier chez nous (la recherche). Défaut de WebKit en mode
 * installé, signalé sur iOS 26 (WebKit 301857).
 *
 * Mesuré les 04–05/11/2026 (`kind: "hauteur"` dans `startup.log`, iPhone 430 × 932) : au retour,
 * `innerHeight`, la vue visuelle, la racine et la coquille valent 585 (ou 612) — la *fenêtre* elle-même
 * a la hauteur avec clavier ; `outerHeight` dit 932. Trois réparations essayées, chacune relevée sans
 * effet, puis retirées : retirer un instant la coquille du rendu (10.13.10), un focus donné à un champ
 * sans clavier (`inputmode="none"`, 10.13.12), un vrai clavier appelé au premier toucher et refermé à
 * l'image suivante (10.13.13 — iOS ne l'a même pas montré). Dessiner nous-mêmes à la hauteur de
 * l'écran a été écarté par le propriétaire (44 composants calés sur le bas de la fenêtre). On attend
 * Apple ; ce relevé dira quand une version d'iOS l'aura corrigé.
 *
 * Sur iPhone, la référence est aussi l'écran : en application installée, `black-translucent` et
 * `viewport-fit=cover`, la page en occupe toute la hauteur. Pas sur iPad, où une fenêtre partagée
 * (Split View, Stage Manager) est légitimement plus basse.
 */

const SETTLE_AFTER_BLUR_MS = 140;
const SETTLE_AFTER_SHOW_MS = 300;
/** Le jeu toléré entre deux mesures de la même orientation. */
const SLACK_PX = 4;

export type ViewportWatchDeps = {
  win: Window;
  /** L'élément de toute la hauteur de l'app, mesuré pour le relevé. */
  shell: () => HTMLElement | null;
  /** Un film à l'écran : dit dans le relevé. */
  playing: () => boolean;
  /** La hauteur que la page doit avoir, quand l'appareil la donne (iPhone) ; `null` sinon. */
  fullHeight?: () => number | null;
  /** Le relevé d'un retour — voir `viewportSnapshot`. */
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
  if (!el || el === doc.body) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "range", "submit", "reset", "file", "color"].includes(type);
}

/**
 * Écoute la fenêtre et relève une hauteur restée celle du clavier. Renvoie de quoi se désabonner. Les
 * dépendances sont injectées pour les tests ; `installViewportWatch` pose les vraies.
 */
export function watchViewportStuck({ win, shell, playing, fullHeight = () => null, report }: ViewportWatchDeps): () => void {
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

  const relate = (trigger: string, decision: string, before: Record<string, unknown>) => {
    if (report) report({ trigger, best: expected(), decision, before });
  };

  let timer: number | undefined;
  let trigger = "";
  const check = () => {
    timer = undefined;
    if (doc.visibilityState === "hidden") return;
    const before = viewportSnapshot(win, shell());
    if (!stuck()) {
      // Un retour sans écart est relevé aussi (deux par onglet, `sendViewportDiag`).
      if (trigger === "retour") relate(trigger, "rien", before);
      return;
    }
    relate(trigger, editableFocused(doc) ? "champ" : playing() ? "film" : "coincée", before);
  };
  const later = (why: string, ms: number) => {
    if (timer !== undefined) win.clearTimeout(timer);
    trigger = why;
    timer = win.setTimeout(check, ms);
  };

  const onFocusOut = () => later("clavier fermé", SETTLE_AFTER_BLUR_MS);
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
  };
}

/** L'application installée sur iPhone ou iPad, et rien d'autre : ailleurs, la hauteur ne se coince pas. */
export function installViewportWatch(): () => void {
  if (typeof window === "undefined" || !isAppleTouchDevice()) return () => {};
  if (window.matchMedia?.("(display-mode: standalone)").matches !== true) return () => {};
  const iphone = /iPhone|iPod/.test(navigator.userAgent);
  return watchViewportStuck({
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
