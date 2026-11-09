"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { fetcher, followOnlyOptions } from "@/lib/swr";
import { isFireTv } from "@/lib/fireTv";
import { ASK_MAX_EXCHANGES, ASK_MAX_QUESTION, type AskWhere } from "@/lib/ask/core";

/**
 * « Poser une question » côté écran (DECISIONS.md §139) : l'option, les échanges d'une ouverture du
 * panneau, la lecture de la réponse diffusée. Une seule copie, pour le lecteur et toutes les fiches.
 */

/**
 * L'option est-elle proposée ici ? La configuration publique **suivie, jamais demandée** (`followOnlyOptions`) :
 * la coquille du cinéma la lit au lancement, et le lecteur — qui s'en sert — ne doit ajouter aucune requête
 * à son ouverture (ses empreintes de comportement l'enregistrent toutes ; et SWR est en pause pendant un film,
 * une requête lancée de là serait perdue). Pas sur Fire TV : un champ de saisie au curseur de Silk et au
 * clavier de l'écran, refermé à la télécommande, est la chose la plus fragile qu'on puisse y poser (§71).
 */
export function useAskAvailable(): boolean {
  const { data } = useSWR<{ askAvailable?: boolean }>("/api/config/public", fetcher, followOnlyOptions);
  return data?.askAvailable === true && !isFireTv();
}

export type AskErrorCode = "off" | "limite" | "indisponible" | "erreur";

export interface AskExchange {
  id: number;
  question: string;
  answer: string;
  state: "waiting" | "streaming" | "done" | "rejected" | "error";
  error?: AskErrorCode;
}

type StreamEvent = { t: "text"; v: string } | { t: "done" } | { t: "rejected" } | { t: "error"; code: AskErrorCode };

/**
 * Les lignes JSON d'une réponse, lues au fil de l'eau. Une ligne illisible est sautée ; une réponse
 * qui finit sans ligne de fin est une erreur (connexion coupée).
 */
export async function readAskStream(res: Response, onEvent: (e: StreamEvent) => void): Promise<void> {
  if (!res.body) {
    for (const line of (await res.text()).split("\n")) parseLine(line, onEvent);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      parseLine(buffer.slice(0, nl), onEvent);
      buffer = buffer.slice(nl + 1);
    }
  }
  parseLine(buffer + decoder.decode(), onEvent);
}

function parseLine(line: string, onEvent: (e: StreamEvent) => void) {
  if (!line.trim()) return;
  try {
    const e = JSON.parse(line) as StreamEvent;
    if (e && typeof e === "object" && typeof e.t === "string") onEvent(e);
  } catch {
    /* une ligne coupée ne casse pas les autres */
  }
}

/**
 * Les échanges d'une ouverture du panneau — en mémoire de la page seulement, rien n'est gardé côté
 * serveur ni sur l'appareil : le panneau refermé, ils sont partis. Cinq au plus. La position est lue au
 * moment de la question (`position`), jamais retenue à l'ouverture : le film peut avoir bougé.
 */
