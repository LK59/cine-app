"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[root error]", error);
  }, [error]);

  return (
    <html lang="fr" className="dark">
      <body className="flex min-h-screen items-center justify-center bg-slate-950 text-white">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="rounded-full bg-red-500/10 p-5">
            <AlertTriangle size={40} className="text-red-400" />
          </div>
          <h1 className="text-xl font-semibold">Erreur inattendue</h1>
          <p className="max-w-xs text-sm text-slate-400">
            {error.message || "L'application a rencontré un problème."}
          </p>
          <button
            onClick={reset}
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
