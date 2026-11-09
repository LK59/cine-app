import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Un appel Anthropic interrompu se paie, et le plafond mensuel le compte (10.28.1, DECISIONS.md §140). Avant :
// la dépense n'était écrite que dans `stream.finalMessage().then(...)` ; interrompu, `finalMessage()` rejette
// (`APIUserAbortError`) et rien n'était compté — or le filet des noms, le premier passage redemandé, le panneau
// refermé et le chien de garde interrompent tous le flux. Le SDK est le vrai (`MessageStream`, 1.6.0) : seul
// le transport est un double, qui rejoue les événements d'Anthropic ligne par ligne. Aucun appel réseau.

await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-ai-abort-"));
});

vi.mock("@/lib/config", () => ({
  config: {
    ask: { enabled: true, audience: "tous", personAudience: "tous", sofarAudience: "tous" },
    xray: { enabled: true, audience: "tous", url: "http://xray", apiKey: "x" },
    recap: { enabled: false },
    subtitleGen: { provider: "anthropic", apiKey: "sk-test", budgetUsd: "50" },
    jellyfin: { url: "http://jf", apiKey: "k" },
    app: { language: "fr" },
  },
}));
const sessions: Record<string, { jfId?: string; jfUser?: string; role: string }> = {};
vi.mock("@/lib/session", () => ({ verifySessionFull: vi.fn(async (token?: string) => (token ? sessions[token] ?? null : null)) }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/jellyfinAuth", () => ({ jellyfinAuthHeaders: () => ({}) }));
const { fetchMock, logError, askLog, sofarLog, transport } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  logError: vi.fn(),
  askLog: vi.fn(),
  sofarLog: vi.fn(),
  /** Ce que le « réseau » d'Anthropic rejoue au prochain appel : les événements, et si le flux reste ouvert. */
  transport: { events: [] as unknown[], hang: false, calls: 0 },
}));
vi.mock("@/lib/jellyfinBreaker", () => ({ jellyfinFetch: fetchMock }));
vi.mock("@/lib/logger", () => ({ logError: (...a: unknown[]) => logError(...a) }));
vi.mock("@/lib/eventLogs", () => ({ logAskQuestion: (...a: unknown[]) => askLog(...a), logJusquici: (...a: unknown[]) => sofarLog(...a), logRecap: vi.fn() }));
vi.mock("@/lib/xray/person", () => ({
  actorFactsForAsk: vi.fn(async () => null),
  castPerson: async (_itemId: string, personId: number) =>
    personId === 2 ? { person: { personId: 2, name: "Elliot Page", character: "Ariadne", order: 1, profilePath: null }, tmdb: { kind: "movie", id: 27205 } } : null,
}));
vi.mock("@/lib/xray/scenes", () => ({ scenesForPlayer: async () => ({ status: "none", complete: false, analyzedUntil: 0, scenes: [] }) }));
// Le SDK réel, sauf le transport : `messages.stream` rend un vrai `MessageStream` nourri des événements choisis.
vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const real = await importOriginal<typeof import("@anthropic-ai/sdk")>();
  const { MessageStream } = await import("@anthropic-ai/sdk/lib/MessageStream");
  class FakeAnthropic {
    static APIConnectionTimeoutError = real.APIConnectionTimeoutError;
    static APIUserAbortError = real.APIUserAbortError;
    messages = {
      stream: (_params: unknown, opts?: { signal?: AbortSignal }) => {
        transport.calls++;
        const encoder = new TextEncoder();
        let rc!: ReadableStreamDefaultController<Uint8Array>;
        const readable = new ReadableStream<Uint8Array>({
          start(c) {
            rc = c;
            for (const e of transport.events) c.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
            if (!transport.hang) c.close();
          },
        });
        const ms = MessageStream.fromReadableStream(readable);
        const origAbort = ms.abort.bind(ms);
        // Comme le vrai transport : l'interruption coupe la connexion.
        const cut = () => {
          origAbort();
          try {
            rc.close();
          } catch {
            /* déjà fermé */
          }
        };
        ms.abort = cut;
        opts?.signal?.addEventListener("abort", cut, { once: true });
        return ms;
      },
    };
  }
  return { ...real, default: FakeAnthropic };
});

