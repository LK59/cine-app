import { deviceLabel } from "@/lib/deviceLabel";
import { isTranslatedKey } from "@/lib/remoteKeys";

/**
 * Le cinéma dans Silk, le navigateur des Fire TV (10/10/2026).
 *
 * Timothé, sur sa Fire TV Stick, ne pouvait pas « descendre » à la télécommande. Silk a deux façons
 * de se servir du pavé directionnel (Amazon, et la notice de Silk) :
 *  - la navigation au curseur, celle par défaut : le pavé déplace une flèche à l'écran, comme une
 *    souris, et la page ne reçoit aucune touche fléchée — Amazon le confirme pour son propre kit
 *    d'applications web (« the d-pad controls the cursor rather than passing the key events to the
 *    page ») ; la page défile quand le curseur touche un bord ;
 *  - la navigation spatiale (l'icône en forme de flèche de la barre de Silk) : le pavé saute
 *    d'élément en élément, et la page reçoit ses flèches.
 * Au curseur, rien de la navigation aux flèches du cinéma ne joue, et le défilement « au bord » de
 * Silk vise le document — or l'accueil défile dans son propre panneau (`overflow-y-auto`), pas dans
 * le document : très probablement le « je ne peux pas descendre ». D'où deux choses, réservées à la
 * Fire TV : un défilement au bord fait ici (`installEdgeScroll`), qui fait défiler le panneau sous le
 * curseur, et un relevé des premières touches et du curseur (`installRemoteDiag`), envoyé au
 * journal des ouvertures — un par mode depuis le 12/10 —, pour savoir ce que Silk envoie vraiment au
 * lieu de le supposer.
 */
export function isFireTv(userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): boolean {
  return deviceLabel(userAgent)?.startsWith("Fire TV") ?? false;
}

/** La bande, en fraction de l'écran, où le curseur fait défiler. */
const EDGE = 0.07;
/** Le temps qu'il doit y rester avant que ça défile : un passage n'est pas une demande. */
const EDGE_DWELL_MS = 180;
/** La vitesse au plus près du bord, en pixels par seconde. */
const EDGE_SPEED = 900;

function scrollableAncestor(el: Element | null, axis: "x" | "y"): HTMLElement | null {
  for (let node = el as HTMLElement | null; node && node !== document.documentElement; node = node.parentElement) {
    const cs = getComputedStyle(node);
    const overflow = axis === "y" ? cs.overflowY : cs.overflowX;
    const room = axis === "y" ? node.scrollHeight - node.clientHeight : node.scrollWidth - node.clientWidth;
    if ((overflow === "auto" || overflow === "scroll") && room > 4) return node;
  }
  return null;
}

/** Combien de fois le défilement au bord s'est mis en route — lu par le relevé. */
let edgeScrollStarts = 0;

/** Le centre de l'élément focalisé, à ±2 px : là où la navigation spatiale pose son survol. */
function atFocusCentre(doc: Document, x: number, y: number): boolean {
  const active = doc.activeElement;
  if (!(active instanceof HTMLElement) || active === doc.body) return false;
  const r = active.getBoundingClientRect();
  if (!r.width && !r.height) return false;
  return Math.abs(r.left + r.width / 2 - x) <= 2 && Math.abs(r.top + r.height / 2 - y) <= 2;
}

