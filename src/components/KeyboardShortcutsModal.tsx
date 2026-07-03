"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Keyboard } from "lucide-react";

const SHORTCUTS = [
  { keys: ["⌘", "K"], label: "Recherche globale" },
  { keys: ["j"], label: "Item suivant (listes)" },
  { keys: ["k"], label: "Item précédent (listes)" },
  { keys: ["↵"], label: "Ouvrir l'item sélectionné" },
  { keys: ["?"], label: "Afficher cette aide" },
  { keys: ["Échap"], label: "Fermer la fenêtre / désélectionner" },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex items-center rounded bg-white/10 px-1.5 py-0.5 text-[11px] font-mono text-slate-300">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const tag = (document.activeElement as HTMLElement)?.tagName ?? "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if (e.key === "?") setOpen((v) => !v);
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!open) return null;

  return (
    <Modal title="Raccourcis clavier" onClose={() => setOpen(false)}>
      <div className="space-y-1">
        {SHORTCUTS.map(({ keys, label }) => (
          <div key={label} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
            <span className="text-sm text-slate-300">{label}</span>
            <div className="flex items-center gap-1">
              {keys.map((k) => <Kbd key={k}>{k}</Kbd>)}
            </div>
          </div>
        ))}
      </div>
      <p className="mt-4 text-center text-xs text-slate-600">
        <Keyboard size={11} className="inline mr-1" />
        Appuie sur <Kbd>?</Kbd> pour ouvrir / fermer
      </p>
    </Modal>
  );
}
