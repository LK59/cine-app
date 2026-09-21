"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { isChunkLoadError, recoverFromChunkError } from "@/lib/chunkError";
import { reportClientError } from "@/lib/reportClientError";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  /**
   * Un morceau de code manquant se recharge, il ne se réessaie pas.
   *
   * Webpack garde en mémoire la promesse rejetée du chunk absent : `reset()` redemande donc le
   * même nom disparu et échoue à l'identique. Voir `chunkError.ts` — le rechargement n'a lieu
   * qu'une fois par onglet, pour qu'un déploiement à moitié publié ne fasse pas clignoter l'écran
   * indéfiniment.
   */
  const stale = isChunkLoadError(error);
  useEffect(() => {
    console.error("[root error]", error);
    // Avant le rechargement : c'est la dernière chance d'en garder une trace.
    reportClientError(error, "boundary:racine");
    if (stale) recoverFromChunkError();
  }, [error, stale]);

  /**
   * Un `<div>`, pas un `<html>` : cet écran est rendu *dans* le layout racine, qui a déjà posé
   * `<html>` et `<body>`. Il en dessinait un second à l'intérieur du premier — un document
   * invalide que React signale à l'hydratation. Le cas où le layout lui-même tombe, et où il
   * faut bien fournir le document, est celui de `global-error.tsx`.
   */
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink text-white">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="rounded-full bg-red-500/10 p-5">
            <AlertTriangle size={40} className="text-red-400" />
          </div>
          <h1 className="text-xl font-semibold">Erreur inattendue</h1>
          <p className="max-w-xs text-sm text-slate-400">
            {error.message || "L'application a rencontré un problème."}
          </p>
          <button
            onClick={() => (stale ? window.location.reload() : reset())}
            className="btn btn-ghost mt-2 px-4 py-2"
          >
            <RefreshCw size={14} />
            Réessayer
          </button>
        </div>
    </div>
  );
}