/**
 * Au curseur, le bord haut ou bas fait défiler le panneau vertical sous le curseur ; le bord gauche
 * ou droit, la rangée sous le curseur. Rien ne bouge si ce panneau défile déjà de lui-même (Silk a
 * su le faire) : on ne double pas la vitesse.
 *
 * **Seul un curseur qui bouge l'arme, et toute touche le désarme** (12/10/2026). Le défilement
 * continuait tant que le curseur restait au bord, sans autre fin qu'un mouvement, une sortie de la
 * fenêtre ou la perte du focus. Or en mode immersif de Silk le curseur ne bouge plus : il reste,
 * invisible, là où on l'a laissé — au bord, puisque c'est ainsi qu'on fait défiler au curseur. La
 * page continuait donc de défiler sous chaque flèche : la rangée repartait vers le bord pendant que
 * la grille ramenait l'affiche choisie, et le panneau redescendait à chaque ↑ — Timothé, le 11/10,
 * « je ne peux pas aller vers le haut », « au 3e film ça ne fonctionne plus », et « si tu switches
 * entre les 2 modes ça fonctionne » (basculer déplace le curseur, ce qui arrêtait tout). Désormais :
 *  - une touche, ou un focus déplacé sans le pointeur (la navigation spatiale), arrête le
 *    défilement, et seul un mouvement vers une *autre* position le réarme ;
 *  - un mouvement qui tombe au centre exact de l'élément focalisé ne compte pas : c'est le survol
 *    que la navigation spatiale de Chromium pose sur ce qu'elle vient de choisir, pas un curseur ;
 *  - au bout du défilement, la boucle s'arrête au lieu de tourner à vide à chaque image.
 */
export function installEdgeScroll(win: Window = window): () => void {
  let x = Number.NaN;
  let y = Number.NaN;
  let since = 0;
  let frame = 0;
  let last = 0;
  let pointerDownAt = Number.NEGATIVE_INFINITY;
  let running = false;
  const watched = new WeakMap<HTMLElement, number>();
  const onMove = (e: PointerEvent | MouseEvent) => {
    // `pointermove` et `mousemove` arrivent tous deux pour un même geste : le second, à la même
    // position, ne dit rien de plus — et un `mousemove` fabriqué par le navigateur après un
    // défilement, sous un curseur immobile, non plus.
    if (Math.abs(e.clientX - x) < 1 && Math.abs(e.clientY - y) < 1) return;
    x = e.clientX;
    y = e.clientY;
    const near = y > win.innerHeight * (1 - EDGE) || y < win.innerHeight * EDGE || x > win.innerWidth * (1 - EDGE) || x < win.innerWidth * EDGE;
    if (!near || atFocusCentre(win.document, x, y)) {
      disarm();
      return;
    }
    if (!since) since = performance.now();
    if (!frame) frame = win.requestAnimationFrame(tick);
  };
  const tick = (now: number) => {
    frame = 0;
    if (!since) return;
    const dt = last ? Math.min(50, now - last) : 16;
    last = now;
    if (now - since >= EDGE_DWELL_MS) {
      let moved = false;
      const under = win.document.elementFromPoint(x, y);
      const h = win.innerHeight;
      const w = win.innerWidth;
      const vy = y > h * (1 - EDGE) ? (y - h * (1 - EDGE)) / (h * EDGE) : y < h * EDGE ? -(h * EDGE - y) / (h * EDGE) : 0;
      const vx = x > w * (1 - EDGE) ? (x - w * (1 - EDGE)) / (w * EDGE) : x < w * EDGE ? -(w * EDGE - x) / (w * EDGE) : 0;
      for (const [axis, v] of [["y", vy], ["x", vx]] as const) {
        if (!v) continue;
        const box = scrollableAncestor(under, axis);
        if (!box) continue;
        const pos = axis === "y" ? box.scrollTop : box.scrollLeft;
        const ours = watched.get(box);
        // Le panneau a bougé sans nous depuis le dernier pas : Silk défile lui-même, on s'efface.
        if (ours !== undefined && Math.abs(pos - ours) > 1) {
          watched.delete(box);
          moved = true;
          continue;
        }
        const step = v * EDGE_SPEED * (dt / 1000);
        if (axis === "y") box.scrollTop += step;
        else box.scrollLeft += step;
        const after = axis === "y" ? box.scrollTop : box.scrollLeft;
        if (Math.abs(after - pos) > 0.01) moved = true;
        watched.set(box, after);
      }
      if (moved && !running) {
        running = true;
        edgeScrollStarts += 1;
      }
      // Plus rien à faire défiler sous le curseur : la boucle s'arrête. Le prochain mouvement la
      // relance s'il y a de nouveau de la place.
      if (!moved) {
        running = false;
        last = 0;
        return;
      }
    }
    frame = win.requestAnimationFrame(tick);
  };
  function disarm() {
    since = 0;
    last = 0;
    running = false;
    if (frame) {
      win.cancelAnimationFrame(frame);
      frame = 0;
    }
  }
  const onKey = () => disarm();
  const onPointerDown = () => {
    pointerDownAt = performance.now();
  };
  // Un focus qui change sans appui du pointeur : la navigation spatiale, la tabulation, le code.
  // Un clic sur une affiche, lui, ne désarme rien.
  const onFocusIn = () => {
    if (performance.now() - pointerDownAt > 500) disarm();
  };
  win.addEventListener("pointermove", onMove, { passive: true });
  win.addEventListener("mousemove", onMove, { passive: true });
  win.addEventListener("pointerleave", disarm);
  win.addEventListener("blur", disarm);
  win.addEventListener("keydown", onKey, { capture: true });
  win.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  win.addEventListener("focusin", onFocusIn, { capture: true });
  return () => {
    disarm();
    win.removeEventListener("pointermove", onMove);
    win.removeEventListener("mousemove", onMove);
    win.removeEventListener("pointerleave", disarm);
    win.removeEventListener("blur", disarm);
    win.removeEventListener("keydown", onKey, { capture: true });
    win.removeEventListener("pointerdown", onPointerDown, { capture: true });
    win.removeEventListener("focusin", onFocusIn, { capture: true });
  };
}

