"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePointerCapture } from "@/lib/usePointerCapture";

export interface SheetAction {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  variant?: "default" | "danger" | "accent";
  disabled?: boolean;
  /**
   * Intitulé du groupe auquel cette action appartient.
   *
   * Rendu une seule fois, au-dessus de la première action qui le porte : une feuille qui
   * enchaîne dix entrées de nature différente se lit comme une liste de courses. Les actions
   * sans intitulé restent en tête, sans en-tête au-dessus d'elles.
   */
  section?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  subtitle?: string;
  poster?: string | null;
  actions: SheetAction[];
}

const CLOSE_THRESHOLD = 80; // px dragged down to trigger close

export function ActionSheet({ open, onClose, title: liveTitle, subtitle: liveSubtitle, poster: livePoster, actions }: Props) {
  /**
   * L'en-tête reste celui de l'ouverture pendant la sortie.
   *
   * Les appelants remettent leur sélection à `null` en refermant, et la feuille reste montée
   * encore 300 ms pour glisser : elle perdait son titre et son affiche en partant, et rétrécissait
   * sous le doigt (23/09/2026). Ajusté pendant le rendu, la forme que le compilateur accepte.
   */
  const [header, setHeader] = useState({ title: liveTitle, subtitle: liveSubtitle, poster: livePoster });
  if (open && (header.title !== liveTitle || header.subtitle !== liveSubtitle || header.poster !== livePoster)) {
    setHeader({ title: liveTitle, subtitle: liveSubtitle, poster: livePoster });
  }
  const { title, subtitle, poster } = header;
  const [mounted, setMounted] = useState(false);
  const [show, setShow] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const currentY = useRef(0);
  const dragging = useRef(false);

  // Deliberately imperative (double-rAF entrance animation + exit-delay unmount) — do not
  // convert to a render-time state adjustment, see the rAF comment below for why the timing
  // must be effect-driven.
  useEffect(() => {
    if (open) {
      // Ce qu'une fermeture au doigt a écrit sur l'élément, effacé avant de rouvrir : la feuille
      // reste montée 300 ms pour sa sortie, et rouverte dans ce délai elle gardait
      // `translateY(100%)` en ligne, plus fort que `translate-y-0` — le fond s'affichait, pas
      // elle (23/09/2026). Même geste que la feuille « Plus » à son ouverture.
      const sheet = sheetRef.current;
      if (sheet) {
        sheet.style.transform = "";
        sheet.style.transition = "";
      }
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMounted(true);
      // A single rAF often fires before the browser has painted the initial
      // (hidden) state, so the transition has nothing to animate from and the
      // sheet just snaps open. Two nested rAFs guarantee that paint happened.
      const id = requestAnimationFrame(() => {
        requestAnimationFrame(() => setShow(true));
      });
      return () => cancelAnimationFrame(id);
    } else {
      setShow(false);
      const t = setTimeout(() => setMounted(false), 300);
      return () => clearTimeout(t);
    }
  }, [open]);

  /**
   * Le focus entre dans la feuille à son ouverture.
   *
   * Il restait sur ce qui l'avait ouverte, derrière : au clavier, Entrée rouvrait la carte sous le
   * menu et les flèches déplaçaient la grille (23/09/2026). La première action le reçoit ; la
   * feuille est un dialogue, et le dit.
   */
  useEffect(() => {
    if (!show) return;
    sheetRef.current?.querySelector<HTMLButtonElement>("button[data-sheet-action]:not(:disabled)")?.focus();
  }, [show]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // ── Swipe-to-close ────────────────────────────────────────────────────────

  // Voir `usePointerCapture` : rendue à la fin du geste, et au démontage.
  const capture = usePointerCapture();

  function dragStart(e: React.PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragging.current = true;
    startY.current = e.clientY;
    currentY.current = 0;
    capture.take(e);
    if (sheetRef.current) sheetRef.current.style.transition = "none";
  }

  function dragMove(e: React.PointerEvent) {
    if (!dragging.current) return;
    const delta = Math.max(0, e.clientY - startY.current);
    currentY.current = delta;
    if (sheetRef.current) sheetRef.current.style.transform = `translateY(${delta}px)`;
  }

  function dragEnd() {
    capture.release();
    if (!dragging.current) return;
    dragging.current = false;
    const el = sheetRef.current;
    if (!el) return;

    if (currentY.current >= CLOSE_THRESHOLD) {
      // Animate out then close
      el.style.transition = "transform 0.25s ease-out";
      el.style.transform = "translateY(100%)";
      setTimeout(onClose, 220);
    } else {
      // Snap back
      el.style.transition = "transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)";
      el.style.transform = "";
      setTimeout(() => { if (el) el.style.transition = ""; }, 300);
    }
    currentY.current = 0;
  }

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div data-action-sheet className="fixed inset-0 z-60 flex items-end" style={{ touchAction: "none" }}>
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/70 transition-opacity duration-300 ${show ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`glass-panel relative w-full max-w-lg mx-auto rounded-t-2xl border-x-0 border-b-0 shadow-glow transition-transform duration-300 ease-out ${show ? "translate-y-0" : "translate-y-full"}`}
      >
        {/* Drag handle — main swipe target */}
        <div
          className="flex justify-center pt-3 pb-2 cursor-grab active:cursor-grabbing touch-none select-none"
          onPointerDown={dragStart}
          onPointerMove={dragMove}
          onPointerUp={dragEnd}
          onPointerCancel={dragEnd}
        >
          <div className="h-1 w-10 rounded-full bg-white/20" />
        </div>

        {/* Card preview header — also draggable */}
        {(poster || title) && (
          <div
            className="flex items-center gap-3 px-4 pb-3 border-b border-white/10 cursor-grab active:cursor-grabbing touch-none select-none"
            onPointerDown={dragStart}
            onPointerMove={dragMove}
            onPointerUp={dragEnd}
            onPointerCancel={dragEnd}
          >
            {poster && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={poster} alt="" className="h-16 w-11 shrink-0 rounded-lg object-cover pointer-events-none" />
            )}
            <div className="min-w-0 pointer-events-none">
              {title && <p className="font-semibold text-white leading-tight truncate">{title}</p>}
              {subtitle && <p className="mt-0.5 text-sm text-slate-400 truncate">{subtitle}</p>}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="py-1.5">
          {actions.map((action, i) => (
            <div key={i}>
            {action.section && action.section !== actions[i - 1]?.section && (
              <p className="px-5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                {action.section}
              </p>
            )}
            <button
              data-sheet-action
              disabled={action.disabled}
              onClick={() => { action.onClick(); onClose(); }}
              className={`flex w-full items-center gap-4 px-5 py-3.5 text-sm font-medium transition-colors active:bg-white/5 disabled:opacity-40 ${
                action.variant === "danger"
                  ? "text-red-400"
                  : action.variant === "accent"
                  ? "text-accent-400"
                  : "text-slate-100"
              }`}
            >
              {action.icon && (
                <span className={`w-5 text-center ${
                  action.variant === "danger" ? "text-red-400" : "text-slate-400"
                }`}>
                  {action.icon}
                </span>
              )}
              {action.label}
            </button>
            </div>
          ))}
        </div>

        <div style={{ height: "max(env(safe-area-inset-bottom), 12px)" }} />
      </div>
    </div>,
    document.body
  );
}
