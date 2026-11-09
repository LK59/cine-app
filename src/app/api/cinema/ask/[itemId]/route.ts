import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { verifySessionFull } from "@/lib/session";
import { isJellyfinId } from "@/lib/jellyfinPath";
import { createRateLimiter } from "@/lib/rateLimiter";
import { LOCALE_COOKIE, type Locale } from "@/lib/i18n";
import { accountLocale } from "@/lib/recap/service";
import { logError } from "@/lib/logger";
import { logAskQuestion } from "@/lib/eventLogs";
import { requestDeviceLabel } from "@/lib/deviceLabel";
import { ASK_MAX_OUTPUT_TOKENS, askAvailableFor, currentAskModel, gatherAskContext, prepareAskContext } from "@/lib/ask/service";
import { aiBudgetReached, askPersonAvailableFor, sofarAvailableFor } from "@/lib/aiFeatures";
import { answerSofar, readSofarBody } from "@/lib/ask/sofarRequest";
import { actorFactsForAsk } from "@/lib/xray/person";
import {
  AnswerGate,
  ASK_MAX_EXCHANGES,
  ASK_MAX_PREVIOUS_ANSWER,
  ASK_MAX_QUESTION,
  askParts,
  askSources,
  askSystem,
  askWhereLine,
  actorFactsText,
  metaReminder,
  positionBucket,
  type AskActorFacts,
  type AskWhere,
  type PreviousExchange,
} from "@/lib/ask/core";

export const dynamic = "force-dynamic";

/**
 * « Poser une question » sur un titre (DECISIONS.md §139).
 *
 * `GET` : `{ available }`, et — option allumée — les dialogues de ce que le compte regarde demandés
 * d'avance, et l'élément, sa série et ses épisodes gardés en mémoire (`prepareAskContext`, 10.27.2), sans rien
 * attendre : le lecteur l'appelle à l'ouverture d'un film ou d'un épisode, le panneau à la sienne.
 *
 * `POST { question, where, positionS?, previous?, personId? }` : la réponse, **diffusée** en lignes JSON
 * (`application/x-ndjson`) — `{"t":"text","v":"…"}` pour chaque phrase vérifiée, puis une fin :
 * `{"t":"done"}`, `{"t":"rejected"}` (un nom absent des sources : l'écran dit « Je ne sais pas d'après
 * ce qui a été vu »), ou `{"t":"error","code":"off"|"limite"|"indisponible"|"erreur"}`. Toujours 200 :
 * une absence attendue n'est jamais un 404 (CLAUDE.md), et l'écran n'a qu'un chemin à lire.
 *
 * Ce qui est vu est lu sous l'identité du compte (`gatherAskContext`) : un titre caché répond
 * `indisponible`, comme un titre inconnu. Réglée sur `admins`, l'option répond « off » à tout autre compte.
 * Un lien de partage n'y passe que pour son titre (`SHARE_RULES`,
 * portée `path`). Bornée par compte : 60 questions par heure, 300 par jour (10.27 : le propriétaire ne veut
 * pas brider — les bornes ne gardent que d'un client qui boucle). Une ligne par question dans
 * `recherche.log` (`logAskQuestion`) — jamais la question ni la réponse.
 *
 * `POST { mode: "jusquici", personId, positionS, prewarm? }` : « Jusqu'ici », deux phrases sur un
 * personnage d'« À l'écran » (`answerSofar`, `src/lib/ask/sofarRequest.ts`) — mêmes réponses.
 *
 * **Trois portes, une par réglage** (09/11/2026, §139) : une question sur le titre (`ASK_ENABLED`), une
 * question posée depuis le panneau d'une personne (`about: "person"`, `ASK_PERSON_ENABLED` et les acteurs
 * à l'écran), « Jusqu'ici » (`SOFAR_ENABLED` et les acteurs à l'écran). Chacune répond `off` quand elle
 * est fermée à cette session. Le plafond mensuel atteint (§140) : `{"t":"error","code":"budget"}` pour une
 * question (l'écran le dit), et pour « Jusqu'ici » (l'écran se tait).
 *
 * `personId` (10.27.2) : la question est posée depuis le panneau d'une personne d'« À l'écran » — ses faits
 * réels (TMDB : naissance, décès, lieu, biographie, `actorFactsForAsk`) partent avec, et la date de
 * diffusion de l'épisode ou de sortie du film est dans les sources : « quel âge a cette actrice pendant cet
 * épisode ? » se répond. La personne est cherchée dans la distribution de l'élément, jamais crue.
 *
 * Chaque phrase passe aussi le filet des mots de coulisse (`metaTalk`, 10.27.2) : une réponse qui parle de
 * « sources » avant toute phrase rendue est redemandée **une fois** avec un rappel (`metaReminder`) ; sinon
 * la phrase est reformulée ou remplacée par une limite dite naturellement. `meta` au journal.
 *
 * Une panne du modèle — réseau, 5xx, 429, refus (`stop_reason: "refusal"`), vingt secondes sans rien
 * (`MODEL_IDLE_MS`), flux coupé — finit par `{"t":"error","code":"erreur"|"limite"}`, sa cause dans
 * `server.log` (`ask/model`), `erreur` au journal ; l'écran propose « Réessayer ».
 */
