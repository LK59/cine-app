"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { fetcher, followOnlyOptions } from "@/lib/swr";
import { isFireTv } from "@/lib/fireTv";
import { ASK_MAX_EXCHANGES, ASK_MAX_QUESTION, type AskWhere } from "@/lib/ask/core";
import { sofarCut, type SofarScenes } from "@/lib/ask/sofarCut";

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

/**
 * Les questions posées depuis le panneau d'une personne, et « Jusqu'ici » (§139, 09/11/2026) : chacune son
 * réglage, lu de la même configuration publique suivie. Pas sur Fire TV, comme les questions.
 */
export function useAskPersonAvailable(): boolean {
  const { data } = useSWR<{ askPersonAvailable?: boolean }>("/api/config/public", fetcher, followOnlyOptions);
  return data?.askPersonAvailable === true && !isFireTv();
}

export function useSofarAvailable(): boolean {
  const { data } = useSWR<{ sofarAvailable?: boolean }>("/api/config/public", fetcher, followOnlyOptions);
  return data?.sofarAvailable === true && !isFireTv();
}

/** `budget` : le plafond mensuel des fonctions payantes est atteint (§140). */
export type AskErrorCode = "off" | "limite" | "indisponible" | "erreur" | "budget";

export interface AskExchange {
  id: number;
  question: string;
  answer: string;
  state: "waiting" | "streaming" | "done" | "rejected" | "error";
  error?: AskErrorCode;
}

/**
 * Les lignes d'une réponse. `text` : des mots à ajouter, séparés d'une espace (mot par mot depuis 10.28.0) ;
 * `reset` : le texte montré entier à remettre (une phrase commencée puis retirée par le filet des mots de
 * coulisse) ; `plan` (« Jusqu'ici ») : une génération commence — la fenêtre des résumés qui partent.
 */
