import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// « Jusqu'ici » (DECISIONS.md §139, 10.27) et les pannes du modèle : la coupe à la tranche de dix minutes,
// le texte gardé par ce qui part au modèle (partagé entre comptes qui ont vu la même chose, jamais au-delà),
// trente jours en base, jamais un rejet ; la préparation en fond bornée ; et chaque panne — 5xx, 429, refus,
// délai, flux coupé — dite proprement, au journal du serveur et à `recherche.log`. Jellyfin, TMDB et le
// modèle sont des doubles — aucun appel réseau ne part.

await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-sofar-"));
});

vi.mock("@/lib/config", () => ({
  config: {
    ask: { enabled: true, audience: "tous" },
    recap: { enabled: false },
    subtitleGen: { provider: "anthropic", apiKey: "sk-test" },
    jellyfin: { url: "http://jf", apiKey: "k" },
    app: { language: "fr" },
  },
}));
const sessions: Record<string, { jfId?: string; jfUser?: string; role: string }> = {};
vi.mock("@/lib/session", () => ({
  verifySessionFull: vi.fn(async (token?: string) => (token ? sessions[token] ?? null : null)),
}));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/jellyfinAuth", () => ({ jellyfinAuthHeaders: () => ({}) }));
const { fetchMock, logError, askLog, sofarLog } = vi.hoisted(() => ({ fetchMock: vi.fn(), logError: vi.fn(), askLog: vi.fn(), sofarLog: vi.fn() }));
vi.mock("@/lib/jellyfinBreaker", () => ({ jellyfinFetch: fetchMock }));
vi.mock("@/lib/logger", () => ({ logError: (...args: unknown[]) => logError(...args) }));
vi.mock("@/lib/eventLogs", () => ({
  logAskQuestion: (...args: unknown[]) => askLog(...args),
  logJusquici: (...args: unknown[]) => sofarLog(...args),
  logRecap: vi.fn(),
}));
// La personne est cherchée dans la distribution de l'élément : Ariadne, jouée par Elliot Page.
vi.mock("@/lib/xray/person", () => ({
  castPerson: async (_itemId: string, personId: number) =>
    personId === 2 ? { person: { personId: 2, name: "Elliot Page", character: "Ariadne", order: 1, profilePath: null }, tmdb: { kind: "movie", id: 27205 } } : null,
}));

import { setAskModelForTests, resetAskCachesForTests, AskModelTimeout, type AskModel } from "@/lib/ask/service";
import { resetSofarForTests, sofarCutoff, SOFAR_KEEP_MS } from "@/lib/ask/sofar";
import { SOFAR_PREWARM_PER_HOUR } from "@/lib/ask/sofarRequest";
import { getDb, sofarDb } from "@/lib/db";

const MOVIE = "a".repeat(32);
const ticks = (s: number) => s * 10_000_000;
const SRT = [
  "1\n00:05:00,000 --> 00:05:02,000\nAriadne construit le labyrinthe.",
  "2\n00:14:00,000 --> 00:14:02,000\nAriadne entre dans le rêve. APRES-LA-COUPE",
  "3\n01:30:00,000 --> 01:30:02,000\nFischer accepte l'idée. FIN-DU-FILM",
].join("\n\n");
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

function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function scripted(text: string, seen: string[] = [], stop = "end_turn"): AskModel {
  return ({ message }) => {
    seen.push(message);
    async function* deltas() {
      for (let i = 0; i < text.length; i += 7) yield text.slice(i, i + 7);
    }
    return { deltas: deltas(), done: Promise.resolve({ inTokens: 1000, outTokens: 50, stop }) };
  };
}
function failing(err: unknown): AskModel {
  return () => {
    async function* deltas(): AsyncGenerator<string> {
      throw err;
    }
    const done = Promise.reject(err);
    done.catch(() => {});
    return { deltas: deltas(), done };
  };
}

function req(account: string, body: unknown): NextRequest {
  const cookies: Record<string, string> = { cine_session: account, "cine-lang": "fr" };
  return {
    headers: new Headers({ "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)" }),
    cookies: { get: (name: string) => (cookies[name] ? { value: cookies[name] } : undefined) },
    json: async () => body,
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

async function post(account: string, body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/cinema/ask/[itemId]/route");
  const res = await POST(req(account, body), { params: Promise.resolve({ itemId: MOVIE }) });
  const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: string; v?: string; code?: string });
  return { status: res.status, events, text: events.filter((e) => e.t === "text").map((e) => e.v).join(" ") };
}
const sofar = (account: string, extra: Record<string, unknown> = {}) => post(account, { mode: "jusquici", personId: 2, positionS: 12 * 60, ...extra });
const question = (account: string) => post(account, { question: "Que vient-il de se passer ?", where: "lecteur", positionS: 600 });
/** Les générations détachées finissent après la réponse : on laisse passer leurs tours. */
const settle = () => new Promise((r) => setTimeout(r, 20));

