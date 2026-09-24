"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { usePlayback } from "@/components/PlaybackProvider";
import { isPublicPath } from "@/lib/publicPaths";
import { PRESENCE_EVERY_MS } from "@/lib/activity/presence";

/**
 * Dit au serveur, une fois par minute, que l'application est ouverte — et ce qui y joue.
 *
 * Pour la vue en direct de l'administrateur (« dans l'application », « en lecture », « absent »),
 * et rien d'autre : pas de position, pas d'écran visité. Un signal de plus au passage en
 * arrière-plan et au retour, pour que l'état change à l'instant plutôt qu'à la minute suivante.
 * Sur les pages publiques (connexion), rien : il n'y a personne à annoncer. Un refus (session
 * partie) arrête les signaux jusqu'au prochain changement de page.
 */
export function PresencePinger() {
  const pathname = usePathname();
  const signedInPage = !isPublicPath(pathname);
  const { session } = usePlayback();
  const playing = useRef<{ itemId: string; title: string } | null>(null);
  const sendRef = useRef<((visible?: boolean) => void) | null>(null);

  useEffect(() => {
    playing.current = session ? { itemId: session.itemId, title: session.title } : null;
    // Un film qui s'ouvre ou se ferme change l'état tout de suite, pas à la minute suivante.
    sendRef.current?.();
  }, [session]);

  useEffect(() => {
    if (!signedInPage) return;
    let refused = false;
    const send = (visible = document.visibilityState === "visible") => {
      if (refused) return;
      const body = JSON.stringify({ visible, itemId: playing.current?.itemId, title: playing.current?.title });
      // En partant (arrière-plan, page fermée), `sendBeacon` survit à la page là où un fetch est coupé.
      if (!visible && typeof navigator.sendBeacon === "function") {
        navigator.sendBeacon("/api/presence", new Blob([body], { type: "application/json" }));
        return;
      }
      fetch("/api/presence", { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true })
        .then((res) => {
          if (res.status === 401) refused = true;
        })
        .catch(() => {
          // Hors ligne : le signal suivant repartira.
        });
    };
    sendRef.current = send;
    send();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" || playing.current) send();
    }, PRESENCE_EVERY_MS);
    const onVisibility = () => send(document.visibilityState === "visible");
    const onHide = () => send(false);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);
    return () => {
      sendRef.current = null;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
    };
  }, [signedInPage]);

  return null;
}