/**
 * Une touche relevée, telle qu'elle est arrivée : `before` / `after`, l'élément focalisé avant elle
 * et juste après que tout le monde l'a traitée ; `gridMoved`, si c'est la grille du cinéma qui a
 * déplacé le focus (sinon, un `after` différent de `before` est l'œuvre de quelqu'un d'autre — Silk).
 */
export type RemoteKeySample = {
  key: string;
  code: string;
  keyCode: number;
  target: string;
  prevented: boolean;
  t: number;
  before: string;
  after: string;
  gridMoved: boolean;
};

/** Un focus déplacé sans qu'aucune touche ni aucun appui ne soit arrivé à la page. */
export type ForeignFocusSample = { t: number; from: string; to: string };

/** Les deux façons dont Silk se sert du pavé — voir l'en-tête. */
export type RemoteMode = "curseur" | "spatial";

const MAX_KEYS = 30;
const MAX_FOCUS_MOVES = 20;
const SEND_AFTER_MS = 90_000;
/** Au plus trois relevés par onglet, et deux du même mode : de quoi voir un aller-retour. */
const MAX_REPORTS = 3;
const MAX_PER_MODE = 2;
/** Des mouvements de curseur sans aucune touche : on est repassé au curseur. */
const BACK_TO_CURSOR_MOVES = 20;
/** Une touche ou un appui « explique » un changement de focus qui suit d'aussi près. */
const EXPLAINED_WITHIN_MS = 300;
const SENT_KEY = "cine-remote-diag-v2";

/**
 * Un élément, sans rien de personnel : sa balise, son rôle dans le cinéma — pour une affiche, sa
 * rangée et sa colonne, jamais son titre — et l'étiquette des autres (boutons du rail, bannière).
 */
function describeTarget(el: EventTarget | null): string {
  if (!(el instanceof Element)) return "?";
  const tag = el.tagName.toLowerCase();
  if (el.getAttribute("data-tv-card") !== null) {
    return `${tag}[carte ${(el.getAttribute("data-tv-row") ?? "").slice(0, 32)}#${el.getAttribute("data-tv-col") ?? "?"}]`;
  }
  const tv = el.getAttribute("data-tv-escape-up") ? "[bannière]" : el.closest("[data-player-nav]") ? "[rail]" : el.closest("[data-tv-rowroot]") ? "[rangée]" : "";
  const label = (el.getAttribute("aria-label") ?? "").slice(0, 24);
  return `${tag}${tv}${label ? `:${label}` : ""}`;
}

