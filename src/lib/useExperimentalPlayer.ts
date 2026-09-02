"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";

interface PreferencesPayload {
  experimentalPlayer?: { enabled: boolean; hdr: boolean };
}

/**
 * Whether this user opted into the experimental WebCodecs player, and whether it may handle HDR.
 *
 * Read from the same endpoint the settings page writes, so turning the option on takes effect on
 * the next playback without a reload. The server enforces both independently — this only decides
 * which player the UI mounts.
 */
export function useExperimentalPlayer(): { enabled: boolean; hdr: boolean } {
  const { data } = useSWR<PreferencesPayload>("/api/user/preferences", fetcher);
  return { enabled: data?.experimentalPlayer?.enabled ?? false, hdr: data?.experimentalPlayer?.hdr ?? false };
}
