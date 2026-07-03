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
    isGuest: data?.role === "guest",
    jfId: data?.jfId ?? null,
    jfUser: data?.jfUser ?? null,
  };
}
