"use client";

import useSWR, { mutate as globalMutate } from "swr";
import { fetcher, followOnlyOptions } from "@/lib/swr";

/**
 * Le défilement guidé de l'interface ordinateur : l'accueil se cale sur une rangée entière, une
 * fiche film ou série sur l'une de ses deux pages (`snap-y snap-mandatory`). Une préférence du
 * compte, réglée dans Compte → Affichage (demandé le 06/10/2026, DECISIONS.md §50) ; activé par
 * défaut.
 *
 * Rangée avec la langue dans les préférences du compte (`/api/user/preferences`). La clé est déjà
 * chargée au démarrage par `useLegacyPlayer`, toujours monté et porteur du chargeur : on la suit
 * sans la redemander (`followOnlyOptions` — voir le piège `revalidators[0]` de CLAUDE.md). Avant
 * sa réponse, la dernière valeur connue sur cet appareil, pour qu'un compte qui l'a coupé ne voie
 * pas l'accueil se caler une seconde au lancement.
 *
 * Coupé, rien d'autre ne change : la navigation au clavier fait défiler jusqu'au début de la rangée
 * ou de la page visée, ce qui tombe juste avec ou sans calage (`focusInOtherSection`, `useTvGridNav`).
 */
const KEY = "/api/user/preferences";
const LOCAL_MIRROR = "cine:guided-scroll";

/** À la déconnexion : le miroir est rangé par appareil, et le compte suivant l'aurait lu. */
export function forgetGuidedScrollMirror(): void {
  try {
    window.localStorage.removeItem(LOCAL_MIRROR);
  } catch {
    // Stockage refusé : il n'y a rien à oublier.
  }
}

function lastKnown(): boolean {
  try {
    return window.localStorage.getItem(LOCAL_MIRROR) !== "off";
  } catch {
    return true;
  }
}
function remember(on: boolean): void {
  try {
    window.localStorage.setItem(LOCAL_MIRROR, on ? "on" : "off");
  } catch {
    /* navigation privée : la valeur du compte suffit */
  }
}

export function useGuidedScroll(): boolean {
  const { data } = useSWR<{ guidedScroll?: boolean }>(KEY, fetcher, followOnlyOptions);
  if (typeof data?.guidedScroll === "boolean") return data.guidedScroll;
  return typeof window === "undefined" ? true : lastKnown();
}

/** Change la préférence du compte ; l'affichage suit tout de suite, le serveur confirme. */
export async function setGuidedScroll(on: boolean): Promise<void> {
  remember(on);
  await globalMutate(
    KEY,
    async (current?: Record<string, unknown>) => {
      const res = await fetch(KEY, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ guidedScroll: on }) });
      if (!res.ok) throw new Error(String(res.status));
      return { ...(current ?? {}), guidedScroll: on };
    },
    { optimisticData: (current?: Record<string, unknown>) => ({ ...(current ?? {}), guidedScroll: on }), rollbackOnError: true, revalidate: false },
  );
}

/** Les classes du conteneur qui défile — la seule façon de les écrire, pour les trois écrans. */
export function guidedScrollClass(on: boolean): string {
  return on ? "snap-y snap-mandatory" : "";
}
