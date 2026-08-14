"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Bell, BellOff, Loader2, CircleCheckBig, CircleX } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

type State = "unsupported" | "denied" | "unsubscribed" | "subscribed" | "loading";

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function getVapidKey(): Promise<string | null> {
  try {
    const res = await fetch("/api/push/vapid-key");
    if (!res.ok) return null;
    const { publicKey } = await res.json();
    return publicKey ?? null;
  } catch { return null; }
}

export function PushToggle() {
  const [state, setState] = useState<State>("loading");
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const swReg = useRef<ServiceWorkerRegistration | null>(null);
  const t = useT();

  const detect = useCallback(async () => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setState("unsupported"); return;
    }
    if (Notification.permission === "denied") { setState("denied"); return; }

    try {
      const reg = await navigator.serviceWorker.ready;
      swReg.current = reg;
      const existing = await reg.pushManager.getSubscription();
      if (existing) { setSub(existing); setState("subscribed"); }
      else setState("unsubscribed");
    } catch { setState("unsubscribed"); }
  }, []);

  // Browser push-capability/permission detection needs `navigator`/`Notification`, unavailable
  // during SSR — must run post-mount. State starts at the neutral "loading" placeholder, so the
  // synchronous branches here (unsupported/denied) can't cause an SSR/hydration mismatch.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { detect(); }, [detect]);

  const subscribe = useCallback(async () => {
    setState("loading");
    try {
      const vapidKey = await getVapidKey();
      if (!vapidKey) throw new Error("VAPID key unavailable");

      const permission = await Notification.requestPermission();
      if (permission !== "granted") { setState("denied"); return; }

      const reg = swReg.current ?? await navigator.serviceWorker.ready;
      swReg.current = reg;
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });

      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(subscription.toJSON()),
      });

      setSub(subscription);
      setState("subscribed");
    } catch { setState("unsubscribed"); }
  }, []);

  const unsubscribe = useCallback(async () => {
    setState("loading");
    try {
      if (sub) {
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setSub(null);
      setState("unsubscribed");
    } catch { setState("subscribed"); }
  }, [sub]);

  if (state === "unsupported") return (
    <div className="flex items-center gap-2 text-sm text-slate-500">
      <CircleX size={15} />
      {t('notifications.pushToggle.unsupported')}
    </div>
  );

  if (state === "denied") return (
    <div className="flex items-center gap-2 text-sm text-amber-400">
      <BellOff size={15} />
      {t('notifications.pushToggle.blocked')}
    </div>
  );

  if (state === "loading") return (
    <div className="flex items-center gap-2 text-sm text-slate-500">
      <Loader2 size={15} className="animate-spin" />
      {t('notifications.pushToggle.loading')}
    </div>
  );

  if (state === "subscribed") return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2 text-sm text-emerald-400">
        <CircleCheckBig size={15} />
        {t('notifications.pushToggle.enabled')}
      </div>
      <button
        onClick={unsubscribe}
        className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200 hover:bg-white/10 transition-colors"
      >
        <BellOff size={12} />
        {t('notifications.pushToggle.disable')}
      </button>
    </div>
  );

  return (
    <button
      onClick={subscribe}
      className="flex items-center gap-2 rounded-lg border border-accent-500/30 bg-accent-500/10 px-4 py-2 text-sm font-medium text-accent-400 hover:bg-accent-500/20 transition-colors"
    >
      <Bell size={15} />
      {t('notifications.pushToggle.enable')}
    </button>
  );
}
