"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[dashboard error]", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <div className="mb-4 rounded-full bg-red-500/10 p-4">
        <AlertTriangle size={32} className="text-red-400" />
      </div>
      <h2 className="mb-2 text-lg font-semibold text-white">Une erreur est survenue</h2>
      <p className="mb-6 max-w-sm text-sm text-slate-400">
        {error.message || "Quelque chose s'est mal passé sur cette page."}
      </p>
      <button onClick={reset} className="btn-ghost flex items-center gap-2 px-4 py-2">
        <RefreshCw size={14} />
        Réessayer
      </button>
    </div>
  );
}
