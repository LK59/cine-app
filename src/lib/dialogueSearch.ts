"use client";

import { useEffect, useState } from "react";
import { normalizedText } from "@/lib/repliques/text";
import type { DialogueFilm } from "@/lib/repliques/search";

/**
 * La recherche de répliques, côté écran (DECISIONS.md §88) — une seule fonction pour le bureau et le
 * téléphone : les deux passent par le panneau de recherche du cinéma (`PlayerSearchPanel`), et ce
 * module porte ce qu'il décide — quand chercher, d'où lancer, quoi mettre en évidence.
 */

/** Ce que la route répond. `available: false` : option coupée ou index vide — la section n'existe pas. */
export interface DialogueResponse {
  available: boolean;
  terms?: string[];
  prefixes?: string[];
  films?: DialogueFilm[];
}

/** Le recul avant la réplique : on entre dans la scène, pas au milieu de la phrase. */
export const DIALOGUE_LEAD_SECONDS = 5;

/** Où lancer le film pour une réplique : cinq secondes avant, jamais avant le début. Toujours un nombre (§1). */
export function dialogueResumeAt(startMs: number): number {
  return Math.max(0, startMs / 1000 - DIALOGUE_LEAD_SECONDS);
}

/** À partir de combien de mots la section se cherche d'elle-même sous les titres. */
export const DIALOGUE_MIN_WORDS = 3;

/**
 * Faut-il chercher dans les dialogues ? Sous les titres : à partir de trois mots (« je suis ton »),
 * parce qu'un ou deux mots sont presque toujours un titre et qu'une réplique se cite en phrase. Avec
 * la puce « Répliques » : dès qu'il y a trois lettres — on a dit qu'on cherchait une réplique.
 */
export function wantsDialogueSearch(query: string, only: boolean): boolean {
  const norm = normalizedText(query);
  if (only) return norm.replace(/ /g, "").length >= 3;
  return norm.split(" ").filter(Boolean).length >= DIALOGUE_MIN_WORDS;
}

/** `h:mm:ss`, l'horodatage d'une réplique. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Le texte d'une réplique découpé en morceaux, ceux qui répondent à la recherche marqués : un mot
 * dont la forme pliée (sans accents ni majuscules) est un des mots trouvés — ou commence par le
 * dernier mot tapé, qui vaut comme début de mot.
 */
export function highlightSegments(text: string, terms: readonly string[], prefixes: readonly string[]): { text: string; hit: boolean }[] {
  const wanted = new Set(terms);
  const out: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = match[0];
    const folded = normalizedText(word);
    const hit = folded.split(" ").some((w) => wanted.has(w) || prefixes.some((p) => w.startsWith(p)));
    if (!hit) continue;
    const index = match.index ?? 0;
    if (index > at) out.push({ text: text.slice(at, index), hit: false });
    out.push({ text: word, hit: true });
    at = index + word.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** Le délai avant de chercher dans les dialogues : les titres d'abord, la frappe ensuite. */
const DIALOGUE_DELAY_MS = 350;

/**
 * Une recherche de répliques, en dehors de SWR : **annulée** dès que la question change (le
 * `fetch` en vol est abandonné), lancée après un temps d'arrêt, jamais avant les titres. `url`
 * nulle : rien à chercher.
 */
export function useDialogueSearch(url: string | null): { data: DialogueResponse | undefined; loading: boolean; failed: boolean } {
  const [state, setState] = useState<{ url: string; data?: DialogueResponse; failed?: boolean } | null>(null);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(url, { signal: controller.signal })
        .then((res) => (res.ok ? (res.json() as Promise<DialogueResponse>) : Promise.reject(new Error(String(res.status)))))
        .then((data) => setState({ url, data }))
        .catch(() => {
          if (!controller.signal.aborted) setState({ url, failed: true });
        });
    }, DIALOGUE_DELAY_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [url]);
  const current = url !== null && state?.url === url ? state : null;
  return { data: current?.data, loading: url !== null && current === null, failed: !!current?.failed };
}

/** L'adresse d'une recherche de répliques. `film` : toutes celles d'un film (« voir plus »). */
export function dialogueSearchUrl(query: string, film?: string): string {
  return `/api/repliques?q=${encodeURIComponent(query.trim())}${film ? `&film=${encodeURIComponent(film)}` : ""}`;
}
