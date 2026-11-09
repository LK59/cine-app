"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { fetcher, followOnlyOptions } from "@/lib/swr";
import { isFireTv } from "@/lib/fireTv";
import { ageAt } from "@/lib/format";
import type { XrayPlayerPayload, XrayPlayerPerson, XrayPlayerScene, XrayPlayerStatus } from "@/lib/xray/scenes";
import type { XrayPersonFacts } from "@/lib/xray/person";

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

// ── La place de la rangée (10.27) ───────────────────────────────────────────────────────────────

/** L'écart gardé entre la rangée et ce qui l'arrête à droite (les boutons du centre, la pilule des outils). */
export const ONSCREEN_CENTER_GAP_PX = 16;
/** L'écart entre le bas de la rangée et le haut du bloc du titre. */
export const ONSCREEN_TITLE_GAP_PX = 10;

type Box = { left: number; top: number; right: number; bottom: number };

/** Deux boîtes partagent-elles une hauteur ? Strictement : se toucher par un bord n'est pas se chevaucher. */
const overlapsVertically = (a: Box, b: Box) => a.top < b.bottom && a.bottom > b.top;

/**
 * La largeur permise à la rangée (10.27.1, règle du propriétaire). 10.27.0 s'arrêtait avant les boutons du
 * centre dès qu'ils passaient à 16 px de sa hauteur — sur l'iPhone couché, ils étaient **au-dessus** d'elle,
 * sans la toucher, et la rangée finissait au tiers de l'écran, un seul nom coupé (« Hannah Waddingh… »).
 * Désormais, la rangée va **aussi loin que possible à droite** :
 * - 16 px avant le groupe du centre (−10 / lecture / +10), **seulement s'il chevauche sa hauteur** ;
 * - sinon, 16 px avant la pilule des outils (audio, sous-titres, épisodes…), si elle chevauche sa hauteur ;
 * - sinon, jusqu'au bord sûr de droite (`null` : la largeur entière du conteneur, déjà rentré des zones sûres).
 * `row` est la ligne des pilules (pas l'étiquette au-dessus, courte et collée à gauche).
 */
export function onScreenRowWidth(row: Box, obstacles: { center?: Box | null; tools?: Box | null }): number | null {
  const stop = [obstacles.center, obstacles.tools].find((b): b is Box => !!b && b.right > b.left && overlapsVertically(row, b));
  if (!stop) return null;
  return Math.max(0, Math.floor(stop.left - ONSCREEN_CENTER_GAP_PX - row.left));
}

/** Le bas de la rangée, en px depuis le bas des commandes : juste au-dessus du bloc du titre. */
export function onScreenRowBottom(chrome: Box, titleRow: Box): number {
  return Math.max(0, Math.round(chrome.bottom - titleRow.top + ONSCREEN_TITLE_GAP_PX));
}

// ── Le panneau d'une personne (10.27) ───────────────────────────────────────────────────────────

/** Deux propositions au plus dans le panneau d'une personne (10.29.2). */
export const PERSON_QUESTIONS_MAX = 2;

/**
 * Les questions proposées pour une personne touchée (décision du propriétaire, 10.29.2) : **seulement son lien**
 * avec un autre personnage vraiment présent dans la même scène d'« À l'écran » — le plus présent d'abord (temps à
 * l'écran), puis un second s'il en existe un autre, deux au plus. « Qu'est-il arrivé à X récemment ? » et « Que
 * cherche X ? » sont retirées (« Jusqu'ici » dit déjà le récent), comme le champ libre du panneau d'une personne.
 * Par le prénom du personnage ; deux personnages au même prénom ne font qu'une proposition. Personne d'autre dans
 * la scène : `[]` (aucune proposition). Sans personnage : `undefined`.
 */
export function personQuestions(
  person: Pick<XrayPlayerPerson, "personId" | "character">,
  scene: readonly (Pick<XrayPlayerPerson, "personId" | "character"> & { screenTime?: number | null })[],
  t: (key: string, vars?: Record<string, string | number>) => string
): string[] | undefined {
  const name = characterFirstName(person.character);
  if (!name) return undefined;
  const others: string[] = [];
  // Tri stable : à temps égal, l'ordre de la scène.
  const byTime = [...scene].sort((a, b) => (b.screenTime ?? 0) - (a.screenTime ?? 0));
  for (const p of byTime) {
    if (p.personId === person.personId) continue;
    const other = characterFirstName(p.character);
    if (!other || other === name || others.includes(other)) continue;
    others.push(other);
    if (others.length >= PERSON_QUESTIONS_MAX) break;
  }
  return others.map((other) => t("xray.qLink", { name, other }));
}

