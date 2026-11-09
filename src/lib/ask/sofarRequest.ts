// « Jusqu'ici » côté route (`POST /api/cinema/ask/[itemId]` avec `mode: "jusquici"`) — DECISIONS.md §139.
//
// Deux usages, une seule clé (`sofarKey`) :
// - **préparé sur une intention** (`prewarm: true`, 10.27.2) : au bureau, le pointeur posé sur une pilule
//   d'« À l'écran » ; la route lance la génération si personne ne l'a déjà fait et répond aussitôt
//   `{"t":"queued"}` — le clic qui suit lit la même génération ;
// - **le panneau ouvert** : les phrases, diffusées comme celles d'une question — celles déjà là d'un coup,
//   les suivantes à mesure —, puis `{"t":"done"}`, `{"t":"rejected"}` (rien à montrer : nom inconnu, ou
//   rien à dire) ou `{"t":"error","code":…}`. L'écran ne montre rien dans les trois derniers cas.
//
// La personne est cherchée **dans la distribution de cet élément** (`castPerson`) : le nom et le
// personnage viennent de TMDB, jamais du corps de la requête.

import { NextResponse } from "next/server";
import type { Locale } from "@/lib/i18n";
import { logError } from "@/lib/logger";
import { logJusquici } from "@/lib/eventLogs";
import { createRateLimiter } from "@/lib/rateLimiter";
import { askWhereLine } from "@/lib/ask/core";
import { SOFAR_MAX_OUTPUT_TOKENS, askModelName, currentAskModel, gatherAskContext } from "@/lib/ask/service";
import { aiBudgetReached } from "@/lib/aiFeatures";
import { castPerson } from "@/lib/xray/person";
import { scenesForPlayer } from "@/lib/xray/scenes";
import { sofarCut, sofarMark } from "@/lib/ask/sofarCut";
import { SOFAR_MOVIE_MIN_S, sofarInput, sofarKey, sofarLookup, sofarParts, sofarScenes, sofarSources, sofarStart, sofarSubscribe, sofarSystem, type SofarEntry } from "@/lib/ask/sofar";

/**
 * La borne par compte (consigne du propriétaire, 09/11/2026 : ~100 €/mois de crédit, ne pas brider — seulement
 * se garder d'un client qui boucle) : 200 générations par heure, préparations sur intention comprises (10.27.2 :
 * la préparation à l'apparition de la rangée, et sa borne à part, sont retirées). Comptée seulement quand le
 * modèle est vraiment appelé : un texte déjà gardé ne coûte rien.
 */
export const SOFAR_PER_HOUR = 200;
const perHour = createRateLimiter(SOFAR_PER_HOUR, 60 * 60 * 1000);

/**
 * Les répliques peuvent être attendues plus longtemps qu'à une question : le texte est gardé pour la tranche.
 * Depuis 10.28.2, au-delà, rien n'est écrit si l'élément a une piste texte (`dialogueMissing`) — la lecture
 * continue et sert à la demande suivante ; l'écran garde l'attente animée jusqu'à son propre délai
 * (`SOFAR_CLIENT_TIMEOUT_MS`, le même), puis la ligne discrète.
 */
export const SOFAR_DIALOGUE_WAIT_MS = 25_000;

const STREAM_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Accel-Buffering": "no",
};

type Out = { t: "text"; v: string } | { t: "reset"; v: string } | { t: "plan"; from?: string; to?: string } | { t: "done" } | { t: "rejected" } | { t: "queued" } | { t: "error"; code: "off" | "limite" | "indisponible" | "erreur" | "budget" };

function oneShot(event: Out): NextResponse {
  return new NextResponse(`${JSON.stringify(event)}\n`, { status: 200, headers: STREAM_HEADERS });
}

export interface SofarBody {
  personId: number;
  positionS: number | null;
  prewarm: boolean;
}

