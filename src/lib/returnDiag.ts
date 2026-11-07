import { APP_BUILD, APP_VERSION } from "@/lib/appBuild";
import { isAppleTouchDevice } from "@/lib/iosInstall";

/**
 * Ce que coûte un retour au premier plan sur iPhone et iPad (07/11/2026) — **relevé, rien d'autre**.
 *
 * Louis voit parfois, en revenant dans l'app, l'interface figée un instant (la barre du bas, dessinée
 * à part, répond encore). Trois suspects dans le code, aucun mesuré : le rechargement vers une version
 * neuve (`BuildRefresh`), le catalogue relu passé quinze minutes (`useCatalogueRefresh`), les listes
 * revérifiées toutes ensemble (`ForegroundReplay`). Safari n'a pas l'API des longues tâches ; ce qu'on
 * peut mesurer, ce sont les images : une boucle `requestAnimationFrame` pendant trois secondes après le
 * retour donne la première image, le plus long trou entre deux, et combien dépassent 50 et 200 ms. Les
 * trois suspects disent ce qu'ils ont fait (`noteReturn`), avec l'instant depuis le retour — la ligne
 * dit donc quel travail tombe sur quel trou.
 *
 * Léger : seulement après au moins deux secondes cachée, huit lignes par onglet au plus, une ligne par
 * retour dans `startup.log` (`kind: "retour"`, par la route du relevé de hauteur). Une page qui se
 * recharge pendant la mesure envoie ce qu'elle a (`cut: "rechargement"`).
 */

export const RETURN_WINDOW_MS = 3000;
const MIN_HIDDEN_MS = 2000;
const JANK_MS = 50;
const LONG_JANK_MS = 200;
const MAX_LINES_PER_TAB = 8;
const MAX_EVENTS = 12;

export interface ReturnMeasure {
  hiddenMs: number;
  /** De l'événement de visibilité à la première image dessinée. */
  firstFrameMs: number | null;
  frames: number;
  maxGapMs: number;
  /** Quand, depuis le retour, le plus long trou a fini. */
  maxGapAtMs: number;
  janks: number;
  longJanks: number;
  /** `quoi:détail@ms`, dans l'ordre. */
  events: string[];
  film: boolean;
  cut?: "rechargement" | "caché";
}

type Clock = () => number;

/** Une mesure en cours, ou aucune : les suspects notent dans celle-ci. */
let current: { start: number; events: string[]; now: Clock } | null = null;

/** Ce qu'un suspect a fait pendant la mesure d'un retour. Sans mesure en cours : rien. */
export function noteReturn(what: string, detail?: string | number): void {
  if (!current || current.events.length >= MAX_EVENTS) return;
  const at = Math.round(current.now() - current.start);
  current.events.push(`${what}${detail === undefined ? "" : `:${detail}`}@${at}`);
}

export type ReturnDiagDeps = {
  doc: Document;
  win: Window;
  now: Clock;
  raf: (cb: (t: number) => void) => number;
  cancelRaf: (id: number) => void;
  playing: () => boolean;
  report: (measure: ReturnMeasure) => void;
};

/** Mesure chaque retour au premier plan. Renvoie de quoi se désabonner. Dépendances injectées pour les tests. */
export function watchReturns({ doc, win, now, raf, cancelRaf, playing, report }: ReturnDiagDeps): () => void {
  let hiddenAt: number | null = doc.visibilityState === "hidden" ? now() : null;
  let frameId: number | null = null;
  let finish: ((cut?: ReturnMeasure["cut"]) => void) | null = null;

  const start = () => {
    const begin = now();
    const hiddenMs = hiddenAt === null ? 0 : Math.round(begin - hiddenAt);
    hiddenAt = null;
    if (hiddenMs < MIN_HIDDEN_MS) return;
    const state = { start: begin, events: [] as string[], now };
    current = state;
    let last: number | null = null;
    let first: number | null = null;
    let frames = 0;
    let maxGap = 0;
    let maxGapAt = 0;
    let janks = 0;
    let longJanks = 0;
    const film = playing();
    finish = (cut) => {
      finish = null;
      if (frameId !== null) cancelRaf(frameId);
      frameId = null;
      if (current === state) current = null;
      report({
        hiddenMs,
        firstFrameMs: first === null ? null : Math.round(first - begin),
        frames,
        maxGapMs: Math.round(maxGap),
        maxGapAtMs: Math.round(maxGapAt),
        janks,
        longJanks,
        events: state.events,
        film,
        ...(cut ? { cut } : {}),
      });
    };
    const tick = () => {
      const t = now();
      frames += 1;
      if (first === null) first = t;
      if (last !== null) {
        const gap = t - last;
        if (gap > maxGap) {
          maxGap = gap;
          maxGapAt = t - begin;
        }
        if (gap > JANK_MS) janks += 1;
        if (gap > LONG_JANK_MS) longJanks += 1;
      }
      last = t;
      if (t - begin >= RETURN_WINDOW_MS) finish?.();
      else frameId = raf(tick);
    };
    frameId = raf(tick);
  };

  const onVisibility = () => {
    if (doc.visibilityState === "hidden") {
      // Cachée de nouveau avant la fin : ce qu'on a, dit comme tel.
      finish?.("caché");
      hiddenAt = now();
      return;
    }
    if (!finish) start();
  };
  const onPageHide = () => finish?.("rechargement");
  // En capture sur la fenêtre, comme la porte du retour (`foregroundGate.ts`) : la mesure commence
  // avant tout écouteur du document, donc avant que les suspects aient pu noter quoi que ce soit.
  win.addEventListener("visibilitychange", onVisibility, true);
  win.addEventListener("pagehide", onPageHide);
  return () => {
    win.removeEventListener("visibilitychange", onVisibility, true);
    win.removeEventListener("pagehide", onPageHide);
    if (frameId !== null) cancelRaf(frameId);
    current = null;
  };
}

/** iPhone et iPad seulement, application installée ou non. */
export function installReturnDiag(): () => void {
  if (typeof window === "undefined" || !isAppleTouchDevice()) return () => {};
  return watchReturns({
    doc: document,
    win: window,
    now: () => performance.now(),
    raf: (cb) => window.requestAnimationFrame(cb),
    cancelRaf: (id) => window.cancelAnimationFrame(id),
    playing: () => Array.from(document.querySelectorAll("video")).some((v) => !v.paused && !v.ended),
    report: sendReturnDiag,
  });
}

function sendReturnDiag(measure: ReturnMeasure): void {
  try {
    const key = "cine:return-diag";
    const sent = Number(window.sessionStorage.getItem(key) ?? 0);
    if (sent >= MAX_LINES_PER_TAB) return;
    window.sessionStorage.setItem(key, String(sent + 1));
  } catch {
    /* sans stockage : la limite de la route tient */
  }
  try {
    void fetch("/api/viewport-diag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "retour", ...measure, standalone: window.matchMedia?.("(display-mode: standalone)").matches === true, build: APP_BUILD, version: APP_VERSION }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* une mesure perdue ne coûte rien */
  }
}
