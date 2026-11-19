"use client";

import useSWR, { mutate as globalMutate } from "swr";
import { fetcher, followOnlyOptions } from "@/lib/swr";

/**
 * « Son par Lumen » — l'essai demux-son (19/11/2026), réservé aux administrateurs : le son que le
 * navigateur ne lit pas lui-même est lu par NOTRE lecteur de conteneur et décodé par notre FFmpeg
 * 7.1.5 (AC-3, E-AC3, DTS) au lieu de mediabunny (`RemuxOptions.audioChain`, audioDemux.ts).
 *
 * Une préférence du compte (`/api/user/preferences`, comme le défilement guidé), que la route ne
 * renvoie et n'accepte que pour un administrateur. Le lecteur la lit au moment d'ouvrir un film, hors
 * de React : un miroir par appareil, tenu à jour par le chargeur des préférences
 * (`useAccountPreferencesLoader`) et par l'interrupteur. Coupée — le cas de tout autre compte —,
 * rien ne change, à l'octet près.
 */
const KEY = "/api/user/preferences";
const LOCAL_MIRROR = "cine:lumen-audio";

export function forgetLumenAudioMirror(): void {
  try {
    window.localStorage.removeItem(LOCAL_MIRROR);
  } catch {
    // Stockage refusé : il n'y a rien à oublier.
  }
}

/** Ce que le compte a choisi, d'après la dernière réponse du serveur sur cet appareil. */
export function lumenAudioOn(): boolean {
  try {
    return window.localStorage.getItem(LOCAL_MIRROR) === "on";
  } catch {
    return false;
  }
}

/** Recopie la valeur du serveur ; absente (compte ordinaire), l'essai est coupé. */
export function rememberLumenAudio(on: boolean | undefined): void {
  try {
    // N'écrit que ce qui change : tout autre compte n'a jamais rien de rangé sous cette clé.
    if (lumenAudioOn() === !!on) return;
    if (on) window.localStorage.setItem(LOCAL_MIRROR, "on");
    else window.localStorage.removeItem(LOCAL_MIRROR);
  } catch {
    /* navigation privée : l'essai reste coupé */
  }
}

export function useLumenAudio(): boolean {
  const { data } = useSWR<{ lumenAudio?: boolean }>(KEY, fetcher, followOnlyOptions);
  if (typeof data?.lumenAudio === "boolean") return data.lumenAudio;
  return typeof window === "undefined" ? false : lumenAudioOn();
}

export async function setLumenAudio(on: boolean): Promise<void> {
  rememberLumenAudio(on);
  await globalMutate(
    KEY,
    async (current?: Record<string, unknown>) => {
      const res = await fetch(KEY, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lumenAudio: on }) });
      if (!res.ok) {
        rememberLumenAudio(!on);
        throw new Error(String(res.status));
      }
      return { ...(current ?? {}), lumenAudio: on };
    },
    { optimisticData: (current?: Record<string, unknown>) => ({ ...(current ?? {}), lumenAudio: on }), rollbackOnError: true, revalidate: false },
  );
}
