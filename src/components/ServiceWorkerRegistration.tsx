"use client";

import { useEffect } from "react";
import { forgetChunkReload } from "@/lib/chunkError";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    // L'application s'est montée : la page est saine, et le drapeau qui empêche un deuxième
    // rechargement après un morceau de code manquant a fini son travail. Le laisser en place
    // priverait le prochain onglet périmé de son unique tentative — voir `chunkError.ts`.
    forgetChunkReload();
    if ("serviceWorker" in navigator) {
      // Le numéro du build dans l'adresse : chaque déploiement installe son propre worker, qui
      // range le code dans un cache à son nom et fait le ménage de l'avant-dernier. Voir sw.js.
      const build = encodeURIComponent(process.env.NEXT_PUBLIC_APP_BUILD ?? "dev");
      navigator.serviceWorker.register(`/sw.js?v=${build}`).catch(() => {});
    }
  }, []);

  return null;
}