type Sent = Record<RemoteMode, number>;
function readSent(win: Window): Sent {
  try {
    const raw = JSON.parse(win.sessionStorage.getItem(SENT_KEY) ?? "null") as Partial<Sent> | null;
    return { curseur: Number(raw?.curseur) || 0, spatial: Number(raw?.spatial) || 0 };
  } catch {
    return { curseur: 0, spatial: 0 };
  }
}

/**
 * Le relevé (10/10/2026, refait le 12/10) : ce que la télécommande fait vraiment arriver à la page,
 * **un relevé par mode de Silk** — le premier, envoyé au curseur, n'empêchait plus d'en voir un
 * second : le seul relevé de Timothé (`keys: []`, 258 mouvements) disait le mode curseur, et le mode
 * immersif, celui où il ne pouvait « pas aller vers le haut », n'avait jamais été observé.
 *
 * Un relevé s'ouvre au premier évènement et prend le mode qu'il montre : une touche, « spatial » ;
 * un mouvement de curseur, « curseur ». Une touche qui arrive pendant un relevé « curseur », ou
 * vingt mouvements sans touche pendant un relevé « spatial », l'envoient et en ouvrent un autre. Il
 * part aussi après 30 touches, 90 s, ou à la sortie de la page. Au plus trois par onglet, deux du
 * même mode (`sessionStorage`) ; au-delà, plus rien n'est écouté.
 *
 * Chaque relevé dit : les touches (avec le focus avant / après et si la grille l'a déplacé), les
 * focus déplacés sans touche ni appui reçus (`focusMoves` : la navigation spatiale de Silk qui ne
 * donne pas sa flèche à la page), les mouvements de curseur, dont ceux qui tombent au centre exact
 * de l'élément focalisé (`pointerAtFocus` : le survol que la navigation spatiale pose, pas un
 * curseur), la molette, et combien de fois le défilement au bord s'est mis en route
 * (`edgeScrolls`). Lu après coup dans `startup.log` (`kind: "télécommande"`).
 */
