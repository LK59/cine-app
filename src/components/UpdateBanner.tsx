"use client";

import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

const CHECK_INTERVAL = 60 * 60 * 1000; // 1h

export function UpdateBanner() {
  const [show, setShow] = useState(false);
  const t = useT();

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let cancelled = false;
    let cleanup = () => {};

    navigator.serviceWorker.ready.then((reg) => {
      if (cancelled) return;

      // Only a controller change *after* this page was already controlled by
      // a worker counts as a genuine update — the very first activation also
      // fires this event and isn't something the user needs to know about.
      const hadController = !!navigator.serviceWorker.controller;
      const onControllerChange = () => { if (hadController) setShow(true); };
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

      const check = () => reg.update().catch(() => {});
      check();
      const interval = setInterval(check, CHECK_INTERVAL);
      const onVisible = () => { if (document.visibilityState === "visible") check(); };
      document.addEventListener("visibilitychange", onVisible);

      cleanup = () => {
        navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
        clearInterval(interval);
        document.removeEventListener("visibilitychange", onVisible);
      };
    });

    return () => { cancelled = true; cleanup(); };
  }, []);

  if (!show) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-70 flex justify-center px-3 pointer-events-none" style={{ paddingTop: "max(env(safe-area-inset-top), 0.75rem)" }}>
      <div className="glass-panel pointer-events-auto flex items-center gap-3 rounded-full px-4 py-2 shadow-glow">
        <span className="text-xs text-slate-200">{t("common.updateAvailable")}</span>
        <button
          onClick={() => window.location.reload()}
          className="flex items-center gap-1 rounded-full bg-accent-600/80 px-3 py-1 text-xs font-medium text-white hover:bg-accent-600 transition-colors"
        >
          <RefreshCw size={12} /> {t("common.refresh")}
        </button>
        <button onClick={() => setShow(false)} className="text-slate-400 hover:text-slate-200">
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
