"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { isChunkLoadError, recoverFromChunkError } from "@/lib/chunkError";

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
    if (stale) recoverFromChunkError();
  }, [error, stale]);

  return (
    <html lang="fr" className="dark">
      <body className="flex min-h-screen items-center justify-center bg-ink text-white">
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
      </body>
    </html>
  );
}
