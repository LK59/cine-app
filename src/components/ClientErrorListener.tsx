"use client";

import { useEffect } from "react";
import { reportClientError } from "@/lib/reportClientError";

/**
 * Ce qu'aucune barrière React n'attrape : une erreur dans un gestionnaire d'événement, un
 * minuteur, un rappel de `MediaSource` — et les promesses rejetées que personne n'attendait.
 *
 * Les barrières ne voient que les erreurs de *rendu*. Tout le lecteur vit dans des rappels, là
 * où elles ne regardent pas ; sans ceci, ses erreurs n'allaient nulle part.
 */
export function ClientErrorListener() {
  useEffect(() => {
    const onError = (event: ErrorEvent) => reportClientError(event.error ?? event.message, "window");
    const onRejection = (event: PromiseRejectionEvent) => reportClientError(event.reason, "rejection");
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);
  return null;
}
