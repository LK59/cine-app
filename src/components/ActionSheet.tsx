"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ReactNode } from "react";

export interface SheetAction {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  variant?: "default" | "danger" | "accent";
  disabled?: boolean;
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

export function ActionSheet({ open, onClose, title, subtitle, poster, actions }: Props) {
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // ── Swipe-to-close ────────────────────────────────────────────────────────

  function dragStart(e: React.PointerEvent) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragging.current = true;
    startY.current = e.clientY;
    currentY.current = 0;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (sheetRef.current) sheetRef.current.style.transition = "none";
  }

  function dragMove(e: React.PointerEvent) {
    if (!dragging.current) return;
    const delta = Math.max(0, e.clientY - startY.current);
    currentY.current = delta;
    if (sheetRef.current) sheetRef.current.style.transform = `translateY(${delta}px)`;
  }

  function dragEnd() {
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
    <div className="fixed inset-0 z-60 flex items-end" style={{ touchAction: "none" }}>
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/70 transition-opacity duration-300 ${show ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
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
            <button
              key={i}
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
          ))}
        </div>

        <div style={{ height: "max(env(safe-area-inset-bottom), 12px)" }} />
      </div>
    </div>,
    document.body
  );
}
