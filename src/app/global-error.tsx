"use client";

import { useEffect } from "react";
import { isChunkLoadError, recoverFromChunkError } from "@/lib/chunkError";
import { reportClientError } from "@/lib/reportClientError";

/**
 * Quand c'est le layout racine lui-même qui tombe.
 *
 * `app/error.tsx` est rendu *à l'intérieur* du layout : il ne peut rien pour une erreur des
 * fournisseurs (traduction, thème, SWR, lecture) qui l'entourent. Sans ce fichier, une telle
 * erreur laissait l'écran de Next en production — une page blanche, et rien au journal.
 *
 * Il remplace le document entier, d'où `<html>` et `<body>`. Et il ne dépend de rien : pas de
 * traduction, pas d'icônes, pas de feuille de style qu'on n'aurait pas — c'est précisément ce qui
 * vient de tomber qui les fournissait.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const stale = isChunkLoadError(error);
  useEffect(() => {
    reportClientError(error, "boundary:global");
    if (stale) recoverFromChunkError();
  }, [error, stale]);

  return (
    <html lang="fr">
      <body style={{ margin: 0, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#0a0a0c", color: "#fff", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, textAlign: "center", padding: 16 }}>
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Erreur inattendue</h1>
          <p style={{ maxWidth: 320, fontSize: 14, color: "#94a3b8", margin: 0 }}>
            L&apos;application a rencontré un problème.
          </p>
          <button
            onClick={() => (stale ? window.location.reload() : reset())}
            style={{ marginTop: 8, padding: "8px 16px", borderRadius: 8, border: "1px solid rgba(255,255,255,.2)", background: "transparent", color: "#fff", fontSize: 14 }}
          >
            Réessayer
          </button>
        </div>
      </body>
    </html>
  );
}