export function useAskTitle({ itemId, where, position, enabled = true }: { itemId: string; where: AskWhere; position?: () => number | null; enabled?: boolean }) {
  const [exchanges, setExchanges] = useState<AskExchange[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const positionRef = useRef(position);
  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  // À l'ouverture : les dialogues demandés d'avance (le serveur n'attend rien). Une panne ici ne dit rien.
  // Sans l'option (le panneau d'une personne seul, §138), rien n'est demandé.
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    fetch(`/api/cinema/ask/${encodeURIComponent(itemId)}`, { signal: ctrl.signal }).catch(() => {});
    return () => ctrl.abort();
  }, [itemId, enabled]);

  // Refermé : la réponse en cours s'arrête, et le modèle avec elle.
  useEffect(() => () => abortRef.current?.abort(), []);

  const busy = exchanges.some((e) => e.state === "waiting" || e.state === "streaming");
  const full = exchanges.length >= ASK_MAX_EXCHANGES;

  /**
   * `replacing` : « Réessayer » sur un échange en panne — la même question repart à sa place, sans compter
   * pour un échange de plus.
   */
  const ask = useCallback(
    async (raw: string, replacing?: number) => {
      const question = raw.trim().slice(0, ASK_MAX_QUESTION);
      const others = replacing === undefined ? exchanges : exchanges.filter((e) => e.id !== replacing);
      const busyNow = others.some((e) => e.state === "waiting" || e.state === "streaming");
      if (!question || busyNow || others.length >= ASK_MAX_EXCHANGES) return;
      const id = nextId.current++;
      const previous = others.filter((e) => e.state === "done").map((e) => ({ question: e.question, answer: e.answer }));
      const fresh: AskExchange = { id, question, answer: "", state: "waiting" };
      setExchanges((all) => (replacing === undefined ? [...all, fresh] : all.map((e) => (e.id === replacing ? fresh : e))));
      const update = (fn: (e: AskExchange) => AskExchange) => setExchanges((all) => all.map((e) => (e.id === id ? fn(e) : e)));
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      let ended = false;
      try {
        const res = await fetch(`/api/cinema/ask/${encodeURIComponent(itemId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, where, positionS: positionRef.current?.() ?? null, previous }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(String(res.status));
        await readAskStream(res, (ev) => {
          if (ev.t === "text") update((e) => ({ ...e, state: "streaming", answer: e.answer ? `${e.answer} ${ev.v}` : ev.v }));
          else if (ev.t === "done") {
            ended = true;
            update((e) => ({ ...e, state: "done" }));
          } else if (ev.t === "rejected") {
            ended = true;
            // Une phrase déjà montrée part aussi : la réponse entière est retirée, pas seulement sa fin.
            update((e) => ({ ...e, state: "rejected", answer: "" }));
          } else if (ev.t === "error") {
            ended = true;
            update((e) => ({ ...e, state: "error", error: ev.code, answer: "" }));
          }
        });
        if (!ended) update((e) => ({ ...e, state: "error", error: "erreur" }));
      } catch {
        if (ctrl.signal.aborted) return;
        update((e) => ({ ...e, state: "error", error: "erreur" }));
      }
    },
    [exchanges, itemId, where]
  );
  const retry = useCallback(
    (id: number) => {
      const failed = exchanges.find((e) => e.id === id);
      if (failed) void ask(failed.question, id);
    },
    [exchanges, ask]
  );

  return { exchanges, ask, retry, busy, full };
}

// ── « Jusqu'ici » (DECISIONS.md §139, 10.27) ─────────────────────────────────────────────────────

/** La tranche de dix minutes d'une position — ce qui distingue deux préparations d'une même personne. */
const sofarBucket = (positionS: number) => Math.floor(Math.max(0, positionS) / 600);
const prewarmed = new Set<string>();
/** Les trois premières personnes de la scène seulement. */
export const SOFAR_PREWARM_PEOPLE = 3;

/**
 * Préparer « Jusqu'ici » en fond pour les premières personnes de la scène, quand la rangée paraît : une
 * fois par personne et par tranche de dix minutes pour cette page, jamais page cachée. Personne n'attend
 * la réponse (`{"t":"queued"}`) ; une panne ne dit rien.
 */
export function prewarmSofar(itemId: string, personIds: readonly number[], positionS: number): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (!Number.isFinite(positionS)) return;
  for (const personId of personIds.slice(0, SOFAR_PREWARM_PEOPLE)) {
    const key = `${itemId}:${personId}:${sofarBucket(positionS)}`;
    if (prewarmed.has(key)) continue;
    prewarmed.add(key);
    if (prewarmed.size > 2000) prewarmed.delete(prewarmed.values().next().value as string);
    try {
      void fetch(`/api/cinema/ask/${encodeURIComponent(itemId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "jusquici", personId, positionS: Math.floor(positionS), prewarm: true }),
      }).catch(() => {});
    } catch {
      /* une préparation perdue ne coûte rien */
    }
  }
}

export function resetPrewarmForTests(): void {
  prewarmed.clear();
}

export type SofarView = { state: "waiting" | "streaming" | "done" | "none"; text: string };

/**
 * « Jusqu'ici » dans le panneau d'une personne : demandé à l'ouverture (déjà prêt d'ordinaire, préparé en
 * fond), les phrases à mesure. Toute issue autre qu'un texte — panne, délai, refus, nom inconnu, rien à
 * dire — rend `none` : le panneau n'en montre rien (consigne du propriétaire : pas de bruit d'erreur ici).
 */
export function useSofar(itemId: string, personId: number, positionS: number | null, enabled: boolean): SofarView {
  const [view, setView] = useState<{ key: string; view: SofarView } | null>(null);
  const key = `${itemId}:${personId}:${positionS ?? "?"}`;
  useEffect(() => {
    if (!enabled || positionS === null) return;
    const ctrl = new AbortController();
    let text = "";
    let ended = false;
    const set = (v: SofarView) => setView({ key, view: v });
    void (async () => {
      try {
        const res = await fetch(`/api/cinema/ask/${encodeURIComponent(itemId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "jusquici", personId, positionS: Math.floor(positionS) }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(String(res.status));
        await readAskStream(res, (ev) => {
          if (ended) return;
          if (ev.t === "text") {
            text = text ? `${text} ${ev.v}` : ev.v;
            set({ state: "streaming", text });
          } else if (ev.t === "done") {
            ended = true;
            set({ state: "done", text });
          } else {
            ended = true;
            set({ state: "none", text: "" });
          }
        });
        if (!ended) set({ state: "none", text: "" });
      } catch {
        if (!ctrl.signal.aborted) set({ state: "none", text: "" });
      }
    })();
    return () => ctrl.abort();
  }, [key, itemId, personId, positionS, enabled]);
  if (!enabled || positionS === null) return { state: "none", text: "" };
  return view?.key === key ? view.view : { state: "waiting", text: "" };
}
