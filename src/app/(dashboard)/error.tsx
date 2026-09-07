"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { isChunkLoadError, recoverFromChunkError } from "@/lib/chunkError";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useT();
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
    console.error("[dashboard error]", error);
    if (stale) recoverFromChunkError();
  }, [error, stale]);

  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="mb-4 rounded-full bg-red-500/10 p-4">
        <AlertTriangle size={32} className="text-red-400" />
      </div>
      <h2 className="mb-2 text-lg font-semibold text-white">{t('errors.pageCrashed')}</h2>
      <p className="mb-6 max-w-sm text-sm text-slate-400">
        {error.message || t('errors.pageError')}
      </p>
      <button
        onClick={() => (stale ? window.location.reload() : reset())}
        className="btn-ghost flex items-center gap-2 px-4 py-2"
      >
        <RefreshCw size={14} />
        {t('errors.retry')}
      </button>
    </div>
  );
}
