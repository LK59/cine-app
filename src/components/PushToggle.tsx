"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Bell, BellOff, Loader2, CircleCheckBig, CircleX } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { apiAction } from "@/lib/apiAction";

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
  const toast = useToast();

  const detect = useCallback(async () => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      setState("unsupported"); return;
    }
    if (Notification.permission === "denied") { setState("denied"); return; }

    try {
      const reg = await navigator.serviceWorker.ready;
      swReg.current = reg;
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        setSub(existing);
        setState("subscribed");
        /**
         * Redire au serveur l'abonnement que ce navigateur a réellement.
         *
         * `pushsubscriptionchange` est censé s'en charger, et le service worker l'écoute — mais
         * l'événement n'est pas fiable partout, iOS en particulier ne le déclenche pas toujours
         * quand il renouvelle un abonnement. Quand il manque, le serveur reste sur un point de
         * terminaison mort qu'il supprimera au premier 410, et les notifications s'arrêtent sans
         * que rien ne l'indique : l'interrupteur, lui, dit toujours « activé ».
         *
         * L'écriture est idempotente (`pushDb.upsert` est indexé sur le point de terminaison), ne
         * coûte qu'un appel à l'ouverture du panneau, et ne fait rien de visible si elle échoue.
         */
        // Dans son propre `try` : c'est un rattrapage, il n'a pas le droit de décider de ce que
        // l'interrupteur affiche. Sans ça, un abonnement que le navigateur décrit autrement que
        // prévu faisait tomber la détection dans son `catch` — et un abonnement bien vivant
        // s'affichait « désactivé ».
        try {
          void apiAction("/api/push/subscribe", {
            method: "POST",
            body: JSON.stringify(existing.toJSON()),
          }).catch(() => {});
        } catch {
          // Best effort, et rien de plus.
        }
      } else setState("unsubscribed");
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

      // Si le serveur refuse l'abonnement, le navigateur en garde un que personne n'écoute :
      // on annule le sien pour que l'interrupteur et la réalité restent d'accord.
      try {
        await apiAction("/api/push/subscribe", {
          method: "POST",
          body: JSON.stringify(subscription.toJSON()),
        });
      } catch (error) {
        await subscription.unsubscribe().catch(() => {});
        throw error;
      }

      setSub(subscription);
      setState("subscribed");
    } catch (error) {
      setState("unsubscribed");
      toast.error(error instanceof Error ? error.message : t('common.error'));
    }
  }, [toast, t]);

  const unsubscribe = useCallback(async () => {
    setState("loading");
    try {
      if (sub) {
        await apiAction("/api/push/subscribe", {
          method: "DELETE",
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setSub(null);
      setState("unsubscribed");
    } catch (error) {
      setState("subscribed");
      toast.error(error instanceof Error ? error.message : t('common.error'));
    }
  }, [sub, toast, t]);

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
        className="btn btn-ghost btn-sm"
      >
        <BellOff size={12} />
        {t('notifications.pushToggle.disable')}
      </button>
    </div>
  );

  return (
    <button
      onClick={subscribe}
      className="btn btn-primary px-4 py-2"
    >
      <Bell size={15} />
      {t('notifications.pushToggle.enable')}
    </button>
  );
}