type StreamEvent =
  | { t: "text"; v: string }
  | { t: "reset"; v: string }
  | { t: "plan"; from?: string; to?: string }
  | { t: "done" }
  | { t: "rejected" }
  | { t: "error"; code: AskErrorCode };

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
export function useAskTitle({
  itemId,
  where,
  position,
  enabled = true,
  personId,
  about = "title",
}: {
  itemId: string;
  where: AskWhere;
  position?: () => number | null;
  enabled?: boolean;
  /** Le panneau d'une personne (10.27.2) : ses faits réels partent avec la question, côté serveur. */
  personId?: number;
  /** `person` : posées depuis le panneau d'une personne — une autre porte côté serveur (`ASK_PERSON_ENABLED`). */
  about?: "title" | "person";
}) {
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
          body: JSON.stringify({
            question,
            where,
            positionS: positionRef.current?.() ?? null,
            previous,
            ...(personId ? { personId } : {}),
            ...(about === "person" ? { about } : {}),
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(String(res.status));
        await readAskStream(res, (ev) => {
          if (ev.t === "text") update((e) => ({ ...e, state: "streaming", answer: e.answer ? `${e.answer} ${ev.v}` : ev.v }));
          else if (ev.t === "reset") update((e) => ({ ...e, answer: ev.v }));
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
    [exchanges, itemId, where, personId, about]
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

/**
 * La coupe de « Jusqu'ici » (10.27.2) : la même fonction que le serveur (`sofarCut`), sur les scènes que le
 * lecteur a reçues — ce qui distingue deux préparations d'une même personne, et deux textes gardés sur
 * l'appareil. Depuis 10.30.1, le début de la scène en cours ; sans scènes, la tranche de cinq minutes
 * (`SOFAR_BUCKET_S`).
 */
export { SOFAR_BUCKET_S } from "@/lib/ask/sofarCut";
const prewarmed = new Set<string>();
/** Le temps qu'un pointeur doit rester sur une pilule pour que ce soit une intention, pas un passage. */
export const SOFAR_HOVER_INTENT_MS = 300;

/**
 * Préparer « Jusqu'ici » pour **une** personne, sur une intention (10.27.2, règle du propriétaire) : au
 * bureau, le pointeur posé sur sa pilule d'« À l'écran » (`SOFAR_HOVER_INTENT_MS`, pointeur fin seulement —
 * jamais au doigt). Une fois par personne et par coupe pour la page, jamais page cachée ; personne n'attend
 * la réponse (`{"t":"queued"}`), une panne ne dit rien. Le clic qui suit d'ordinaire lit la même génération
 * (le serveur la garde par sa clé) ; rien n'est annulé si le pointeur s'en va.
 *
 * Jusqu'en 10.27.1, les trois premières personnes de chaque scène étaient préparées dès que la rangée
 * paraissait : ~6 textes par heure de film pour zéro ou une lecture — retiré.
 */
export function prewarmSofar(itemId: string, personId: number, positionS: number, scenes?: SofarScenes | null): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  if (!Number.isFinite(positionS)) return;
  const key = `${itemId}:${personId}:${sofarCut(positionS, scenes)}`;
  if (prewarmed.has(key)) return;
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

/**
 * Le lecteur ouvre un film ou un épisode, l'option ouverte à la séance (10.27.2) : le serveur prépare le
 * contexte des questions et de « Jusqu'ici » (`prepareAskContext` — l'élément, ses épisodes, les répliques),
 * une fois par élément. Rien n'est attendu ; une panne ne dit rien.
 */
export function useAskPrepare(itemId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    fetch(`/api/cinema/ask/${encodeURIComponent(itemId)}`, { signal: ctrl.signal }).catch(() => {});
    return () => ctrl.abort();
  }, [itemId, enabled]);
}

export function resetPrewarmForTests(): void {
  prewarmed.clear();
}

export type SofarView = {
  /**
   * `waiting` : la section est là, le texte pas encore ; `streaming` / `done` : le texte ; `little` : la
   * section reste avec une ligne discrète (« Encore trop peu vu pour en dire plus. ») — rien à dire, un nom
   * refusé, une panne, le délai (10.27.2 : la section qui disparaissait se lisait comme une panne) ; `none` :
   * pas de section (option coupée pour cette séance).
   */
  state: "waiting" | "streaming" | "done" | "little" | "none";
  text: string;
  /**
   * L'attente animée (10.28.0) : dès que le serveur dit qu'une génération commence (`plan`), ou passé
   * `SOFAR_LOADING_DELAY_MS` sans rien — jamais pour un texte gardé (sur l'appareil : aucune requête ; au
   * serveur : il arrive avant). Le premier mot la remplace aussitôt.
   */
  loading: boolean;
  /** Ce que le serveur a dit de la génération : la fenêtre des résumés envoyés (`null` : rien dit encore). */
  plan: { from?: string; to?: string } | null;
};

/** Au-delà, la ligne discrète remplace l'attente (10.27.1 : « Un instant… » restait affiché pour toujours). */
export const SOFAR_CLIENT_TIMEOUT_MS = 25_000;
/**
 * La ligne d'attente ne paraît qu'après ce délai : un texte gardé par le serveur arrive en ~230 ms et se
 * montre sans elle ; une génération (2 à 5 s) la montre.
 */
export const SOFAR_LOADING_DELAY_MS = 350;

/**
 * Les textes déjà lus par cette page, par élément, personne et tranche : rouvrir le panneau de la même
 * personne dans la même tranche les montre à l'instant, sans requête ni ligne d'attente. En mémoire
 * seulement (la page est à un compte ; le serveur garde les textes trente jours, partagés).
 */
const sofarRead = new Map<string, string>();
const SOFAR_READ_MAX = 200;

/**
 * Ce que la page garde de « Jusqu'ici » et de ses préparations, oublié à la sortie d'un compte (10.28.1,
 * `forgetAccountOnDevice`) : les textes lus disent ce que **ce** compte a vu ; le compte suivant dans le même
 * onglet les aurait lus sans requête.
 */
export function forgetAskClient(): void {
  sofarRead.clear();
  for (const p of pendingSofar.values()) {
    clearTimeout(p.timer);
    p.ctrl.abort();
  }
  pendingSofar.clear();
  prewarmed.clear();
}

export function resetSofarClientForTests(): void {
  sofarRead.clear();
  for (const p of pendingSofar.values()) clearTimeout(p.timer);
  pendingSofar.clear();
}

const NONE: SofarView = { state: "none", text: "", loading: false, plan: null };

/**
 * La demande de « Jusqu'ici » partie **au toucher lui-même** (10.27.2), avant l'animation du panneau et toute
 * autre requête : `startSofar` la lance depuis le gestionnaire du clic, et `useSofar`, monté une image plus
 * tard, la reprend au lieu d'en lancer une seconde. Une demande que personne ne reprend (panneau jamais
 * monté) est oubliée au bout de dix secondes — la génération, détachée côté serveur, va au bout et se garde.
 */
type Pending = { res: Promise<Response>; ctrl: AbortController; timer: ReturnType<typeof setTimeout> };
const pendingSofar = new Map<string, Pending>();
const PENDING_FORGET_MS = 10_000;

/**
 * La position de « Jusqu'ici », en secondes entières — lue **une fois, au toucher** (10.28.1). Le toucher
 * (`startSofar`) lisait l'heure affichée, le panneau (`useSofar`) la sienne un quart de seconde plus tard : à
 * une limite de tranche, deux coupes, deux clés, une seconde demande — et parfois une seconde génération payée.
 * Le même nombre sert maintenant aux deux : `startSofar` le rend, le lecteur le passe au panneau.
 */
export function sofarPosition(positionS: number | null | undefined): number | null {
  return positionS != null && Number.isFinite(positionS) ? Math.floor(positionS) : null;
}
const sofarPos = sofarPosition;
const sofarReadKey = (itemId: string, personId: number, pos: number | null, scenes?: SofarScenes | null) => `${itemId}:${personId}:${sofarCut(pos, scenes)}`;

function sofarFetch(itemId: string, personId: number, pos: number | null, signal: AbortSignal): Promise<Response> {
  return fetch(`/api/cinema/ask/${encodeURIComponent(itemId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "jusquici", personId, positionS: pos }),
    signal,
  });
}

/**
 * `position` : la position, ou de quoi la lire au moment du toucher. Rend la position retenue (`sofarPosition`) :
 * le panneau doit lire **celle-ci** (`useSofar`), pas la relire — même coupe, même clé, une seule demande.
 */
export function startSofar(itemId: string, personId: number, position: number | null | (() => number | null), scenes?: SofarScenes | null): number | null {
  const pos = sofarPos(typeof position === "function" ? position() : position);
  const key = sofarReadKey(itemId, personId, pos, scenes);
  if (sofarRead.has(key) || pendingSofar.has(key)) return pos;
  const ctrl = new AbortController();
  let res: Promise<Response>;
  try {
    res = sofarFetch(itemId, personId, pos, ctrl.signal);
  } catch (err) {
    res = Promise.reject(err);
  }
  res.catch(() => {});
  const timer = setTimeout(() => pendingSofar.delete(key), PENDING_FORGET_MS);
  pendingSofar.set(key, { res, ctrl, timer });
  return pos;
}

function takePendingSofar(key: string): Pending | null {
  const pending = pendingSofar.get(key) ?? null;
  if (pending) {
    clearTimeout(pending.timer);
    pendingSofar.delete(key);
  }
  return pending;
}

/**
 * « Jusqu'ici » dans le panneau d'une personne (DECISIONS.md §139, 10.27.1) — indépendant de tout le reste
 * du panneau (faits, biographie, affiches : `usePersonFacts`, jamais en attente de celui-ci).
 *
 * Avec l'option pour cette séance, la section est **toujours** là, en haut, dès l'ouverture : la ligne
 * d'attente (passé un court délai), puis le texte. Sur « rien à dire » ou un nom refusé (`rejected`), une
 * panne (réseau, 5xx, `error`, flux fini sans sa fin) ou **vingt-cinq secondes** sans fin
 * (`SOFAR_CLIENT_TIMEOUT_MS`), elle reste avec une ligne discrète (`little`, 10.27.2 — en 10.27.1 elle se
 * retirait sans un mot, et le propriétaire le lisait comme une panne) ; la cause d'une panne est dans
 * `server.log` (`ask/jusquici`). Seule l'option refusée à ce compte (`off`) retire la section.
 * Position inconnue : demandée quand même (`null` — le serveur coupe au début), jamais une section muette.
 *
 * 10.27.0 rendait `none` — pas de section du tout — quand la position manquait, n'avait aucun délai côté
 * client (une réponse qui ne finissait pas laissait « Un instant… » pour toujours), et ne gardait rien :
 * chaque ouverture repassait par la ligne d'attente.
 */
export function useSofar(itemId: string, personId: number, positionS: number | null, enabled: boolean, scenes?: SofarScenes | null): SofarView {
  const pos = sofarPos(positionS);
  const readKey = sofarReadKey(itemId, personId, pos, scenes);
  const key = `${readKey}:${pos ?? "?"}`;
  const [view, setView] = useState<{ key: string; view: SofarView } | null>(null);
  const [slow, setSlow] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ key: string; plan: NonNullable<SofarView["plan"]> } | null>(null);
  const already = enabled ? sofarRead.get(readKey) : undefined;
  useEffect(() => {
    if (!enabled || already !== undefined) return;
    // La demande partie au toucher (`startSofar`), sinon une nouvelle.
    const pending = takePendingSofar(readKey);
    const ctrl = pending?.ctrl ?? new AbortController();
    let text = "";
    let ended = false;
    const set = (v: Omit<SofarView, "loading" | "plan">) => setView({ key, view: { ...v, loading: false, plan: null } });
    const finish = (v: Omit<SofarView, "loading" | "plan">) => {
      if (ended) return;
      ended = true;
      window.clearTimeout(timeout);
      window.clearTimeout(loadingTimer);
      set(v);
    };
    const loadingTimer = window.setTimeout(() => setSlow(key), SOFAR_LOADING_DELAY_MS);
    // Le délai du client : une réponse qui ne finit pas ne laisse jamais la ligne d'attente pour toujours —
    // la section se retire, comme pour une panne (une phrase sans sa fin n'est pas une réponse vérifiée).
    const timeout = window.setTimeout(() => {
      finish({ state: "little", text: "" });
      ctrl.abort();
    }, SOFAR_CLIENT_TIMEOUT_MS);
    void (async () => {
      try {
        const res = await (pending ? pending.res : sofarFetch(itemId, personId, pos, ctrl.signal));
        if (!res.ok) throw new Error(String(res.status));
        await readAskStream(res, (ev) => {
          if (ended) return;
          if (ev.t === "plan") {
            // Une génération commence : l'attente paraît tout de suite, avec ce qui part au modèle.
            window.clearTimeout(loadingTimer);
            setPlan({ key, plan: { ...(ev.from ? { from: ev.from } : {}), ...(ev.to ? { to: ev.to } : {}) } });
          } else if (ev.t === "text" || ev.t === "reset") {
            text = ev.t === "reset" ? ev.v : text ? `${text} ${ev.v}` : ev.v;
            window.clearTimeout(loadingTimer);
            // Le premier mot remplace l'attente à l'instant (consigne du propriétaire : elle ne retarde jamais rien).
            set({ state: "streaming", text });
          } else if (ev.t === "done") {
            if (text) {
              sofarRead.set(readKey, text);
              if (sofarRead.size > SOFAR_READ_MAX) sofarRead.delete(sofarRead.keys().next().value as string);
            }
            finish(text ? { state: "done", text } : { state: "little", text: "" });
          } else if (ev.t === "error" && ev.code === "off") finish({ state: "none", text: "" });
          else finish({ state: "little", text: "" });
        });
        // Fini sans sa ligne de fin (connexion coupée) : une panne.
        finish({ state: "little", text: "" });
      } catch {
        if (!ctrl.signal.aborted) finish({ state: "little", text: "" });
      }
    })();
    return () => {
      ended = true;
      window.clearTimeout(timeout);
      window.clearTimeout(loadingTimer);
      ctrl.abort();
    };
  }, [key, readKey, itemId, personId, pos, enabled, already]);
  if (!enabled) return NONE;
  if (already !== undefined) return { state: "done", text: already, loading: false, plan: null };
  if (view?.key === key) return view.view;
  const known = plan?.key === key ? plan.plan : null;
  return { state: "waiting", text: "", loading: slow === key || known !== null, plan: known };
}
