"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";

export function useRole() {
  // `share` : un lien de partage (DECISIONS.md §112). Il n'est pas administrateur, donc en lecture
  // seule comme `user` — et la porte des liens (`share/gate.ts`) restreint bien davantage au serveur.
  const { data } = useSWR<{ role: "admin" | "user" | "share"; username: string; jfId: string | null; jfUser: string | null }>(
    "/api/auth/me",
    fetcher
  );
  return {
    role: data?.role,
    // « En lecture seule » plutôt que « invité » : ce n'est pas une identité de second rang,
    // c'est un mode. Il n'y a que deux rôles, `user` et `admin`, et tout ce qui n'est pas
    // administrateur consulte.
    //
    // Vrai par défaut (le plus restrictif) tant que /api/auth/me n'a pas répondu : avec `false`,
    // chaque utilisateur voyait apparaître puis disparaître les boutons d'administration
    // (Ajouter, Supprimer, Recherche interactive…) au premier rendu. Le serveur n'a jamais fait
    // confiance à cet état client — `proxy.ts` bloque les écritures de toute façon — mais montrer
    // une interface privilégiée à un rôle non confirmé reste le mauvais réglage par défaut.
    isReadOnly: data === undefined || data.role !== "admin",
    jfId: data?.jfId ?? null,
    jfUser: data?.jfUser ?? null,
  };
}
