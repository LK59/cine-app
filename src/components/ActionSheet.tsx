"use client";

import { createPortal } from "react-dom";
import { useEffect, useState, type ReactNode } from "react";

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

export function ActionSheet({ open, onClose, title, subtitle, poster, actions }: Props) {
  const [mounted, setMounted] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const id = requestAnimationFrame(() => setShow(true));
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

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end" style={{ touchAction: "none" }}>
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/70 transition-opacity duration-300 ${show ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
      />

      {/* Sheet */}
      <div
        className={`relative w-full max-w-lg mx-auto rounded-t-2xl bg-slate-900 border-t border-white/10 shadow-2xl transition-transform duration-300 ease-out ${show ? "translate-y-0" : "translate-y-full"}`}
      >
        {/* Handle */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="h-1 w-10 rounded-full bg-white/20" />
        </div>

        {/* Card preview header */}
        {(poster || title) && (
          <div className="flex items-center gap-3 px-4 pb-3 border-b border-white/10">
            {poster && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={poster} alt="" className="h-16 w-11 shrink-0 rounded-lg object-cover" />
            )}
            <div className="min-w-0">
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
