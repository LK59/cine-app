import useSWR from "swr";
import { fetcher } from "@/lib/swr";

// Reads the same runtime (not build-time baked-in) config endpoint already
// used for the default locale — one shared SWR cache entry, no extra request.
export function usePlayerEnabled(): boolean {
  const { data } = useSWR<{ playerEnabled: boolean }>("/api/config/public", fetcher);
  return data?.playerEnabled ?? false;
}