export const ASK_PER_HOUR = 60;
export const ASK_PER_DAY = 300;
const perHour = createRateLimiter(ASK_PER_HOUR, 60 * 60 * 1000);
const perDay = createRateLimiter(ASK_PER_DAY, 24 * 60 * 60 * 1000);

const PRIVATE = { "Cache-Control": "private, no-store" };
const STREAM_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "private, no-store",
  // Le relais ne doit pas retenir les phrases jusqu'à la fin.
  "X-Accel-Buffering": "no",
};

type Event = { t: "text"; v: string } | { t: "done" } | { t: "rejected" } | { t: "error"; code: "off" | "limite" | "indisponible" | "erreur" | "budget" };

function oneShot(event: Event): NextResponse {
  return new NextResponse(`${JSON.stringify(event)}\n`, { status: 200, headers: STREAM_HEADERS });
}

function localeOf(req: NextRequest, jfId: string): Locale {
  const raw = req.cookies.get(LOCALE_COOKIE)?.value ?? "";
  return raw === "fr" || raw === "en" || raw === "es" || raw === "de" ? raw : accountLocale(jfId);
}

export async function GET(req: NextRequest, props: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await props.params;
  if (!isJellyfinId(itemId)) return NextResponse.json({ error: "itemId invalide" }, { status: 400 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  const available = askAvailableFor(session) || askPersonAvailableFor(session);
  if (available && session.jfId) void prepareAskContext(session.jfId, itemId, localeOf(req, session.jfId));
  return NextResponse.json({ available }, { headers: PRIVATE });
}

/** Le corps, lu avec méfiance : tout ce qui n'a pas la forme attendue est écarté, pas deviné. */
function readBody(
  body: unknown
): { question: string; where: AskWhere; positionS: number | null; previous: PreviousExchange[]; personId: number | null; about: "title" | "person" } | null {
  const b = body as { question?: unknown; where?: unknown; positionS?: unknown; previous?: unknown; personId?: unknown; about?: unknown } | null;
  if (!b || typeof b.question !== "string") return null;
  const question = b.question.trim().slice(0, ASK_MAX_QUESTION);
  if (!question) return null;
  const where: AskWhere = b.where === "lecteur" ? "lecteur" : "fiche";
  const raw = typeof b.positionS === "number" && Number.isFinite(b.positionS) && b.positionS >= 0 ? b.positionS : null;
  const positionS = where === "lecteur" && raw !== null ? Math.floor(raw) : null;
  const previous = (Array.isArray(b.previous) ? b.previous : [])
    .filter((p): p is { question: string; answer: string } => typeof p?.question === "string" && typeof p?.answer === "string")
    .slice(-(ASK_MAX_EXCHANGES - 1))
    .map((p) => ({ question: p.question.trim().slice(0, ASK_MAX_QUESTION), answer: p.answer.trim().slice(0, ASK_MAX_PREVIOUS_ANSWER) }));
  const personId = typeof b.personId === "number" && Number.isInteger(b.personId) && b.personId > 0 ? b.personId : null;
  // Une question qui porte une personne est une question sur une personne : sa porte (`ASK_PERSON_ENABLED`),
  // même si le client oubliait de le dire — la porte la plus étroite, jamais la plus large.
  return { question, where, positionS, previous, personId, about: b.about === "person" || personId !== null ? "person" : "title" };
}

export async function POST(req: NextRequest, props: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await props.params;
  if (!isJellyfinId(itemId)) return NextResponse.json({ error: "itemId invalide" }, { status: 400 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  const raw = await req.json().catch(() => null);
  const sofar = readSofarBody(raw);
  const body = sofar ? null : readBody(raw);
  if (!sofar && !body) return NextResponse.json({ error: "Question manquante" }, { status: 400 });
  // La porte : l'option et son public (`admins` : un compte ordinaire reçoit la même réponse qu'option coupée)
  // — une par réglage (§139) : titre, personne, « Jusqu'ici ».
  const open = sofar ? sofarAvailableFor(session) : body?.about === "person" ? askPersonAvailableFor(session) : askAvailableFor(session);
  if (!open) return oneShot({ t: "error", code: "off" });
  // Le plafond mensuel commun atteint (§140) : rien ne part chez le fournisseur. « Jusqu'ici » sert encore
  // ses textes gardés, et ne refuse que ce qu'il faudrait écrire (`answerSofar`).
  if (!sofar && aiBudgetReached()) return oneShot({ t: "error", code: "budget" });
  if (sofar) {
    if (!session.jfId) return oneShot({ t: "error", code: "indisponible" });
    const user = session.jfUser ?? session.u ?? "anonyme";
    return answerSofar({ user, device: requestDeviceLabel(req), account: session.jfId, locale: localeOf(req, session.jfId), signal: req.signal }, itemId, sofar);
  }
  if (!body) return NextResponse.json({ error: "Question manquante" }, { status: 400 });

  const started = Date.now();
  const who = {
    user: session.jfUser ?? session.u ?? "anonyme",
    device: requestDeviceLabel(req),
    itemId,
    where: body.where,
    bucket: positionBucket(body.where === "lecteur" ? body.positionS : null),
    turn: body.previous.length + 1,
    ...(body.personId ? { personId: body.personId } : {}),
  };
  // Une session sans compte Jellyfin (l'administrateur du .env) n'a rien de « vu » à lire.
  if (!session.jfId) {
    logAskQuestion({ ...who, status: "indisponible", ms: 0 });
    return oneShot({ t: "error", code: "indisponible" });
  }
  const account = session.jfId;
  if (!perHour(account) || !perDay(account)) {
    logAskQuestion({ ...who, status: "limite", ms: 0 });
    return oneShot({ t: "error", code: "limite" });
  }

  const locale = localeOf(req, account);
  let context: Awaited<ReturnType<typeof gatherAskContext>>;
  let actor: AskActorFacts | null = null;
  try {
    // Les faits de la personne ne retardent rien : lus en même temps, et une panne les laisse de côté.
    [context, actor] = await Promise.all([
      gatherAskContext(account, itemId, body.where, body.positionS, locale),
      body.personId ? actorFactsForAsk(itemId, body.personId, locale) : Promise.resolve(null),
    ]);
  } catch (err) {
    logError("ask/context", err);
    logAskQuestion({ ...who, status: "erreur", ms: Date.now() - started });
    return oneShot({ t: "error", code: "erreur" });
  }
  const contextMs = Date.now() - started;
  if (context.status !== "ok") {
    logAskQuestion({ ...who, status: "indisponible", ms: Date.now() - started, contextMs });
    return oneShot({ t: "error", code: "indisponible" });
  }

  const sources = askSources(context.input);
  const { message, prefixEnd } = askParts(sources, askWhereLine(context.input), body.previous, body.question, actor);
  // Les noms des faits réels passent le filet : la biographie montrée par le panneau en contient.
  const check = actor ? `${sources.check}\n${actorFactsText(actor)}` : sources.check;
  const abort = new AbortController();
  // Le panneau refermé, la page quittée : le modèle s'arrête aussi.
  req.signal?.addEventListener?.("abort", () => abort.abort(), { once: true });
  const dialogue: boolean | "attente" = context.dialogueLate ? "attente" : sources.dialogue;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: Event) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          /* le lecteur est parti */
        }
      };
      let firstMs: number | undefined;
      let status: "ok" | "rejeté" | "limite" | "erreur" = "ok";
      let tokens: { inTokens?: number; outTokens?: number; cacheWrite?: number; cacheRead?: number } = {};
      const meta = { regenerated: false, rewritten: false };
      // Les étapes (10.27.2) : du départ vers le modèle au premier morceau, puis à la première phrase rendue.
      let modelAt: number | undefined;
      let ttftMs: number | undefined;
      let firstSentenceMs: number | undefined;
      const release = (sentences: string[]) => {
        for (const s of sentences) {
          firstMs ??= Date.now() - started;
          if (modelAt !== undefined) firstSentenceMs ??= Date.now() - modelAt;
          send({ t: "text", v: s });
        }
      };
      try {
        // Deux passages au plus : le second seulement si le premier parlait de « sources » avant d'avoir
        // rendu quoi que ce soit (`retry` du filet) — avec le rappel, et sans droit à un troisième.
        let fin: { inTokens: number; outTokens: number; stop: string | null; cacheWrite?: number; cacheRead?: number } | null = null;
        let rejected = false;
        for (let attempt = 0; ; attempt++) {
          const gate = new AnswerGate(check, undefined, { locale, sources: sources.text, retry: attempt === 0, onMeta: "replace" });
          const pass = new AbortController();
          const stopPass = () => pass.abort();
          abort.signal.addEventListener("abort", stopPass, { once: true });
          modelAt ??= Date.now();
          const run = currentAskModel()({ system: askSystem(locale), message: attempt ? message + metaReminder(locale) : message, prefixEnd, maxTokens: ASK_MAX_OUTPUT_TOKENS, signal: pass.signal, feature: body.about === "person" ? "askPerson" : "askTitle" });
          // Attachée tout de suite : une panne du flux rejette aussi `done`, qui ne doit pas rester sans lecteur.
          const done = run.done.catch((failure: unknown) => ({ failure }));
          let retry = false;
          for await (const delta of run.deltas) {
            ttftMs ??= Date.now() - (modelAt ?? started);
            const out = gate.push(delta);
            release(out.release);
            if (out.rejected) {
              rejected = true;
              pass.abort();
              break;
            }
            if (out.retry) {
              retry = true;
              pass.abort();
              break;
            }
          }
          if (!rejected && !retry) {
            const out = gate.end();
            release(out.release);
            rejected = !!out.rejected;
            retry = !!out.retry;
          }
          abort.signal.removeEventListener("abort", stopPass);
          if (gate.rewritten) meta.rewritten = true;
          if (retry) {
            meta.regenerated = true;
            continue;
          }
          const ended = rejected ? null : await done;
          // Le flux fini sans sa fin (coupé, illisible) : une panne, pas une réponse complète.
          if (ended && "failure" in ended) throw ended.failure;
          fin = ended;
          break;
        }
        if (fin)
          tokens = {
            inTokens: fin.inTokens,
            outTokens: fin.outTokens,
            ...(fin.cacheWrite === undefined ? {} : { cacheWrite: fin.cacheWrite }),
            ...(fin.cacheRead === undefined ? {} : { cacheRead: fin.cacheRead }),
          };
        // Un refus du modèle est une panne, pas un « je ne sais pas » : l'écran propose de réessayer.
        if (fin?.stop === "refusal") throw new Error("refus du modèle (stop_reason: refusal)");
        // Le plafond atteint (10.27.2) : une réponse coupée n'est pas une réponse — une panne, « Réessayer ».
        if (fin?.stop === "max_tokens") throw new Error(`réponse coupée au plafond (stop_reason: max_tokens, ${ASK_MAX_OUTPUT_TOKENS} jetons)`);
        // Rien de rendu (réponse vide, coupée dans la ligne des noms) : « je ne sais pas ».
        if (rejected || firstMs === undefined) {
          status = "rejeté";
          send({ t: "rejected" });
        } else send({ t: "done" });
      } catch (err) {
        const code = (err as { status?: number })?.status;
        if (!abort.signal.aborted || code) {
          status = code === 429 ? "limite" : "erreur";
          if (code !== 429) logError("ask/model", err);
          send({ t: "error", code: code === 429 ? "limite" : "erreur" });
        }
      } finally {
        const metaField = meta.regenerated && meta.rewritten ? "regénéré+réécrit" : meta.regenerated ? "regénéré" : meta.rewritten ? "réécrit" : null;
        logAskQuestion({
          ...who,
          status,
          ms: Date.now() - started,
          ...(firstMs === undefined ? {} : { firstMs }),
          ...tokens,
          dialogue,
          episodes: sources.episodes,
          contextMs,
          ctx: context.ctx,
          ...(ttftMs === undefined ? {} : { ttftMs }),
          ...(firstSentenceMs === undefined ? {} : { firstSentenceMs }),
          totalMs: Date.now() - started,
          ...(metaField ? { meta: metaField } : {}),
        });
        try {
          controller.close();
        } catch {
          /* déjà fermé */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new NextResponse(stream, { status: 200, headers: STREAM_HEADERS });
}