import { currentAskModel, resetAskCachesForTests, setAskModelForTests } from "@/lib/ask/service";
import { resetSofarForTests } from "@/lib/ask/sofar";
import { spendDb } from "@/lib/subtitleGen/store";
import { getDb } from "@/lib/db";
import { partialAnthropicUsage } from "@/lib/aiFeatures";

const MOVIE = "a".repeat(32);
const ticks = (s: number) => s * 10_000_000;
const SRT = "1\n00:05:00,000 --> 00:05:02,000\nAriadne construit le labyrinthe.";
const movie = {
  Id: MOVIE,
  Type: "Movie",
  Name: "Inception",
  ProductionYear: 2010,
  Overview: "Dom Cobb vole des secrets dans les rêves.",
  People: [
    { Name: "Leonardo DiCaprio", Role: "Cobb", Type: "Actor" },
    { Name: "Elliot Page", Role: "Ariadne", Type: "Actor" },
  ],
  UserData: { Played: false, PlayCount: 0, PlaybackPositionTicks: ticks(600) },
  MediaSources: [{ Id: "f".repeat(32) }],
  MediaStreams: [{ Index: 3, Type: "Subtitle", Language: "fre", IsTextSubtitleStream: true }],
};
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const start = (input = 1200, cacheRead = 300) => ({
  type: "message_start",
  message: {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: input, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead },
  },
});
const textBlock = (...texts: string[]) => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  ...texts.map((text) => ({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })),
];
const ending = (output: number) => [
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: output } },
  { type: "message_stop" },
];

function req(account: string, body: unknown, signal = new AbortController().signal): NextRequest {
  const cookies: Record<string, string> = { cine_session: account, "cine-lang": "fr" };
  return {
    headers: new Headers({ "user-agent": "Mozilla/5.0" }),
    cookies: { get: (name: string) => (cookies[name] ? { value: cookies[name] } : undefined) },
    json: async () => body,
    signal,
  } as unknown as NextRequest;
}
let serial = 0;
function account() {
  const name = `compte-${++serial}`;
  sessions[name] = { jfId: (serial + 900).toString(16).padStart(32, "d"), jfUser: name, role: "user" };
  return name;
}
const month = () => spendDb.month();

beforeEach(() => {
  getDb().exec("DELETE FROM subtitle_gen_spend; DELETE FROM ai_spend_days; DELETE FROM sofar_texts;");
  setAskModelForTests(null);
  resetAskCachesForTests();
  resetSofarForTests();
  Object.assign(transport, { events: [], hang: false, calls: 0 });
  askLog.mockReset();
  sofarLog.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/Subtitles/")) return new Response(SRT);
    if (url.endsWith(`/Items/${MOVIE}`)) return json(movie);
    return new Response("", { status: 404 });
  });
});

