"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { fetcher, followOnlyOptions } from "@/lib/swr";
import { isFireTv } from "@/lib/fireTv";
import type { XrayPlayerPayload, XrayPlayerPerson, XrayPlayerScene, XrayPlayerStatus } from "@/lib/xray/scenes";

/**
 * Les acteurs à l'écran côté lecteur (DECISIONS.md §138) : la rangée « À l'écran », film en pause.
 *
 * **Une lecture par élément, gardée en mémoire ; rien à la pause.** Les scènes sont demandées une fois à
 * l'ouverture d'un élément (`/api/player/xray/{id}`), redemandées toutes les minutes tant que l'analyse
 * est en file ou en cours (vingt minutes au plus, jamais page cachée), puis la scène de l'instant se
 * cherche ici, sans réseau, à chaque pause ou saut.
 *
 * **Seulement l'option allumée pour ce compte** (`xrayAvailable` de la configuration publique, **suivie,
 * jamais demandée** — comme « Poser une question ») : sans elle, aucune requête de plus à l'ouverture d'un
 * film, et les empreintes du lecteur (qui enregistrent chaque requête) ne changent pas.
 *
 * **Pas sur Fire TV** (§71) : une rangée qui défile de côté, sous le curseur de Silk ou à la télécommande,
 * demanderait un parcours au focus propre (entrer, défiler, sortir vers la barre) que rien ici ne porte ;
 * et la pilule qu'elle ouvre (« Poser une question ») n'y est pas non plus.
 */

/** L'intervalle des relectures pendant l'analyse, et leur durée au plus depuis l'ouverture. */
export const XRAY_POLL_MS = 60_000;
export const XRAY_POLL_WINDOW_MS = 20 * 60_000;

/**
 * Faut-il relire, et quand ? `queued` / `running` : l'analyse avance, encore une minute. `unavailable` (le
 * service ou le réseau ne répond pas) : retenté de même, dans la même fenêtre. Tout le reste est un état
 * final pour cette ouverture : `done`, `off`, `none`, `failed`, `stale`.
 */
export function xrayNextPoll(status: XrayPlayerStatus, elapsedMs: number): number | null {
  if (status !== "queued" && status !== "running" && status !== "unavailable") return null;
  if (elapsedMs + XRAY_POLL_MS > XRAY_POLL_WINDOW_MS) return null;
  return XRAY_POLL_MS;
}

/** La scène qui contient l'instant `t` (secondes) — début compris, fin exclue ; `null` hors de toute scène. */
export function sceneAt(payload: Pick<XrayPlayerPayload, "scenes"> | null | undefined, t: number): XrayPlayerScene | null {
  if (!payload || !Number.isFinite(t)) return null;
  for (const scene of payload.scenes) {
    if (t >= scene.start && t < scene.end) return scene;
  }
  return null;
}

/**
 * Les personnes à montrer pour une scène : seulement celles qui ont un nom (un visage reconnu ailleurs dans
 * la série, absent de la distribution de cet épisode, reste sans nom — on ne le montre pas), une fois
 * chacune, par temps à l'écran décroissant (puis par confiance).
 */
export function onScreenPeople(scene: XrayPlayerScene | null): XrayPlayerPerson[] {
  if (!scene) return [];
  const seen = new Set<number>();
  return scene.people
    .filter((p) => {
      if (!p.name || seen.has(p.personId)) return false;
      seen.add(p.personId);
      return true;
    })
    .sort((a, b) => b.screenTime - a.screenTime || b.confidence - a.confidence);
}

/**
 * Le prénom du personnage, pour « Qui est … ? » : le premier mot qui n'est pas un titre abrégé (« Dr. »,
 * « M. »), sans ce qui suit une barre ou une parenthèse (« Jack / le narrateur », « Rose (jeune) »).
 */
export function characterFirstName(character: string | null | undefined): string | null {
  if (!character) return null;
  const main = character.split(/[/(]/)[0].trim();
  const words = main.split(/\s+/).filter(Boolean);
  const word = words.find((w) => !/\.$/.test(w) && w.length > 1) ?? words[0];
  return word ? word.replace(/[,;:]+$/, "") : null;
}

/** Les initiales d'un nom, pour une photo absente ou qui ne charge pas. */
export function initialsOf(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.split(/\s+/).filter(Boolean);
  const letters = (parts.length > 1 ? [parts[0], parts[parts.length - 1]] : parts).map((p) => p[0]?.toUpperCase() ?? "");
  return letters.join("") || "?";
}

/** L'option, pour ce compte et cet appareil. */
export function useXrayAvailable(): boolean {
  const { data } = useSWR<{ xrayAvailable?: boolean }>("/api/config/public", fetcher, followOnlyOptions);
  return data?.xrayAvailable === true && !isFireTv();
}

/**
 * Les scènes de l'élément, lues à l'ouverture et relues pendant l'analyse (`xrayNextPoll`). Page cachée,
 * la relecture attend le retour. Un autre élément (épisode suivant) recommence tout ; `null` tant que rien
 * n'est lu pour celui-ci.
 */
export function useXrayScenes(itemId: string | null | undefined, enabled: boolean): XrayPlayerPayload | null {
  const [held, setHeld] = useState<{ itemId: string; payload: XrayPlayerPayload } | null>(null);
  useEffect(() => {
    if (!enabled || !itemId) return;
    const doc = document;
    const controller = new AbortController();
    const openedAt = Date.now();
    let timer: number | undefined;
    let waitingVisible = false;
    let stopped = false;
    const run = async () => {
      timer = undefined;
      if (stopped) return;
      if (doc.visibilityState === "hidden") {
        waitingVisible = true;
        return;
      }
      let payload: XrayPlayerPayload | null = null;
      try {
        const res = await fetch(`/api/player/xray/${encodeURIComponent(itemId)}`, { cache: "no-store", signal: controller.signal });
        if (res.ok) payload = (await res.json()) as XrayPlayerPayload;
      } catch {
        payload = null;
      }
      if (stopped) return;
      if (payload && Array.isArray(payload.scenes)) setHeld({ itemId, payload });
      const next = xrayNextPoll(payload?.status ?? "unavailable", Date.now() - openedAt);
      if (next !== null) timer = window.setTimeout(() => void run(), next);
    };
    const onVisibility = () => {
      if (waitingVisible && doc.visibilityState === "visible") {
        waitingVisible = false;
        void run();
      }
    };
    doc.addEventListener("visibilitychange", onVisibility);
    void run();
    return () => {
      stopped = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
      doc.removeEventListener("visibilitychange", onVisibility);
    };
  }, [itemId, enabled]);
  return held && held.itemId === itemId && enabled ? held.payload : null;
}
