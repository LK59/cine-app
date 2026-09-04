"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";

interface PreferencesPayload {
  legacyPlayer?: { enabled: boolean };
}

/**
 * Whether this account has asked to go back to playback through the server.
 *
 * Answers `undefined` while it does not know yet, and the caller is expected to wait for it
 * rather than assume. Assuming was not free: the player that was assumed would mount, start —
 * which for the server-side one means negotiating a stream and warming a transcode — and then be
 * thrown away a round trip later when the answer arrived. One request, once per session, against
 * an abandoned transcode on every single playback.
 */
export function useLegacyPlayer(): { legacy: boolean | undefined } {
  const { data } = useSWR<PreferencesPayload>("/api/user/preferences", fetcher);
  return { legacy: data ? data.legacyPlayer?.enabled === true : undefined };
}
