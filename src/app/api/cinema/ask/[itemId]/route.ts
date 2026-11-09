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
import { askAvailableFor, currentAskModel, gatherAskContext, warmDialogues } from "@/lib/ask/service";
import {
  AnswerGate,
  ASK_MAX_EXCHANGES,
  ASK_MAX_PREVIOUS_ANSWER,
  ASK_MAX_QUESTION,
  askMessage,
  askSources,
  askSystem,
  askWhereLine,
  positionBucket,
  type AskWhere,
  type PreviousExchange,
} from "@/lib/ask/core";

export const dynamic = "force-dynamic";

/**
 * « Poser une question » sur un titre (DECISIONS.md §139).
 *
 * `GET` : `{ available }`, et — option allumée — les dialogues de ce que le compte regarde demandés
 * d'avance (`warmDialogues`), sans rien attendre : le panneau l'appelle à son ouverture.
 *
 * `POST { question, where, positionS?, previous? }` : la réponse, **diffusée** en lignes JSON
 * (`application/x-ndjson`) — `{"t":"text","v":"…"}` pour chaque phrase vérifiée, puis une fin :
 * `{"t":"done"}`, `{"t":"rejected"}` (un nom absent des sources : l'écran dit « Je ne sais pas d'après
 * ce qui a été vu »), ou `{"t":"error","code":"off"|"limite"|"indisponible"|"erreur"}`. Toujours 200 :
 * une absence attendue n'est jamais un 404 (CLAUDE.md), et l'écran n'a qu'un chemin à lire.
 *
 * Ce qui est vu est lu sous l'identité du compte (`gatherAskContext`) : un titre caché répond
 * `indisponible`, comme un titre inconnu. Réglée sur `admins`, l'option répond « off » à tout autre compte.
 * Un lien de partage n'y passe que pour son titre (`SHARE_RULES`,
 * portée `path`). Bornée par compte : 30 questions par heure, 100 par jour. Une ligne par question dans
 * `recherche.log` (`logAskQuestion`) — jamais la question ni la réponse.
 */
const perHour = createRateLimiter(30, 60 * 60 * 1000);
const perDay = createRateLimiter(100, 24 * 60 * 60 * 1000);

const PRIVATE = { "Cache-Control": "private, no-store" };
const STREAM_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "private, no-store",
  // Le relais ne doit pas retenir les phrases jusqu'à la fin.
  "X-Accel-Buffering": "no",
};

type Event = { t: "text"; v: string } | { t: "done" } | { t: "rejected" } | { t: "error"; code: "off" | "limite" | "indisponible" | "erreur" };

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
  const available = askAvailableFor(session);
  if (available && session.jfId) void warmDialogues(session.jfId, itemId, localeOf(req, session.jfId));
  return NextResponse.json({ available }, { headers: PRIVATE });
}

/** Le corps, lu avec méfiance : tout ce qui n'a pas la forme attendue est écarté, pas deviné. */
function readBody(body: unknown): { question: string; where: AskWhere; positionS: number | null; previous: PreviousExchange[] } | null {
  const b = body as { question?: unknown; where?: unknown; positionS?: unknown; previous?: unknown } | null;
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
  return { question, where, positionS, previous };
}

export async function POST(req: NextRequest, props: { params: Promise<{ itemId: string }> }) {
  const { itemId } = await props.params;
  if (!isJellyfinId(itemId)) return NextResponse.json({ error: "itemId invalide" }, { status: 400 });
  const session = await verifySessionFull(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  const body = readBody(await req.json().catch(() => null));
  if (!body) return NextResponse.json({ error: "Question manquante" }, { status: 400 });
  // La porte : l'option et son public (`admins` : un compte ordinaire reçoit la même réponse qu'option coupée).
  if (!askAvailableFor(session)) return oneShot({ t: "error", code: "off" });

  const started = Date.now();
  const who = {
    user: session.jfUser ?? session.u ?? "anonyme",
    device: requestDeviceLabel(req),
    itemId,
    where: body.where,
    bucket: positionBucket(body.where === "lecteur" ? body.positionS : null),
    turn: body.previous.length + 1,
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
  try {
    context = await gatherAskContext(account, itemId, body.where, body.positionS, locale);
  } catch (err) {
    logError("ask/context", err);
    logAskQuestion({ ...who, status: "erreur", ms: Date.now() - started });
    return oneShot({ t: "error", code: "erreur" });
  }
  if (context.status !== "ok") {
    logAskQuestion({ ...who, status: "indisponible", ms: Date.now() - started });
    return oneShot({ t: "error", code: "indisponible" });
  }

  const sources = askSources(context.input);
  const message = askMessage(sources, askWhereLine(context.input), body.previous, body.question);
  const gate = new AnswerGate(sources.check);
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
      let tokens: { inTokens?: number; outTokens?: number } = {};
      const release = (sentences: string[]) => {
        for (const s of sentences) {
          firstMs ??= Date.now() - started;
          send({ t: "text", v: s });
        }
      };
      try {
        const run = currentAskModel()({ system: askSystem(locale), message, signal: abort.signal });
        // Attachée tout de suite : une panne du flux rejette aussi `done`, qui ne doit pas rester sans lecteur.
        const done = run.done.catch(() => null);
        let rejected = false;
        for await (const delta of run.deltas) {
          const out = gate.push(delta);
          release(out.release);
          if (out.rejected) {
            rejected = true;
            abort.abort();
            break;
          }
        }
        if (!rejected) {
          const out = gate.end();
          release(out.release);
          rejected = !!out.rejected;
        }
        const fin = rejected ? null : await done;
        if (fin) tokens = { inTokens: fin.inTokens, outTokens: fin.outTokens };
        // Rien de rendu (refus du modèle, réponse vide, coupée dans la ligne des noms) : « je ne sais pas ».
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
        logAskQuestion({ ...who, status, ms: Date.now() - started, ...(firstMs === undefined ? {} : { firstMs }), ...tokens, dialogue, episodes: sources.episodes });
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