/** Le corps d'une demande « Jusqu'ici », lu avec méfiance ; `null` : pas de cette forme. */
export function readSofarBody(body: unknown): SofarBody | null {
  const b = body as { mode?: unknown; personId?: unknown; positionS?: unknown; prewarm?: unknown } | null;
  if (!b || b.mode !== "jusquici") return null;
  if (typeof b.personId !== "number" || !Number.isInteger(b.personId) || b.personId <= 0) return null;
  const positionS = typeof b.positionS === "number" && Number.isFinite(b.positionS) && b.positionS >= 0 ? Math.floor(b.positionS) : null;
  return { personId: b.personId, positionS, prewarm: b.prewarm === true };
}

export async function answerSofar(
  who: { user: string; device: string | null; account: string; locale: Locale; signal?: AbortSignal },
  itemId: string,
  body: SofarBody
): Promise<NextResponse> {
  const started = Date.now();
  // La coupe tombe sur un début de scène (10.27.2, `sofarCut`) : les scènes d'« À l'écran », celles que le
  // lecteur reçoit ; sans elles, la marque des cinq minutes. Une panne du service des scènes ne bloque rien.
  const scenes = await scenesForPlayer(itemId).catch(() => null);
  const cutoff = sofarCut(body.positionS, scenes);
  const base = {
    user: who.user,
    device: who.device,
    itemId,
    personId: body.personId,
    bucket: Math.round(sofarMark(body.positionS) / 60),
    cutS: cutoff,
    prewarm: body.prewarm,
  };

  let context: Awaited<ReturnType<typeof gatherAskContext>>;
  let found: Awaited<ReturnType<typeof castPerson>>;
  try {
    [found, context] = await Promise.all([
      castPerson(itemId, body.personId),
      gatherAskContext(who.account, itemId, "lecteur", cutoff, who.locale, SOFAR_DIALOGUE_WAIT_MS, { movieEarly: (body.positionS ?? 0) < SOFAR_MOVIE_MIN_S }),
    ]);
  } catch (err) {
    logError("ask/jusquici", err, { itemId });
    logJusquici({ ...base, cache: "nouveau", status: "erreur", ms: Date.now() - started });
    return oneShot({ t: "error", code: "erreur" });
  }
  const contextMs = Date.now() - started;
  if (!found || context.status !== "ok") {
    logJusquici({ ...base, cache: "nouveau", status: "indisponible", ms: Date.now() - started });
    return oneShot({ t: "error", code: "indisponible" });
  }

  // Deux cas où rien n'est demandé au modèle ni gardé (10.28.2) — la ligne discrète, « Encore trop peu vu pour en dire
  // plus. » (`rejected`, que l'écran lit `little`) :
  // - un film avant dix minutes (`SOFAR_MOVIE_MIN_S`) : rien à dire que le synopsis ne dise déjà ;
  // - des répliques attendues et absentes (`dialogueMissing`) : la piste texte existe, mais sa lecture n'a pas fini
  //   dans `SOFAR_DIALOGUE_WAIT_MS` (12 à 45 s chez Jellyfin pour une piste intégrée) ou a échoué. Avant, le texte
  //   partait sur le seul synopsis — générique, et gardé trente jours sous sa clé (banc du 09/11/2026, *Bullet
  //   Train* à froid). Une coupe à zéro n'envoie aucune réplique : rien n'y manque. Un élément **sans** piste texte
  //   garde la règle d'avant (synopsis, distribution, résumés).
  const quiet = context.early ? ("tôt" as const) : context.dialogueMissing && cutoff > 0 ? ("attente" as const) : null;
  if (quiet) {
    logJusquici({ ...base, cache: "nouveau", status: quiet, ms: Date.now() - started, contextMs, ctx: context.ctx, ...(quiet === "attente" ? { dialogue: "attente" as const } : {}) });
    return oneShot({ t: "rejected" });
  }

  const person = { name: found.person.name, character: found.person.character };
  // Les répliques groupées par scène (10.28.0, S7c) : les mêmes scènes que la coupe.
  const sources = sofarSources(context.input, person, sofarScenes(scenes, body.personId));
  const system = sofarSystem(who.locale, !!sources.grouped, context.input.kind);
  const { message, prefixEnd } = sofarParts(sources, askWhereLine(sofarInput(context.input)), person);
  // Le modèle qui écrit (§140) : un texte d'un fournisseur n'est jamais servi pour un autre.
  const key = sofarKey(askModelName(), system, message);
  const dialogue: boolean | "attente" = context.dialogueLate ? "attente" : sources.dialogue;
  // Les temps de chaque étape (10.27.2) : l'assemblage du contexte, et d'où il venait.
  const timing = { contextMs, ctx: context.ctx };

  let entry: SofarEntry | null = sofarLookup(key);
  const cache = entry ? (entry.by === who.account ? "compte" : "partagé") : "nouveau";
  if (!entry) {
    // Le plafond mensuel commun atteint (§140) : rien de nouveau n'est écrit — l'écran se tait.
    if (aiBudgetReached()) {
      logJusquici({ ...base, cache, status: "limite", ms: Date.now() - started });
      return oneShot({ t: "error", code: "budget" });
    }
    if (!perHour(who.account)) {
      logJusquici({ ...base, cache, status: "limite", ms: Date.now() - started });
      return oneShot({ t: "error", code: "limite" });
    }
    const model = currentAskModel();
    entry = sofarStart(key, who.account, (signal) => model({ system, message, prefixEnd, maxTokens: SOFAR_MAX_OUTPUT_TOKENS, signal, feature: "sofar" }), sources.check, { locale: who.locale, sources: sources.text });
    // Le journal de la génération, à sa fin, au nom de qui l'a lancée — une seule ligne `nouveau`.
    void entry.done.then((fin) => {
      if (fin.error) logError("ask/jusquici", fin.error, { itemId });
      const status = fin.state === "erreur" ? "erreur" : fin.state;
      logJusquici({
        ...base,
        cache: "nouveau",
        status,
        ms: Date.now() - started,
        ...timing,
        totalMs: Date.now() - started,
        ...(fin.ttftMs === undefined ? {} : { ttftMs: fin.ttftMs }),
        ...(fin.firstMs === undefined ? {} : { firstMs: fin.firstMs, firstWordMs: fin.firstMs }),
        ...(fin.firstSentenceMs === undefined ? {} : { firstSentenceMs: fin.firstSentenceMs }),
        ...(fin.inTokens === undefined ? {} : { inTokens: fin.inTokens, outTokens: fin.outTokens }),
        ...(fin.cacheWrite === undefined ? {} : { cacheWrite: fin.cacheWrite }),
        ...(fin.cacheRead === undefined ? {} : { cacheRead: fin.cacheRead }),
        dialogue,
        episodes: sources.episodes,
        ...(fin.meta ? { meta: "réécrit" as const } : {}),
      });
    });
  } else {
    // Un texte déjà gardé (ou en cours pour un autre) : servi sans appel au modèle.
    const status = entry.state === "running" || entry.state === "ok" ? "ok" : entry.state;
    logJusquici({ ...base, cache, status, ms: Date.now() - started, ...timing, totalMs: Date.now() - started, dialogue, episodes: sources.episodes });
  }

  if (body.prewarm) return oneShot({ t: "queued" });

  const held = entry;
  const encoder = new TextEncoder();
  let stop: () => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (e: Out) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          /* le lecteur est parti */
        }
      };
      const close = () => {
        try {
          controller.close();
        } catch {
          /* déjà fermé */
        }
      };
      // Une génération en cours, rien encore d'écrit (10.28.0) : ce qui part au modèle, dit à l'écran d'attente —
      // la fenêtre des résumés. Jamais pour un texte déjà gardé : il se montre sans attente.
      if (held.state === "running" && !held.shown) {
        const codes = sources.episodeCodes ?? [];
        send(codes.length ? { t: "plan", from: codes[0], to: codes[codes.length - 1] } : { t: "plan" });
      }
      stop = sofarSubscribe(held, (e) => {
        if (e.t === "text" || e.t === "reset") return send(e);
        if (e.state === "ok") send({ t: "done" });
        else if (e.state === "erreur") send({ t: "error", code: "erreur" });
        else send({ t: "rejected" });
        close();
      });
      who.signal?.addEventListener?.("abort", () => stop(), { once: true });
    },
    cancel() {
      stop();
    },
  });
  return new NextResponse(stream, { status: 200, headers: STREAM_HEADERS });
}
