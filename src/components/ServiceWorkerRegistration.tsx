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
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
  }, []);

  return null;
}
