"use client";

import { useEffect, useState } from "react";
import { Share, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

const DISMISS_KEY = "cine-install-prompt-dismissed-until";
const SNOOZE_DAYS = 21;
const SHOW_DELAY_MS = 4000;

function isIosSafariBrowserTab(): boolean {
  const ua = window.navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && "ontouchend" in document);
  if (!isIos) return false;
  const isStandalone =
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  return !isStandalone;
}

// Discreet nudge for iOS: Safari has no beforeinstallprompt event, so the only
// way to "install" is Share -> Add to Home Screen, which we can't trigger
// programmatically — we just have to explain it once in a dismissible way.
// This matters because iOS only allows Web Push for home-screen-installed PWAs.
export function InstallPrompt() {
  const t = useT();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!isIosSafariBrowserTab()) return;
    try {
      const dismissedUntil = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
      if (Date.now() < dismissedUntil) return;
    } catch {}

    const timer = setTimeout(() => setShow(true), SHOW_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  function dismiss() {
    setShow(false);
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now() + SNOOZE_DAYS * 86400000));
    } catch {}
  }

  if (!show) return null;

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-60 flex justify-center px-3 pb-3 pointer-events-none"
      style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)" }}
    >
      <div className="glass-panel pointer-events-auto flex max-w-sm items-start gap-3 rounded-2xl px-4 py-3 shadow-glow">
        <Share size={16} className="mt-0.5 shrink-0 text-accent-400" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-white">{t("common.installPrompt.title")}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{t("common.installPrompt.body")}</p>
          <p className="mt-1 text-[11px] leading-snug text-slate-500">{t("common.installPrompt.steps")}</p>
        </div>
        <button onClick={dismiss} className="shrink-0 text-slate-500 hover:text-slate-200">
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
