"use client";

import { useEffect, useRef, useState } from "react";
import { EllipsisVertical } from "lucide-react";

/**
 * The actions a screen offers without putting them all in front of the viewer.
 *
 * The film page had seven buttons of identical weight in one row — play, mark watched, add,
 * trailer, auto-search, NFO, interactive search — so nothing was the obvious thing to do, which
 * is what a row of equal buttons always costs. Nobody designs that; it accumulates.
 *
 * One grammar for every such menu, the same one the player already uses: a round icon button,
 * a panel that opens from the corner it belongs to, dismissed by a click outside or Escape.
 */
export interface MoreMenuItem {
  label: string;
  icon: React.ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Marks the one entry that changes something irreversibly, so it reads as different. */
  tone?: "danger";
}

export function MoreMenu({ items, label }: { items: MoreMenuItem[]; label: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // Capture phase: a menu that closes only after the click it was dismissed by has already
    // reached whatever was underneath it is a menu that acts on things nobody meant to press.
    document.addEventListener("mousedown", away, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away, true);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`btn btn-ghost btn-icon ${open ? "btn-on" : ""}`}
      >
        <EllipsisVertical size={16} />
      </button>

      {open && (
        /* Ancré à gauche d'abord, à droite à partir du moment où il y a de la place.
           `right-0` accroche le bord droit du panneau au bord droit du bouton : il s'étend donc
           vers la gauche. Sur un téléphone, la rangée d'actions passe à la ligne et le bouton se
           retrouve tout à gauche — le panneau sortait de l'écran par ce côté, et la moitié des
           entrées devenait illisible. */
        <div className="menu-panel animate-fade-in-scale absolute left-0 top-full z-30 mt-2 w-56 origin-top-left overflow-hidden rounded-2xl py-1 sm:left-auto sm:right-0 sm:origin-top-right">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
              className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors disabled:opacity-45 ${
                item.tone === "danger" ? "text-red-300 hover:bg-red-500/10" : "text-slate-200 hover:bg-white/10"
              }`}
            >
              <span className="shrink-0 text-slate-500">{item.icon}</span>
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
