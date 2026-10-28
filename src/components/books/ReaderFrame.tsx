"use client";

import { useEffect, useRef } from "react";
import { useSWRConfig } from "swr";
import { useT } from "@/components/TranslationProvider";
import { cinemaClose, cinemaNavigate, readCinemaRoute } from "@/lib/cinemaRoute";
import { readerOpening, readerPageColor } from "@/lib/books/readerOpening";
import { BOOKS_PROGRESS_EVENT, acceptFromFrame, parentMessage, readerFrameUrl, type Insets } from "@/lib/books/readerFrame";

/**
 * Le lecteur de livres posé sur le cinéma, dans un cadre de la même origine (DECISIONS.md §127 et §128).
 *
 * Ouvrir : la couverture grandit en première page (`readerOpening`) et, **pendant** ce temps, le cadre
 * `/livres?cadre=1#livre=…&lire=1` se charge, invisible, sous le calque — puis l'adresse du cinéma nomme
 * le lecteur (`&lire=1`, une seule entrée d'historique) et le cadre paraît. Le calque reste jusqu'à ce que
 * le cadre dise que sa première page est là (`ready`). L'adresse n'est poussée qu'après l'animation, comme
 * le faisait la page des livres : la fiche reste dessous pendant que la couverture grandit.
 *
 * Refermer : le cadre le demande (`close` — sa croix, Échap), ou Retour (le bouton d'Android, le
 * navigateur) ramène l'entrée d'en dessous ; dans les deux cas c'est l'adresse qui décide
 * (`cinemaClose`, un seul retour en vol), et le cadre est retiré quand elle ne nomme plus le lecteur. Le
 * cinéma dessous n'a pas bougé : ni rechargement, ni accueil reconstruit, et la fiche se redécouvre.
 *
 * Le cadre est un élément du DOM tenu ici, hors de React : il naît avant que l'adresse ne le nomme, et
 * déplacer un `<iframe>` dans le document le recharge — on ne le déplace donc jamais, on le montre.
 */

/** Ce que le cadre peut demander au navigateur : rien. Le lecteur n'a besoin d'aucune de ces permissions. */
const FRAME_ALLOW = [
  "camera",
  "microphone",
  "geolocation",
  "payment",
  "usb",
  "display-capture",
  "fullscreen",
  "autoplay",
  "clipboard-read",
  "clipboard-write",
  "screen-wake-lock",
  "web-share",
]
  .map((feature) => `${feature} 'none'`)
  .join("; ");
/** Le calque d'ouverture ne reste jamais plus longtemps : au pire, le lecteur montre son propre chargement. */
const REVEAL_FALLBACK_MS = 5000;
/** La dernière position part du cadre en `keepalive` au moment où il est retiré : relue une fois arrivée. */
const SETTLE_REFRESH_MS = 1500;

interface Held {
  id: string;
  root: HTMLDivElement;
  frame: HTMLIFrameElement;
  ready: boolean;
  /** Le calque d'ouverture, rendu par `readerOpening` à la fin de son animation. */
  opening: Promise<() => void> | null;
  /** L'adresse nomme le lecteur : `close` passe par elle. */
  adopted: boolean;
  /** `close` reçu avant que l'adresse ne nomme le lecteur. */
  closeRequested: boolean;
  onReady: (() => void) | null;
  refresh: (() => void) | null;
  stop: () => void;
}

let held: Held | null = null;

