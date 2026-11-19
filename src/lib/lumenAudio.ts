"use client";

import useSWR, { mutate as globalMutate } from "swr";
import { fetcher, followOnlyOptions } from "@/lib/swr";

/**
 * « Son par Lumen » (DECISIONS.md §197) : le son que le navigateur ne lit pas lui-même est lu par NOTRE
 * lecteur de conteneur et décodé par notre FFmpeg 7.1.5 (AC-3, E-AC3, DTS) au lieu de mediabunny
 * (`RemuxOptions.audioChain`, audioDemux.ts).
 *
 * **Allumé pour tout le monde depuis 10.63.0** (étape 2). Seul un administrateur peut le couper pour
 * son compte, pour comparer avec mediabunny : une préférence du compte (`/api/user/preferences`), que
 * la route ne renvoie et n'accepte que pour lui. Le lecteur la lit au moment d'ouvrir un film, hors de
 * React : un miroir par appareil qui ne contient rien d'ordinaire, et « off » pour un compte qui l'a
 * coupé — tenu à jour par le chargeur des préférences (`useAccountPreferencesLoader`) et l'interrupteur.
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

/** Allumé, sauf pour un administrateur qui l'a coupé sur ce compte (miroir « off »). */
export function lumenAudioOn(): boolean {
  try {
    return window.localStorage.getItem(LOCAL_MIRROR) !== "off";
  } catch {
    return true;
  }
}

/** Recopie la valeur du serveur ; absente (tout compte qui n'est pas administrateur), c'est allumé. */
export function rememberLumenAudio(on: boolean | undefined): void {
  try {
    // N'écrit que ce qui change : un compte qui ne l'a jamais coupé n'a rien sous cette clé.
    const want = on !== false;
    if (lumenAudioOn() === want) return;
    if (want) window.localStorage.removeItem(LOCAL_MIRROR);
    else window.localStorage.setItem(LOCAL_MIRROR, "off");
  } catch {
    /* navigation privée : allumé, le défaut */
  }
}

export function useLumenAudio(): boolean {
  const { data } = useSWR<{ lumenAudio?: boolean }>(KEY, fetcher, followOnlyOptions);
  if (typeof data?.lumenAudio === "boolean") return data.lumenAudio;
  return typeof window === "undefined" ? true : lumenAudioOn();
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
