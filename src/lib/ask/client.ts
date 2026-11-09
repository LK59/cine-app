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
export function useAskTitle({ itemId, where, position }: { itemId: string; where: AskWhere; position?: () => number | null }) {
  const [exchanges, setExchanges] = useState<AskExchange[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const positionRef = useRef(position);
  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  // À l'ouverture : les dialogues demandés d'avance (le serveur n'attend rien). Une panne ici ne dit rien.
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/cinema/ask/${encodeURIComponent(itemId)}`, { signal: ctrl.signal }).catch(() => {});
    return () => ctrl.abort();
  }, [itemId]);

  // Refermé : la réponse en cours s'arrête, et le modèle avec elle.
  useEffect(() => () => abortRef.current?.abort(), []);

  const busy = exchanges.some((e) => e.state === "waiting" || e.state === "streaming");
  const full = exchanges.length >= ASK_MAX_EXCHANGES;

  const ask = useCallback(
    async (raw: string) => {
      const question = raw.trim().slice(0, ASK_MAX_QUESTION);
      if (!question || busy || full) return;
      const id = nextId.current++;
      const previous = exchanges.filter((e) => e.state === "done").map((e) => ({ question: e.question, answer: e.answer }));
      setExchanges((all) => [...all, { id, question, answer: "", state: "waiting" }]);
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
    [busy, full, exchanges, itemId, where]
  );

  return { exchanges, ask, busy, full };
}