/** Les marges de l'écran mesurées ici : un cadre ne reçoit pas celles de l'encoche ni de la barre d'accueil. */
function measureInsets(): Insets {
  const probe = document.createElement("div");
  Object.assign(probe.style, {
    position: "fixed",
    visibility: "hidden",
    pointerEvents: "none",
    paddingTop: "env(safe-area-inset-top)",
    paddingRight: "env(safe-area-inset-right)",
    paddingBottom: "env(safe-area-inset-bottom)",
    paddingLeft: "env(safe-area-inset-left)",
  });
  document.body.appendChild(probe);
  const style = getComputedStyle(probe);
  const px = (v: string) => Math.max(0, Number.parseFloat(v) || 0);
  const insets = { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
  probe.remove();
  return insets;
}

/** Retire le calque d'ouverture, une fois : il part en fondu sur la page déjà là. */
function finishOpening(h: Held): void {
  const opening = h.opening;
  h.opening = null;
  if (opening) void opening.then((done) => done()).catch(() => {});
}

/** Le cadre de ce livre : celui qui se prépare déjà, ou un nouveau (lien direct, rechargement, Suivant). */
function hold(id: string): Held {
  if (held?.id === id) return held;
  release();
  const root = document.createElement("div");
  root.setAttribute("data-reader-frame", "");
  Object.assign(root.style, { position: "fixed", inset: "0", zIndex: "390", background: readerPageColor(), opacity: "0", pointerEvents: "none" });
  const frame = document.createElement("iframe");
  frame.setAttribute("allow", FRAME_ALLOW);
  frame.setAttribute("referrerpolicy", "same-origin");
  Object.assign(frame.style, { position: "absolute", inset: "0", width: "100%", height: "100%", border: "0", display: "block", background: "transparent" });
  // L'adresse avant l'insertion : la première navigation d'un cadre neuf remplace son `about:blank`, elle
  // n'ajoute rien à l'historique de la fenêtre.
  frame.src = readerFrameUrl(id);
  root.appendChild(frame);

  const h: Held = { id, root, frame, ready: false, opening: null, adopted: false, closeRequested: false, onReady: null, refresh: null, stop: () => {} };
  const sendInsets = () => {
    try {
      frame.contentWindow?.postMessage(parentMessage(measureInsets()), window.location.origin);
    } catch {
      /* cadre en train de partir */
    }
  };
  const onMessage = (event: MessageEvent) => {
    if (held !== h) return;
    const msg = acceptFromFrame(event, frame.contentWindow, window.location.origin);
    if (!msg || msg.book !== id) return;
    if (msg.kind === "hello") sendInsets();
    else if (msg.kind === "ready") {
      h.ready = true;
      h.onReady?.();
    } else if (msg.kind === "saved") h.refresh?.();
    else if (msg.kind === "close") {
      if (h.adopted) cinemaClose({ reading: false });
      else h.closeRequested = true;
    }
  };
  window.addEventListener("message", onMessage);
  window.addEventListener("resize", sendInsets);
  h.stop = () => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("resize", sendInsets);
  };
  document.body.appendChild(root);
  held = h;
  return h;
}

function release(): void {
  const h = held;
  if (!h) return;
  held = null;
  h.stop();
  finishOpening(h);
  h.root.remove();
}

/**
 * « Lire » depuis le cinéma : la couverture grandit pendant que le cadre se charge dessous, puis
 * l'adresse nomme le lecteur. Une fiche refermée pendant l'animation (Échap, Retour) l'emporte : le
 * cadre est retiré, rien n'est poussé.
 */
export async function openReaderFrame(id: string, cover: HTMLElement | null): Promise<void> {
  const opening = readerOpening(cover);
  const h = hold(id);
  h.opening = opening;
  await opening.catch(() => {});
  if (held !== h) return;
  const route = readCinemaRoute();
  if (h.closeRequested || route.book !== id) {
    release();
    return;
  }
  if (!route.reading) cinemaNavigate({ book: id, reading: true });
}

/** Rendu tant que l'adresse nomme le lecteur (`#livre=…&lire=1`) : montre le cadre, et le retire ensuite. */
export function ReaderFrame({ id }: { id: string }) {
  const t = useT();
  const { mutate } = useSWRConfig();
  const title = t("books.reader.frame");
  const titleRef = useRef(title);
  useEffect(() => {
    titleRef.current = title;
    if (held?.id === id) held.frame.title = title;
  }, [id, title]);

  useEffect(() => {
    const h = hold(id);
    h.adopted = true;
    h.frame.title = titleRef.current;
    // La position lue : la fiche (`/api/books/<id>`), l'accueil des livres et la grille ouverte par-dessus.
    const refresh = () => {
      void mutate("/api/books/home");
      void mutate(`/api/books/${id}`);
      window.dispatchEvent(new Event(BOOKS_PROGRESS_EVENT));
    };
    h.refresh = refresh;
    Object.assign(h.root.style, { opacity: "1", pointerEvents: "auto" });
    const reveal = () => {
      finishOpening(h);
      // Le clavier au lecteur : le document du cadre a déjà mis le focus sur sa page.
      try {
        h.frame.focus({ preventScroll: true });
      } catch {
        /* cadre parti */
      }
    };
    h.onReady = reveal;
    if (h.ready) reveal();
    const fallback = window.setTimeout(() => finishOpening(h), REVEAL_FALLBACK_MS);
    // Échap quand le focus est resté au cinéma (avant la première page) : la même fermeture. Dans le
    // cadre, c'est le lecteur qui l'entend, et qui demande `close` (ou referme d'abord son panneau).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      cinemaClose({ reading: false });
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(fallback);
      window.removeEventListener("keydown", onKey, true);
      h.onReady = null;
      h.refresh = null;
      if (held === h) release();
      refresh();
      window.setTimeout(refresh, SETTLE_REFRESH_MS);
      // Le focus revient à « Lire » de la fiche, qui se remonte au même rendu.
      let tries = 0;
      const focusRead = () => {
        const button = document.querySelector<HTMLElement>("[data-book-read]");
        if (button) button.focus({ preventScroll: true });
        else if (++tries < 10) requestAnimationFrame(focusRead);
      };
      requestAnimationFrame(focusRead);
    };
  }, [id, mutate]);

  return null;
}

export const __testing = { held: () => held, release };
