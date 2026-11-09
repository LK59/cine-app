// « Jusqu'ici » côté route (`POST /api/cinema/ask/[itemId]` avec `mode: "jusquici"`) — DECISIONS.md §139.
//
// Deux usages, une seule clé (`sofarKey`) :
// - **préparé en fond** (`prewarm: true`) : la rangée « À l'écran » vient de paraître ; la route lance la
//   génération si personne ne l'a déjà fait et répond aussitôt `{"t":"queued"}` — personne n'attend ;
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
import { askModelName, currentAskModel, gatherAskContext } from "@/lib/ask/service";
import { aiBudgetReached } from "@/lib/aiFeatures";
import { castPerson } from "@/lib/xray/person";
import { sofarCutoff, sofarKey, sofarLookup, sofarMessage, sofarSources, sofarStart, sofarSubscribe, sofarSystem, type SofarEntry } from "@/lib/ask/sofar";

/**
 * Bornes par compte (consigne du propriétaire, 09/11/2026 : ~100 €/mois de crédit, ne pas brider —
 * seulement se garder d'un client qui boucle). Comptées seulement quand le modèle est vraiment appelé :
 * un texte déjà gardé ne coûte rien. Préparé en fond : 200 par heure ; panneau ouvert : 200 par heure
 * aussi, à part (une génération à la demande n'est jamais refusée parce que la préparation a tout pris).
 */
export const SOFAR_PREWARM_PER_HOUR = 200;
export const SOFAR_OPEN_PER_HOUR = 200;
const prewarmPerHour = createRateLimiter(SOFAR_PREWARM_PER_HOUR, 60 * 60 * 1000);
const openPerHour = createRateLimiter(SOFAR_OPEN_PER_HOUR, 60 * 60 * 1000);

/** Les répliques peuvent être attendues plus longtemps qu'à une question : le texte est gardé pour la tranche. */
export const SOFAR_DIALOGUE_WAIT_MS = 25_000;

const STREAM_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "private, no-store",
  "X-Accel-Buffering": "no",
};

type Out = { t: "text"; v: string } | { t: "done" } | { t: "rejected" } | { t: "queued" } | { t: "error"; code: "off" | "limite" | "indisponible" | "erreur" | "budget" };

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
  const cutoff = sofarCutoff(body.positionS);
  const base = { user: who.user, device: who.device, itemId, personId: body.personId, bucket: Math.round(cutoff / 60), prewarm: body.prewarm };

  let context: Awaited<ReturnType<typeof gatherAskContext>>;
  let found: Awaited<ReturnType<typeof castPerson>>;
  try {
    [found, context] = await Promise.all([
      castPerson(itemId, body.personId),
      gatherAskContext(who.account, itemId, "lecteur", cutoff, who.locale, SOFAR_DIALOGUE_WAIT_MS),
    ]);
  } catch (err) {
    logError("ask/jusquici", err, { itemId });
    logJusquici({ ...base, cache: "nouveau", status: "erreur", ms: Date.now() - started });
    return oneShot({ t: "error", code: "erreur" });
  }
  if (!found || context.status !== "ok") {
    logJusquici({ ...base, cache: "nouveau", status: "indisponible", ms: Date.now() - started });
    return oneShot({ t: "error", code: "indisponible" });
  }

  const person = { name: found.person.name, character: found.person.character };
  const sources = sofarSources(context.input, person);
  const system = sofarSystem(who.locale);
  const message = sofarMessage(sources, askWhereLine(context.input), person);
  // Le modèle qui écrit (§140) : un texte d'un fournisseur n'est jamais servi pour un autre.
  const key = sofarKey(askModelName(), system, message);
  const dialogue: boolean | "attente" = context.dialogueLate ? "attente" : sources.dialogue;

  let entry: SofarEntry | null = sofarLookup(key);
  const cache = entry ? (entry.by === who.account ? "compte" : "partagé") : "nouveau";
  if (!entry) {
    // Le plafond mensuel commun atteint (§140) : rien de nouveau n'est écrit — l'écran se tait.
    if (aiBudgetReached()) {
      logJusquici({ ...base, cache, status: "limite", ms: Date.now() - started });
      return oneShot({ t: "error", code: "budget" });
    }
    const allowed = body.prewarm ? prewarmPerHour(who.account) : openPerHour(who.account);
    if (!allowed) {
      logJusquici({ ...base, cache, status: "limite", ms: Date.now() - started });
      return oneShot({ t: "error", code: "limite" });
    }
    const model = currentAskModel();
    entry = sofarStart(key, who.account, (signal) => model({ system, message, signal }), sources.check);
    // Le journal de la génération, à sa fin, au nom de qui l'a lancée — une seule ligne `nouveau`.
    void entry.done.then((fin) => {
      if (fin.error) logError("ask/jusquici", fin.error, { itemId });
      const status = fin.state === "erreur" ? "erreur" : fin.state;
      logJusquici({
        ...base,
        cache: "nouveau",
        status,
        ms: Date.now() - started,
        ...(fin.firstMs === undefined ? {} : { firstMs: fin.firstMs }),
        ...(fin.inTokens === undefined ? {} : { inTokens: fin.inTokens, outTokens: fin.outTokens }),
        dialogue,
        episodes: sources.episodes,
      });
    });
  } else {
    // Un texte déjà gardé (ou en cours pour un autre) : servi sans appel au modèle.
    const status = entry.state === "running" || entry.state === "ok" ? "ok" : entry.state;
    logJusquici({ ...base, cache, status, ms: Date.now() - started, dialogue, episodes: sources.episodes });
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
      stop = sofarSubscribe(held, (e) => {
        if (e.t === "text") return send(e);
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
