"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";

export function useRole() {
  const { data } = useSWR<{ role: "admin" | "guest"; username: string; jfId: string | null; jfUser: string | null }>(
    "/api/auth/me",
    fetcher
  );
  return {
    role: data?.role,
    // Defaults to true (most restrictive) while /api/auth/me hasn't resolved yet — the previous
    // default of false meant every guest briefly saw admin-only buttons (Ajouter, Supprimer,
    // Recherche interactive...) flash on-screen before disappearing on first paint. The server
    // never actually trusted this client state (proxy.ts blocks guest mutations regardless), but
    // showing privileged UI to an unconfirmed role is still the wrong default.
    isGuest: data === undefined || data.role === "guest",
    jfId: data?.jfId ?? null,
    jfUser: data?.jfUser ?? null,
  };
}
