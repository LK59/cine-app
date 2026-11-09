"use client";

import { useCallback, useEffect, useRef } from "react";
import { APP_BUILD, APP_VERSION } from "@/lib/appBuild";

/**
 * Le relevé `kind: "xray-ui"` (DECISIONS.md §138, 10.29.1) — dans `startup.log`, par `/api/viewport-diag`, comme
 * `hauteur`, `retour` et `clavier`.
 *
 * Pourquoi : sur l'iPhone du propriétaire (application installée, iOS 26, 10.29.0), *Ted Lasso* S01E08, la scène de
 * 599 s (cinq personnes, la rangée déborde), toucher des acteurs a fait disparaître la rangée quelques secondes,
 * puis elle est revenue **vide** ; le panneau de Roy n'a pas paru — le serveur l'a vu monté puis refermé 2,4 s plus
 * tard, sans doute un panneau **invisible** refermé par un toucher sur son fond invisible. Rejoué sous jsdom avec
 * les vraies données, l'état est juste : ce qui manquait, c'est ce que l'écran *montrait*. Ces lignes le disent la
 * prochaine fois — la rangée (boîte, opacité, visibilité calculées), le toucher, le panneau 300 ms après son
 * ouverture (sa boîte, son opacité, et **ce qui est vraiment dessus en son centre**, `elementFromPoint`), et sa
 * fermeture (par quoi, au bout de combien).
 *
 * Bornes : un écran tactile seulement (le défaut a été vu là ; à la souris, rien ne part), douze lignes par séance
 * du lecteur (un élément), dont cinq au plus pour la rangée — elle change à chaque scène. Des mesures, l'élément et
 * des identifiants de personnes TMDB : rien de plus que ce que `startup.log` porte déjà.
 */
export const XRAY_UI_DIAG_MAX = 12;
/** La part de la rangée dans ces douze : elle se relève à chaque scène, les touchers doivent garder leur place. */
export const XRAY_UI_ROW_MAX = 5;
/** Le relevé du panneau : 300 ms après son montage, son entrée (`fade-in-side`, `slide-up`) jouée. */
export const XRAY_UI_PANEL_CHECK_MS = 300;

export type XrayUiEvent = "row" | "tap" | "open" | "close";
export type XrayUiDiagFn = (event: XrayUiEvent, fields: Record<string, unknown>) => void;

type Post = (body: Record<string, unknown>) => void;

function coarsePointer(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

const defaultPost: Post = (body) => {
  try {
    void fetch("/api/viewport-diag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* un relevé perdu ne coûte rien */
  }
};

/** Le relevé d'une séance : ses bornes, un identifiant court pour relier ses lignes. */
export function createXrayUiDiag(itemId: string, opts: { enabled?: boolean; post?: Post } = {}): { send: XrayUiDiagFn; sent: () => number } {
  const enabled = opts.enabled ?? coarsePointer();
  const post = opts.post ?? defaultPost;
  const session = Math.random().toString(36).slice(2, 8);
  let sent = 0;
  let rows = 0;
  return {
    send(event, fields) {
      if (!enabled || sent >= XRAY_UI_DIAG_MAX) return;
      if (event === "row") {
        if (rows >= XRAY_UI_ROW_MAX) return;
        rows += 1;
      }
      sent += 1;
      try {
        post({ kind: "xray-ui", event, itemId, session, seq: sent, ...fields, build: APP_BUILD, version: APP_VERSION });
      } catch {
        /* un relevé ne casse jamais le lecteur */
      }
    },
    sent: () => sent,
  };
}

/**
 * Le relevé de la séance du lecteur : une fonction stable, une séance neuve à chaque élément. Ne lit rien pendant
 * le rendu — la séance est posée dans un effet, lue à l'appel (un geste, un effet).
 */
export function useXrayUiDiag(itemId: string): XrayUiDiagFn {
  const current = useRef<{ send: XrayUiDiagFn } | null>(null);
  useEffect(() => {
    current.current = createXrayUiDiag(itemId);
    return () => {
      current.current = null;
    };
  }, [itemId]);
  return useCallback<XrayUiDiagFn>((event, fields) => {
    try {
      current.current?.send(event, fields);
    } catch {
      /* rien */
    }
  }, []);
}

/** Une boîte arrondie au pixel : `getBoundingClientRect`, `null` sans élément. */
export function boxOf(el: Element | null | undefined): { x: number; y: number; w: number; h: number } | null {
  if (!el) return null;
  try {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  } catch {
    return null;
  }
}

/** L'opacité et la visibilité **calculées** — ce que le moteur croit dessiner, pas ce que React a écrit. */
export function lookOf(el: Element | null | undefined): { opacity: number | null; visibility: string | null } {
  if (!el || typeof getComputedStyle !== "function") return { opacity: null, visibility: null };
  try {
    const s = getComputedStyle(el);
    const opacity = Number.parseFloat(s.opacity);
    return { opacity: Number.isFinite(opacity) ? Math.round(opacity * 100) / 100 : null, visibility: s.visibility || null };
  } catch {
    return { opacity: null, visibility: null };
  }
}

/**
 * Ce qui est vraiment dessus au centre d'un panneau : `panneau` (lui ou un de ses enfants), `fond` (son fond qui
 * referme au toucher — le panneau est alors sous autre chose, ou ailleurs), `rien`, ou l'élément trouvé (balise et
 * premier attribut `data-`).
 */
export function hitAt(doc: Document, box: { x: number; y: number; w: number; h: number } | null, panel: Element | null, backdrop: Element | null): string | null {
  if (!box || typeof doc.elementFromPoint !== "function") return null;
  try {
    const hit = doc.elementFromPoint(box.x + box.w / 2, box.y + box.h / 2);
    if (!hit) return "rien";
    if (panel && panel.contains(hit)) return "panneau";
    if (backdrop && hit === backdrop) return "fond";
    const data = Array.from(hit.attributes).find((a) => a.name.startsWith("data-"))?.name;
    return `${hit.tagName.toLowerCase()}${data ? `[${data}]` : ""}`.slice(0, 60);
  } catch {
    return null;
  }
}