let serial = 0;
function account(extra: Partial<{ jfId: string; role: string }> = {}) {
  const name = `compte-${++serial}`;
  sessions[name] = { jfId: (serial + 300).toString(16).padStart(32, "d"), jfUser: name, role: "user", ...extra };
  return name;
}

beforeEach(() => {
  fetchMock.mockReset();
  askLog.mockReset();
  sofarLog.mockReset();
  logError.mockReset();
  resetAskCachesForTests();
  resetSofarForTests();
  getDb().prepare("DELETE FROM sofar_texts").run();
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/Subtitles/")) return new Response(SRT);
    if (url.endsWith(`/Items/${MOVIE}`)) return json(movie);
    return new Response("", { status: 404 });
  });
});

describe("la coupe : le début de la tranche de dix minutes", () => {
  it("12 min → 10 min ; 9 min 59 → rien ; jamais de négatif", () => {
    expect(sofarCutoff(12 * 60)).toBe(600);
    expect(sofarCutoff(599)).toBe(0);
    expect(sofarCutoff(-5)).toBe(0);
    expect(sofarCutoff(null)).toBe(0);
  });

  it("aucune réplique après le début de la tranche — même vue à 12 min, celle de 14 min ne part pas", async () => {
    const seen: string[] = [];
    setAskModelForTests(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe.", seen));
    const r = await sofar(account(), { positionS: 14 * 60 + 30 });
    expect(r.text).toBe("Ariadne construit le labyrinthe.");
    expect(seen[0]).toContain("Ariadne construit le labyrinthe.");
    expect(seen[0]).not.toContain("APRES-LA-COUPE");
    expect(seen[0]).not.toContain("FIN-DU-FILM");
    expect(seen[0]).toContain("Ariadne (joué par Elliot Page)");
  });
});

describe("gardé par ce qui part au modèle", () => {
  it("deux comptes au même endroit : un seul appel, le second lit `partagé` ; le même compte, `compte`", async () => {
    const model = vi.fn(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe."));
    setAskModelForTests(model);
    const a = account();
    const b = account();
    await sofar(a);
    await settle();
    const second = await sofar(b, { positionS: 19 * 60 });
    expect(second.text).toBe("Ariadne construit le labyrinthe.");
    await sofar(a, { positionS: 11 * 60 });
    expect(model).toHaveBeenCalledTimes(1);
    const caches = sofarLog.mock.calls.map(([f]) => (f as { cache: string }).cache);
    expect(caches).toEqual(expect.arrayContaining(["nouveau", "partagé", "compte"]));
  });

  it("une autre tranche, ou un compte qui a vu autre chose : une autre clé, un autre appel", async () => {
    const model = vi.fn(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe."));
    setAskModelForTests(model);
    const a = account();
    await sofar(a, { positionS: 12 * 60 });
    await sofar(a, { positionS: 25 * 60 });
    expect(model).toHaveBeenCalledTimes(2);
  });

  it("gardé trente jours en base, puis effacé par le ménage ; un rejet n'est jamais gardé", async () => {
    setAskModelForTests(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe."));
    await sofar(account());
    await settle();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM sofar_texts").get()).toEqual({ n: 1 });
    // Un texte « relu » après son mois ne vaut plus.
    getDb().prepare("UPDATE sofar_texts SET created_at = ?").run(Date.now() - SOFAR_KEEP_MS - 1000);
    expect(sofarDb.prune(SOFAR_KEEP_MS)).toBe(1);

    const model = vi.fn(scripted("NOMS: Saito\n\nSaito engage Ariadne."));
    setAskModelForTests(model);
    const r = await sofar(account());
    expect(r.events).toEqual([{ t: "rejected" }]);
    await settle();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM sofar_texts").get()).toEqual({ n: 0 });
    // Pas gardé : la demande suivante redemande.
    await sofar(account());
    expect(model).toHaveBeenCalledTimes(2);
  });

  it("« rien à dire » (RIEN) : aucune phrase rendue, gardé pour ne pas redemander", async () => {
    const model = vi.fn(scripted("NOMS: —\n\nRIEN"));
    setAskModelForTests(model);
    const r = await sofar(account());
    expect(r.events).toEqual([{ t: "rejected" }]);
    await settle();
    await sofar(account());
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("une personne absente de la distribution de cet élément : « indisponible », le modèle n'est pas appelé", async () => {
    const model = vi.fn();
    setAskModelForTests(model);
    const r = await sofar(account(), { personId: 99 });
    expect(r.events).toEqual([{ t: "error", code: "indisponible" }]);
    expect(model).not.toHaveBeenCalled();
  });
});

describe("préparé en fond", () => {
  it("répond aussitôt `queued`, génère une fois, et le panneau lit le même texte", async () => {
    const model = vi.fn(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe."));
    setAskModelForTests(model);
    const a = account();
    const warm = await sofar(a, { prewarm: true });
    expect(warm.events).toEqual([{ t: "queued" }]);
    const open = await sofar(a);
    expect(open.text).toBe("Ariadne construit le labyrinthe.");
    expect(model).toHaveBeenCalledTimes(1);
    await settle();
    expect(sofarLog).toHaveBeenCalledWith(expect.objectContaining({ prewarm: true, cache: "nouveau", status: "ok" }));
    // Jamais le texte au journal.
    expect(JSON.stringify(sofarLog.mock.calls)).not.toContain("labyrinthe");
  });

  it(`${SOFAR_PREWARM_PER_HOUR} préparations par heure et par compte, puis « limite » — un texte gardé ne compte pas`, async () => {
    let n = 0;
    setAskModelForTests((req) => scripted(`NOMS: Ariadne\n\nAriadne construit le labyrinthe numéro ${++n}.`)(req));
    const a = account();
    for (let i = 0; i < SOFAR_PREWARM_PER_HOUR; i++) await sofar(a, { prewarm: true, positionS: (i + 1) * 600 + 1 });
    const over = await sofar(a, { prewarm: true, positionS: (SOFAR_PREWARM_PER_HOUR + 5) * 600 });
    expect(over.events).toEqual([{ t: "error", code: "limite" }]);
    // Déjà gardé : servi sans compter.
    await settle();
    const kept = await sofar(a, { prewarm: true, positionS: 601 });
    expect(kept.events).toEqual([{ t: "queued" }]);
  });
});

describe("les pannes du modèle : dites proprement, jamais gardées", () => {
  const cases: [string, unknown][] = [
    ["une erreur 500", Object.assign(new Error("boom"), { status: 500 })],
    ["un réseau coupé", new TypeError("fetch failed")],
    ["vingt secondes sans rien", new AskModelTimeout()],
  ];
  for (const [label, err] of cases) {
    it(`${label} : la question finit par « erreur », au journal du serveur et à recherche.log`, async () => {
      setAskModelForTests(failing(err));
      const r = await question(account());
      expect(r.events).toEqual([{ t: "error", code: "erreur" }]);
      expect(logError).toHaveBeenCalledWith("ask/model", err);
      expect(askLog).toHaveBeenLastCalledWith(expect.objectContaining({ status: "erreur" }));
    });
    it(`${label} : « Jusqu'ici » ne rend rien, n'est pas gardé, et la cause va au journal du serveur`, async () => {
      setAskModelForTests(failing(err));
      const r = await sofar(account());
      expect(r.events).toEqual([{ t: "error", code: "erreur" }]);
      await settle();
      expect(logError).toHaveBeenCalledWith("ask/jusquici", err, expect.anything());
      expect(sofarLog).toHaveBeenCalledWith(expect.objectContaining({ status: "erreur" }));
      expect(getDb().prepare("SELECT COUNT(*) AS n FROM sofar_texts").get()).toEqual({ n: 0 });
    });
  }

  it("un 429 : « limite » pour la question, sans bruit au journal du serveur", async () => {
    setAskModelForTests(failing(Object.assign(new Error("rate"), { status: 429 })));
    const r = await question(account());
    expect(r.events).toEqual([{ t: "error", code: "limite" }]);
    expect(logError).not.toHaveBeenCalledWith("ask/model", expect.anything());
  });

  it("un refus du modèle (`stop_reason: refusal`) : une panne, pas un « je ne sais pas »", async () => {
    setAskModelForTests(scripted("NOMS: —\n\nLe film parle de rêves.", [], "refusal"));
    const q = await question(account());
    expect(q.events.at(-1)).toEqual({ t: "error", code: "erreur" });
    expect(logError).toHaveBeenCalledWith("ask/model", expect.objectContaining({ message: expect.stringContaining("refusal") }));
    setAskModelForTests(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe.", [], "refusal"));
    const s = await sofar(account());
    expect(s.events.at(-1)).toEqual({ t: "error", code: "erreur" });
  });

  it("un flux fini sans sa fin (le message final illisible) : une panne", async () => {
    setAskModelForTests(() => {
      async function* deltas() {
        yield "NOMS: —\n\nLe film parle de rêves.";
      }
      const done = Promise.reject(new Error("stream ended without message_stop"));
      done.catch(() => {});
      return { deltas: deltas(), done };
    });
    const r = await question(account());
    expect(r.events.at(-1)).toEqual({ t: "error", code: "erreur" });
  });
});