let regionCodes: Map<string, string> | null = null;
const REGION_ALIASES: Record<string, string> = {
  usa: "US",
  "u.s.a.": "US",
  "u.s.": "US",
  us: "US",
  "united states of america": "US",
  uk: "GB",
  "u.k.": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
  "northern ireland": "GB",
  "great britain": "GB",
  "west germany": "DE",
  "east germany": "DE",
  "south korea": "KR",
  "czech republic": "CZ",
  russia: "RU",
  "soviet union": "RU",
  ussr: "RU",
};

/** Le code d'un pays écrit en anglais par TMDB (« UK », « France », « USA »), ou `null`. */
function regionCodeOf(name: string): string | null {
  const key = name.trim().toLowerCase().replace(/\s+/g, " ");
  if (REGION_ALIASES[key]) return REGION_ALIASES[key];
  if (!regionCodes) {
    regionCodes = new Map();
    try {
      const names = new Intl.DisplayNames(["en"], { type: "region" });
      for (let a = 65; a <= 90; a++) {
        for (let b = 65; b <= 90; b++) {
          const code = String.fromCharCode(a, b);
          const label = names.of(code);
          if (label && label !== code) regionCodes.set(label.toLowerCase(), code);
        }
      }
    } catch {
      /* sans Intl.DisplayNames, le lieu reste tel que TMDB l'écrit */
    }
  }
  return regionCodes.get(key) ?? null;
}

/**
 * Le lieu de naissance, court et dans la langue de qui lit : la ville (telle que TMDB l'écrit) et le pays
 * traduit — « London, England, UK » → « London, Royaume-Uni ». Un pays inconnu reste tel quel.
 */
export function compactPlace(place: string | null | undefined, locale: string): string | null {
  const parts = (place ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const country = parts[parts.length - 1];
  const code = regionCodeOf(country);
  let localized = country;
  if (code) {
    try {
      localized = new Intl.DisplayNames([locale], { type: "region" }).of(code) ?? country;
    } catch {
      localized = country;
    }
  }
  return parts.length === 1 ? localized : `${parts[0]}, ${localized}`;
}

/** La ligne courte sous l'en-tête : « 50 ans · London, Royaume-Uni ». */
export function personFactsLine(
  facts: { birthday?: string | null; deathday?: string | null; placeOfBirth?: string | null },
  locale: string,
  t: (key: string, vars?: Record<string, string | number>) => string,
  now: number
): string | null {
  const age = facts.birthday ? ageAt(facts.birthday, facts.deathday ?? null, now) : null;
  const parts = [
    age === null ? null : facts.deathday ? t("xray.diedAt", { n: age }) : t("modals.actor.age", { n: age }),
    compactPlace(facts.placeOfBirth, locale),
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join(" · ") : null;
}

const factsAsked = new Map<string, Promise<XrayPersonFacts>>();

/**
 * Oublier les faits lus par cette page (10.28.1) — à la sortie d'un compte (`forgetAccountOnDevice`) : ils
 * portent « Dans votre bibliothèque », rangé par compte (tags bloqués), et un compte de lien n'en a pas.
 */
export function forgetPersonFacts(): void {
  factsAsked.clear();
}

/**
 * Ce que le panneau d'une personne montre sans le modèle (âge, lieu, courte biographie, ses titres dans la
 * bibliothèque) — une requête par personne et par élément, gardée pour la page. Un `fetch` direct : SWR est
 * en pause pendant un film (CLAUDE.md).
 */
export function usePersonFacts(itemId: string, personId: number): XrayPersonFacts | null {
  const key = `${itemId}:${personId}`;
  const [held, setHeld] = useState<{ key: string; facts: XrayPersonFacts } | null>(null);
  useEffect(() => {
    let alive = true;
    let asked = factsAsked.get(key);
    if (!asked) {
      asked = fetch(`/api/player/xray/${encodeURIComponent(itemId)}?person=${personId}`, { cache: "no-store" })
        .then((res) => (res.ok ? (res.json() as Promise<XrayPersonFacts>) : { status: "none" as const }))
        .catch(() => ({ status: "none" as const }));
      // Un échec n'est pas gardé : la prochaine ouverture réessaiera.
      void asked.then((f) => {
        if (f.status !== "ok") factsAsked.delete(key);
      });
      factsAsked.set(key, asked);
      if (factsAsked.size > 200) factsAsked.delete(factsAsked.keys().next().value as string);
    }
    void asked.then((facts) => {
      if (alive) setHeld({ key, facts });
    });
    return () => {
      alive = false;
    };
  }, [key, itemId, personId]);
  return held?.key === key ? held.facts : null;
}