describe("le modèle des questions (Anthropic) compte chaque appel une fois, fini ou interrompu", () => {
  it("un flux interrompu : entrée et cache exacts (`message_start`), sortie au moins ce qui a été reçu", async () => {
    transport.events = [start(1200, 300), ...textBlock("NOMS: Ariadne\n\n", "Ariadne construit le labyrinthe. ")];
    transport.hang = true;
    const ctrl = new AbortController();
    const run = currentAskModel()({ system: "s", message: "m", signal: ctrl.signal, feature: "askTitle" });
    for await (const delta of run.deltas) {
      expect(delta).toBeTruthy();
      if (delta.includes("labyrinthe")) break;
    }
    ctrl.abort();
    await expect(run.done).rejects.toBeTruthy();
    const m = month();
    expect(m.requests).toBe(1);
    expect(m.inputTokens).toBe(1200);
    expect(m.cacheReadTokens).toBe(300);
    // « NOMS: Ariadne\n\nAriadne construit le labyrinthe. » : 48 caractères reçus, 12 jetons au moins.
    expect(m.outputTokens).toBeGreaterThanOrEqual(12);
    expect(m.cost).toBeGreaterThan(0);
  });

  it("un flux fini : l'usage exact de la fin (`message_delta`), une seule ligne", async () => {
    transport.events = [start(1000, 0), ...textBlock("NOMS: Ariadne\n\nAriadne construit."), ...ending(42)];
    const run = currentAskModel()({ system: "s", message: "m", feature: "askTitle" });
    for await (const delta of run.deltas) expect(delta).toBeTruthy();
    await expect(run.done).resolves.toMatchObject({ inTokens: 1000, outTokens: 42, stop: "end_turn" });
    expect(month()).toMatchObject({ requests: 1, inputTokens: 1000, outputTokens: 42 });
  });

  it("coupé avant `message_start` : rien de connu, rien de compté", () => {
    expect(partialAnthropicUsage(undefined)).toBeNull();
    expect(partialAnthropicUsage({ usage: { input_tokens: 10, output_tokens: 1 }, content: [{ type: "thinking", thinking: "x".repeat(40) }] })).toMatchObject({ inputTokens: 10, outputTokens: 10 });
  });
});

describe("par la route : chaque interruption est comptée", () => {
  it("une question rejetée par le filet des noms (le flux arrêté par `pass.abort()`) : comptée", async () => {
    transport.events = [start(1500, 0), ...textBlock("NOMS: Saito\n\n", "Saito engage Ariadne. ")];
    transport.hang = true;
    const { POST } = await import("@/app/api/cinema/ask/[itemId]/route");
    const res = await POST(req(account(), { question: "Qui est Ariadne ?", where: "lecteur", positionS: 600 }), { params: Promise.resolve({ itemId: MOVIE }) });
    expect(await res.text()).toContain('"rejected"');
    await vi.waitFor(() => expect(month().requests).toBe(1));
    expect(month().inputTokens).toBe(1500);
  });

  it("le panneau refermé pendant la réponse : `abandon` au journal (plus `ok`), et l'appel compté", async () => {
    transport.events = [start(1100, 0), ...textBlock("NOMS: Ariadne\n\n", "Ariadne construit ")];
    transport.hang = true;
    const client = new AbortController();
    const { POST } = await import("@/app/api/cinema/ask/[itemId]/route");
    const res = await POST(req(account(), { question: "Que fait Ariadne ?", where: "lecteur", positionS: 600 }, client.signal), { params: Promise.resolve({ itemId: MOVIE }) });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(transport.calls).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    client.abort();
    await vi.waitFor(() => expect(askLog).toHaveBeenCalled());
    expect(askLog).toHaveBeenLastCalledWith(expect.objectContaining({ status: "abandon" }));
    await vi.waitFor(() => expect(month().requests).toBe(1));
  });

  it("« Jusqu'ici » rejeté : compté une fois, gardé une heure — la réouverture ne repaie pas", async () => {
    transport.events = [start(2000, 0), ...textBlock("NOMS: Saito\n\n", "Saito engage Ariadne. ")];
    transport.hang = true;
    const { POST } = await import("@/app/api/cinema/ask/[itemId]/route");
    const body = { mode: "jusquici", personId: 2, positionS: 12 * 60 };
    const first = await POST(req(account(), body), { params: Promise.resolve({ itemId: MOVIE }) });
    expect(await first.text()).toContain('"rejected"');
    await vi.waitFor(() => expect(month().requests).toBe(1));
    const again = await POST(req(account(), body), { params: Promise.resolve({ itemId: MOVIE }) });
    expect(await again.text()).toContain('"rejected"');
    expect(transport.calls).toBe(1);
    expect(month().requests).toBe(1);
  });
});
