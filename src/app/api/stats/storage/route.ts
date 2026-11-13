import { NextRequest } from "next/server";
import { getStorageStats, type StorageStats } from "@/lib/storage-scan";
import { cachedJson } from "@/lib/cachedJson";

export type { StorageStats };

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const forceRefresh = req.nextUrl.searchParams.get("refresh") === "1";
  // Étiquette et compression (13/11/2026) : l'analyse pèse 1,15 Mo de JSON sur la vraie
  // bibliothèque (listes de seeds, de cross-seed, de doublons), partis en clair toutes les deux
  // minutes tant que la page reste ouverte — relevé dans le journal du proxy, « Length 1151140 ».
  // Elle ne change qu'à chaque analyse (30 min) : une relecture inchangée coûte un 304.
  return cachedJson(req, "stats:storage", getStorageStats(forceRefresh));
}
