"use client";

import { useEffect } from "react";
import { forgetChunkReload } from "@/lib/chunkError";
import { APP_BUILD } from "@/lib/appBuild";
import { clearDeliveredNotifications } from "@/lib/clearDeliveredNotifications";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    // L'application s'est montée : la page est saine, et le drapeau qui empêche un deuxième
    // rechargement après un morceau de code manquant a fini son travail. Le laisser en place
    // priverait le prochain onglet périmé de son unique tentative — voir `chunkError.ts`.
    forgetChunkReload();
    if ("serviceWorker" in navigator) {
      // Le numéro du build dans l'adresse : chaque déploiement installe son propre worker, qui
      // range le code dans un cache à son nom et fait le ménage de l'avant-dernier. Voir sw.js.
      const build = encodeURIComponent(APP_BUILD);
      navigator.serviceWorker.register(`/sw.js?v=${build}`).catch(() => {});
    }
  }, []);

  // À l'ouverture et à chaque retour au premier plan : la pastille et les notifications affichées
  // sont lues — voir `clearDeliveredNotifications`.
  useEffect(() => {
    void clearDeliveredNotifications();
    const onVisible = () => {
      if (document.visibilityState === "visible") void clearDeliveredNotifications();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  return null;
}
