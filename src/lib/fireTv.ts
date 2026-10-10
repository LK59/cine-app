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
 * curseur, et un relevé des premières touches et du curseur (`installRemoteDiag`), envoyé une fois au
 * journal des ouvertures, pour savoir ce que Silk envoie vraiment au lieu de le supposer.
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

/**
 * Au curseur, le bord haut ou bas fait défiler le panneau vertical sous le curseur ; le bord gauche
 * ou droit, la rangée sous le curseur. Rien ne bouge si ce panneau défile déjà de lui-même (Silk a
 * su le faire) : on ne double pas la vitesse.
 */
export function installEdgeScroll(win: Window = window): () => void {
  let x = 0;
  let y = 0;
  let since = 0;
  let frame = 0;
  let last = 0;
  const watched = new WeakMap<HTMLElement, number>();
  const onMove = (e: PointerEvent | MouseEvent) => {
    x = e.clientX;
    y = e.clientY;
    const near = y > win.innerHeight * (1 - EDGE) || y < win.innerHeight * EDGE || x > win.innerWidth * (1 - EDGE) || x < win.innerWidth * EDGE;
    if (!near) {
      since = 0;
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
      const under = document.elementFromPoint(x, y);
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
          continue;
        }
        const step = v * EDGE_SPEED * (dt / 1000);
        if (axis === "y") box.scrollTop += step;
        else box.scrollLeft += step;
        watched.set(box, axis === "y" ? box.scrollTop : box.scrollLeft);
      }
    }
    frame = win.requestAnimationFrame(tick);
  };
  const stop = () => {
    since = 0;
    last = 0;
  };
  win.addEventListener("pointermove", onMove, { passive: true });
  win.addEventListener("mousemove", onMove, { passive: true });
  win.addEventListener("pointerleave", stop);
  win.addEventListener("blur", stop);
  return () => {
    if (frame) win.cancelAnimationFrame(frame);
    win.removeEventListener("pointermove", onMove);
    win.removeEventListener("mousemove", onMove);
    win.removeEventListener("pointerleave", stop);
    win.removeEventListener("blur", stop);
  };
}

/** Une touche relevée, telle qu'elle est arrivée. */
export type RemoteKeySample = { key: string; code: string; keyCode: number; target: string; prevented: boolean; t: number };

const MAX_KEYS = 30;
const SEND_AFTER_MS = 90_000;
const SENT_FLAG = "cine-remote-diag-sent";

function describeTarget(el: EventTarget | null): string {
  if (!(el instanceof Element)) return "?";
  const tag = el.tagName.toLowerCase();
  const tv = el.getAttribute("data-tv-card") !== null ? "[carte]" : el.getAttribute("data-tv-escape-up") ? "[bannière]" : "";
  const label = (el.getAttribute("aria-label") ?? "").slice(0, 24);
  return `${tag}${tv}${label ? `:${label}` : ""}`;
}

/**
 * Le relevé : les 30 premières touches (nom, code, keyCode, cible, déjà prise en charge ou non), le
 * nombre de mouvements de curseur et de molette, le mode de Silk qu'on en déduit. Envoyé une seule
 * fois par onglet — après 30 touches, ou 90 s, ou à la sortie de la page — et seulement s'il s'est
 * passé quelque chose. Lu après coup dans `startup.log` (`kind: "télécommande"`).
 */
export function installRemoteDiag(win: Window = window, send: (body: object) => void = defaultSend): () => void {
  try {
    if (win.sessionStorage.getItem(SENT_FLAG)) return () => {};
  } catch {
    /* pas de stockage : on relève quand même, une fois par chargement */
  }
  const started = performance.now();
  const keys: RemoteKeySample[] = [];
  let pointerMoves = 0;
  let wheels = 0;
  let sent = false;
  const flush = () => {
    if (sent || (keys.length === 0 && pointerMoves === 0 && wheels === 0)) return;
    sent = true;
    try {
      win.sessionStorage.setItem(SENT_FLAG, "1");
    } catch {
      /* rien */
    }
    send({ keys, pointerMoves, wheels, spentMs: Math.round(performance.now() - started), viewport: `${win.innerWidth}x${win.innerHeight}` });
    cleanup();
  };
  const onKey = (e: KeyboardEvent) => {
    if (isTranslatedKey(e) || keys.length >= MAX_KEYS) return;
    keys.push({ key: e.key, code: e.code, keyCode: e.keyCode, target: describeTarget(e.target), prevented: false, t: Math.round(performance.now() - started) });
    const sample = keys[keys.length - 1];
    // Lu après tout le monde, en bulle sur la fenêtre : la page l'a-t-elle pris en charge ?
    win.setTimeout(() => {
      sample.prevented = e.defaultPrevented;
      if (keys.length >= MAX_KEYS) flush();
    }, 0);
  };
  const onMove = () => {
    pointerMoves += 1;
  };
  const onWheel = () => {
    wheels += 1;
  };
  const timer = win.setTimeout(flush, SEND_AFTER_MS);
  const onHide = () => flush();
  win.addEventListener("keydown", onKey, { capture: true });
  win.addEventListener("pointermove", onMove, { passive: true });
  win.addEventListener("wheel", onWheel, { passive: true });
  win.addEventListener("pagehide", onHide);
  function cleanup() {
    win.clearTimeout(timer);
    win.removeEventListener("keydown", onKey, { capture: true });
    win.removeEventListener("pointermove", onMove);
    win.removeEventListener("wheel", onWheel);
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
