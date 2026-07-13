"use client";

import { useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Keyboard } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-flex items-center rounded bg-white/10 px-1.5 py-0.5 text-[11px] font-mono text-slate-300">
      {children}
    </kbd>
  );
}

export function KeyboardShortcutsModal() {
  const [open, setOpen] = useState(false);
  const t = useT();

  const SHORTCUTS = [
    { keys: ["⌘", "K"], label: t('shortcuts.globalSearch') },
    { keys: ["j"],       label: t('shortcuts.nextItem') },
    { keys: ["k"],       label: t('shortcuts.prevItem') },
    { keys: ["↵"],       label: t('shortcuts.openItem') },
    { keys: ["f"],       label: t('shortcuts.toggleList') },
    { keys: ["1"],       label: t('shortcuts.tabInfo') },
    { keys: ["2"],       label: t('shortcuts.tabCast') },
    { keys: ["3"],       label: t('shortcuts.tabFile') },
    { keys: ["?"],       label: t('shortcuts.showHelp') },
    { keys: ["Échap"],   label: t('shortcuts.close') },
  ];

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
    <Modal title={t('shortcuts.title')} onClose={() => setOpen(false)}>
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
        {t('shortcuts.hint', { key: '?' })}
      </p>
    </Modal>
  );
}