export function installRemoteDiag(
  win: Window = window,
  send: (body: object) => void = defaultSend,
  gridMoves: () => number = () => 0
): () => void {
  const sent = readSent(win);
  const total = () => sent.curseur + sent.spatial;
  if (total() >= MAX_REPORTS) return () => {};
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);

  type Report = {
    mode: RemoteMode;
    startedAt: number;
    keys: RemoteKeySample[];
    focusMoves: ForeignFocusSample[];
    pointerMoves: number;
    pointerAtFocus: number;
    wheels: number;
    edgeScrollsAtStart: number;
    movesSinceKey: number;
    timer: number;
  };
  let report: Report | null = null;
  let lastKeyAt = Number.NEGATIVE_INFINITY;
  let lastPointerDownAt = Number.NEGATIVE_INFINITY;
  let done = false;

  const allowed = (mode: RemoteMode) => !done && total() < MAX_REPORTS && sent[mode] < MAX_PER_MODE;

  const open = (mode: RemoteMode): Report | null => {
    if (!allowed(mode)) return null;
    report = {
      mode,
      startedAt: performance.now(),
      keys: [],
      focusMoves: [],
      pointerMoves: 0,
      pointerAtFocus: 0,
      wheels: 0,
      edgeScrollsAtStart: edgeScrollStarts,
      movesSinceKey: 0,
      timer: win.setTimeout(() => flush(), SEND_AFTER_MS),
    };
    return report;
  };

  function flush() {
    const r = report;
    report = null;
    if (!r) return;
    win.clearTimeout(r.timer);
    if (r.keys.length === 0 && r.pointerMoves === 0 && r.wheels === 0 && r.focusMoves.length === 0) return;
    sent[r.mode] += 1;
    try {
      win.sessionStorage.setItem(SENT_KEY, JSON.stringify(sent));
    } catch {
      /* pas de stockage : la limite tient pour ce chargement */
    }
    send({
      mode: r.mode,
      report: total(),
      keys: r.keys,
      focusMoves: r.focusMoves,
      pointerMoves: r.pointerMoves,
      pointerAtFocus: r.pointerAtFocus,
      wheels: r.wheels,
      edgeScrolls: edgeScrollStarts - r.edgeScrollsAtStart,
      spentMs: Math.round(performance.now() - r.startedAt),
      viewport: `${win.innerWidth}x${win.innerHeight}`,
    });
    if (total() >= MAX_REPORTS) cleanup();
  }

  const onKey = (e: KeyboardEvent) => {
    if (isTranslatedKey(e)) return;
    lastKeyAt = performance.now();
    if (report?.mode === "curseur") flush();
    const r = report ?? open("spatial");
    if (!r) return;
    r.movesSinceKey = 0;
    if (r.keys.length >= MAX_KEYS) return;
    const doc = win.document;
    const sample: RemoteKeySample = {
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      target: describeTarget(e.target),
      prevented: false,
      t: now(),
      before: describeTarget(doc.activeElement),
      after: "",
      gridMoved: false,
    };
    r.keys.push(sample);
    const movesBefore = gridMoves();
    // Lu après tout le monde, en bulle sur la fenêtre : la page l'a-t-elle prise en charge, et où
    // le focus a-t-il fini ?
    win.setTimeout(() => {
      sample.prevented = e.defaultPrevented;
      sample.after = describeTarget(doc.activeElement);
      sample.gridMoved = gridMoves() !== movesBefore;
      if (report === r && r.keys.length >= MAX_KEYS) flush();
    }, 0);
  };
  const onMove = (e: PointerEvent) => {
    const atFocus = atFocusCentre(win.document, e.clientX, e.clientY);
    if (report?.mode === "spatial" && !atFocus) {
      report.movesSinceKey += 1;
      if (report.movesSinceKey >= BACK_TO_CURSOR_MOVES) flush();
    }
    const r = report ?? open("curseur");
    if (!r) return;
    r.pointerMoves += 1;
    if (atFocus) r.pointerAtFocus += 1;
  };
  const onWheel = () => {
    const r = report ?? open("curseur");
    if (r) r.wheels += 1;
  };
  const onPointerDown = () => {
    lastPointerDownAt = performance.now();
  };
  const onFocusIn = (e: FocusEvent) => {
    const at = performance.now();
    if (at - lastKeyAt < EXPLAINED_WITHIN_MS || at - lastPointerDownAt < EXPLAINED_WITHIN_MS) return;
    const r = report ?? open("spatial");
    if (!r || r.focusMoves.length >= MAX_FOCUS_MOVES) return;
    // `relatedTarget` : ce qui avait le focus juste avant — la carte que la grille tenait pour
    // choisie, puisqu'elle n'a pas d'autre sélection que le focus.
    r.focusMoves.push({ t: now(), from: describeTarget(e.relatedTarget), to: describeTarget(e.target) });
  };
  const onHide = () => flush();
  win.addEventListener("keydown", onKey, { capture: true });
  win.addEventListener("pointermove", onMove, { passive: true });
  win.addEventListener("wheel", onWheel, { passive: true });
  win.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  win.addEventListener("focusin", onFocusIn, { capture: true });
  win.addEventListener("pagehide", onHide);
  function cleanup() {
    done = true;
    if (report) win.clearTimeout(report.timer);
    report = null;
    win.removeEventListener("keydown", onKey, { capture: true });
    win.removeEventListener("pointermove", onMove);
    win.removeEventListener("wheel", onWheel);
    win.removeEventListener("pointerdown", onPointerDown, { capture: true });
    win.removeEventListener("focusin", onFocusIn, { capture: true });
    win.removeEventListener("pagehide", onHide);
  }
  return cleanup;
}

function defaultSend(body: object): void {
  try {
    void fetch("/api/remote-diag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* rien : un relevé perdu ne coûte rien */
  }
}
