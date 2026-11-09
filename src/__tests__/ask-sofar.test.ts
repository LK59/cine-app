import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// « Jusqu'ici » (DECISIONS.md §139, 10.27) et les pannes du modèle : la coupe à la tranche de cinq minutes
// (dix en 10.27.0),
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
    // « Jusqu'ici » demande les acteurs à l'écran (§139, 09/11/2026).
    xray: { enabled: true, audience: "tous", url: "http://xray", apiKey: "x" },
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
// Les scènes d'« À l'écran » (10.27.2) : aucune par défaut — la coupe est alors la marque des cinq minutes.
const xrayScenes = vi.hoisted(() => ({ payload: null as null | { status: string; complete: boolean; analyzedUntil: number; scenes: { start: number; end: number; people: never[] }[] } }));
vi.mock("@/lib/xray/scenes", () => ({ scenesForPlayer: async () => xrayScenes.payload ?? { status: "none", complete: false, analyzedUntil: 0, scenes: [] } }));
// La personne est cherchée dans la distribution de l'élément : Ariadne, jouée par Elliot Page.
vi.mock("@/lib/xray/person", () => ({
  castPerson: async (_itemId: string, personId: number) =>
    personId === 2 ? { person: { personId: 2, name: "Elliot Page", character: "Ariadne", order: 1, profilePath: null }, tmdb: { kind: "movie", id: 27205 } } : null,
}));

import { setAskModelForTests, resetAskCachesForTests, AskModelTimeout, type AskModel } from "@/lib/ask/service";
import { resetSofarForTests, sofarCutoff, sofarKey, sofarSources, sofarSystem, SOFAR_KEEP_MS, SOFAR_MAX_EPISODES, SOFAR_NOTHING, SOFAR_VERSION } from "@/lib/ask/sofar";
import { askContent, ASK_MODEL, SOFAR_MAX_OUTPUT_TOKENS } from "@/lib/ask/service";
import type { AskContextInput } from "@/lib/ask/core";
import { SOFAR_PER_HOUR } from "@/lib/ask/sofarRequest";
import { getDb, sofarDb } from "@/lib/db";

const MOVIE = "a".repeat(32);
const ticks = (s: number) => s * 10_000_000;
const SRT = [
  "0\n00:04:00,000 --> 00:04:02,000\nAriadne dessine un plan. AVANT-CINQ",
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

function scripted(text: string, seen: string[] = [], stop = "end_turn", reqs: { system: string; message: string; prefixEnd?: number }[] = []): AskModel {
  return ({ system, message, prefixEnd }) => {
    seen.push(message);
    reqs.push({ system, message, prefixEnd });
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
  xrayScenes.payload = null;
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

describe("la coupe : le début de la tranche de cinq minutes (10.27.1)", () => {
  it("12 min → 10 min ; 9 min 59 → 5 min ; 4 min 59 → rien ; jamais de négatif", () => {
    expect(sofarCutoff(12 * 60)).toBe(600);
    expect(sofarCutoff(599)).toBe(300);
    expect(sofarCutoff(299)).toBe(0);
    expect(sofarCutoff(-5)).toBe(0);
    expect(sofarCutoff(null)).toBe(0);
  });

  it("à 9 min, les répliques de l'épisode jusqu'à 5 min partent (10.27.0 : aucune avant 10 min, `dialogue: false`)", async () => {
    const seen: string[] = [];
    setAskModelForTests(scripted("NOMS: Ariadne\n\nAriadne dessine un plan.", seen));
    await sofar(account(), { positionS: 9 * 60 });
    expect(seen[0]).toContain("AVANT-CINQ");
    expect(seen[0]).not.toContain("APRES-LA-COUPE");
    const line = sofarLog.mock.calls.map(([f]) => f as { bucket: number; dialogue?: unknown }).find((f) => f.dialogue !== undefined);
    expect(line).toMatchObject({ bucket: 5, dialogue: true });
  });

  it("la tranche du client est celle du serveur", async () => {
    const client = await import("@/lib/ask/client");
    const server = await import("@/lib/ask/sofar");
    expect(client.SOFAR_BUCKET_S).toBe(server.SOFAR_BUCKET_S);
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
    const second = await sofar(b, { positionS: 14 * 60 });
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

  it(`${SOFAR_PER_HOUR} générations par heure et par compte (préparations comprises), puis « limite » — un texte gardé ne compte pas`, async () => {
    let n = 0;
    setAskModelForTests((req) => scripted(`NOMS: Ariadne\n\nAriadne construit le labyrinthe numéro ${++n}.`)(req));
    const a = account();
    for (let i = 0; i < SOFAR_PER_HOUR; i++) await sofar(a, { prewarm: true, positionS: (i + 1) * 600 + 1 });
    const over = await sofar(a, { prewarm: true, positionS: (SOFAR_PER_HOUR + 5) * 600 });
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

describe("10.27.2 — « rien à dire » réservé à l'absent, la version dans la clé", () => {
  it("la consigne : un second rôle nommé ou dans la scène reçoit au moins une phrase ; RIEN seulement s'il n'apparaît nulle part", () => {
    const sys = sofarSystem("fr");
    expect(sys).toContain("Un second rôle compte autant qu'un premier");
    expect(sys).toContain(`La réponse est le seul mot ${SOFAR_NOTHING} seulement si ce personnage n'est ni dans les sources ni dans la distribution`);
    expect(sys).toContain("Même s'il n'est nommé nulle part ailleurs, écris une phrase");
    // L'ancienne règle (« au-delà de son nom ») est partie : elle faisait taire cinq personnes sur huit.
    expect(sys).not.toContain("au-delà de son nom");
    // Le plus récent d'abord, jamais les débuts.
    expect(sys).toContain("Centre-toi sur le plus récent");
  });

  it("la version de la consigne est dans la clé : 2, et une même entrée sous la version 1 donne une autre clé", () => {
    expect(SOFAR_VERSION).toBe(2);
    expect(sofarKey(ASK_MODEL, "s", "m", 1)).not.toBe(sofarKey(ASK_MODEL, "s", "m"));
  });

  it("un « vide » gardé avant le changement de consigne n'est jamais relu : le modèle est redemandé et le texte montré", async () => {
    const reqs: { system: string; message: string; prefixEnd?: number }[] = [];
    setAskModelForTests(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe.", [], "end_turn", reqs));
    await sofar(account());
    await settle();
    // Ce qui est parti au modèle, gardé sous l'ancienne version comme « rien à dire » : ce que 10.27.1 laissait.
    getDb().prepare("DELETE FROM sofar_texts").run();
    resetSofarForTests();
    sofarDb.put(sofarKey(ASK_MODEL, reqs[0].system, reqs[0].message, 1), "vide", null, "ancien");
    const model = vi.fn(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe."));
    setAskModelForTests(model);
    const r = await sofar(account());
    expect(model).toHaveBeenCalledTimes(1);
    expect(r.text).toBe("Ariadne construit le labyrinthe.");
  });

  it("le message dit que la personne est dans la scène que le spectateur regarde", async () => {
    const seen: string[] = [];
    setAskModelForTests(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe.", seen));
    await sofar(account());
    expect(seen[0]).toContain("ce personnage est dans la scène qu'il regarde");
  });

  it("une phrase qui parle de « sources » est retirée, jamais montrée (« Jusqu'ici » n'a pas de second passage)", async () => {
    setAskModelForTests(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe. Les sources ne disent rien de plus."));
    const r = await sofar(account());
    expect(r.text).toBe("Ariadne construit le labyrinthe.");
    await settle();
    expect(sofarLog).toHaveBeenCalledWith(expect.objectContaining({ cache: "nouveau", meta: "réécrit" }));
  });
});

describe("10.27.2 — centré sur le récent : cinq résumés au plus, ceux d'avant l'épisode en cours", () => {
  const long: AskContextInput = {
    kind: "series",
    title: "Ted Lasso",
    cast: [{ name: "Jason Sudeikis", role: "Ted Lasso" }],
    watchedAll: false,
    // Trois saisons de dix épisodes ; le spectateur en est au deuxième de la saison 3.
    episodes: Array.from({ length: 30 }, (_, i) => {
      const season = Math.floor(i / 10) + 1;
      const n = (i % 10) + 1;
      const code = `S0${season}E${String(n).padStart(2, "0")}`;
      return { code, title: `Épisode ${code}`, overview: `RESUME-${code}`, played: i < 21 };
    }),
    current: { code: "S03E02", title: "Épisode S03E02" },
    positionS: 600,
    cues: [],
  };
  it("une longue série : les cinq derniers vus, la fin de la saison d'avant comprise, jamais les débuts", () => {
    const sources = sofarSources(long, { name: "Jason Sudeikis", character: "Ted Lasso" });
    expect(SOFAR_MAX_EPISODES).toBe(5);
    expect(sources.episodes).toBe(5);
    for (const code of ["S02E07", "S02E08", "S02E09", "S02E10", "S03E01"]) expect(sources.text).toContain(`RESUME-${code}`);
    expect(sources.text).not.toContain("RESUME-S02E06");
    expect(sources.text).not.toContain("RESUME-S01E01");
    expect(sources.text).not.toContain("RESUME-S03E02");
  });
  it("une série revue en entier : rien après l'épisode en cours, ni ses répliques au-delà de la coupe", () => {
    const all: AskContextInput = {
      ...long,
      watchedAll: true,
      episodes: long.episodes!.map((e) => ({ ...e, played: true })),
      cues: [
        { startS: 100, text: "AVANT" },
        { startS: 900, text: "APRES" },
      ],
    };
    const sources = sofarSources(all, { name: "Jason Sudeikis", character: "Ted Lasso" });
    expect(sources.text).not.toContain("RESUME-S03E03");
    expect(sources.text).toContain("RESUME-S03E01");
    expect(sources.text).toContain("AVANT");
    expect(sources.text).not.toContain("APRES");
  });
});

describe("10.27.2 — le cache de prompts : le préfixe partagé d'abord, la personne en dernier", () => {
  it("deux personnes de la même scène : le même préfixe (sources, où en est le spectateur), la personne après lui", async () => {
    const reqs: { system: string; message: string; prefixEnd?: number }[] = [];
    setAskModelForTests(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe.", [], "end_turn", reqs));
    await sofar(account());
    const [r] = reqs;
    expect(r.prefixEnd).toBeGreaterThan(0);
    const prefix = r.message.slice(0, r.prefixEnd);
    const rest = r.message.slice(r.prefixEnd);
    expect(prefix).toContain("<sources>");
    expect(prefix).toContain("AVANT-CINQ");
    expect(prefix).not.toContain("Elliot Page)");
    expect(rest).toContain("Ariadne (joué par Elliot Page)");
    // La requête : deux blocs, le premier seul marqué pour le cache.
    const content = askContent(r.message, r.prefixEnd);
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as { text: string; cache_control?: { type: string } }[];
    expect(blocks).toHaveLength(2);
    expect(blocks[0].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks[0].text + blocks[1].text).toBe(r.message);
    // Sans préfixe, le message tel quel.
    expect(askContent("bonjour")).toBe("bonjour");
  });

  it("les jetons du cache vont au journal (`cacheWrite`, `cacheRead`)", async () => {
    setAskModelForTests(() => {
      async function* deltas() {
        yield "NOMS: Ariadne\n\nAriadne construit le labyrinthe.";
      }
      return { deltas: deltas(), done: Promise.resolve({ inTokens: 40, outTokens: 30, stop: "end_turn", cacheWrite: 0, cacheRead: 3200 }) };
    });
    await sofar(account());
    await settle();
    expect(sofarLog).toHaveBeenCalledWith(expect.objectContaining({ cache: "nouveau", cacheWrite: 0, cacheRead: 3200 }));
  });

});

describe("10.27.2 — le plafond de sortie de « Jusqu'ici »", () => {
  it("parti avec son plafond ; atteint, une panne jamais gardée (la ligne discrète à l'écran)", async () => {
    const seen: (number | undefined)[] = [];
    setAskModelForTests(({ maxTokens }) => {
      seen.push(maxTokens);
      async function* deltas() {
        yield "NOMS: Ariadne\n\nAriadne construit le labyrinthe. Elle";
      }
      return { deltas: deltas(), done: Promise.resolve({ inTokens: 10, outTokens: SOFAR_MAX_OUTPUT_TOKENS, stop: "max_tokens" }) };
    });
    const r = await sofar(account());
    expect(seen).toEqual([SOFAR_MAX_OUTPUT_TOKENS]);
    expect(r.events.at(-1)).toEqual({ t: "error", code: "erreur" });
    await settle();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM sofar_texts").get()).toEqual({ n: 0 });
  });
});

describe("10.27.2 — la coupe tombe sur un début de scène", () => {
  const scenes = (starts: number[], complete = true, analyzedUntil = 3000) => ({
    status: "done",
    complete,
    analyzedUntil,
    scenes: starts.map((start, i) => ({ start, end: starts[i + 1] ?? start + 60, people: [] as never[] })),
  });

  it("à 12 min : le début de la dernière scène avant 10 min (4 min 50), jamais au milieu d'une scène", async () => {
    xrayScenes.payload = scenes([0, 230, 290, 700]);
    const seen: string[] = [];
    setAskModelForTests(scripted("NOMS: Ariadne\n\nAriadne dessine un plan.", seen));
    await sofar(account(), { positionS: 12 * 60 });
    // La réplique de 4 min part, celle de 5 min (dans la scène commencée à 4 min 50) non.
    expect(seen[0]).toContain("AVANT-CINQ");
    expect(seen[0]).not.toContain("Ariadne construit le labyrinthe.");
    expect(sofarLog).toHaveBeenCalledWith(expect.objectContaining({ cutS: 290, bucket: 10 }));
    const { sofarCut } = await import("@/lib/ask/sofarCut");
    expect(sofarCut(12 * 60, xrayScenes.payload)).toBe(290);
  });

  it("sans scènes : la marque des cinq minutes, comme avant", async () => {
    const seen: string[] = [];
    setAskModelForTests(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe.", seen));
    await sofar(account(), { positionS: 12 * 60 });
    expect(seen[0]).toContain("Ariadne construit le labyrinthe.");
    expect(sofarLog).toHaveBeenCalledWith(expect.objectContaining({ cutS: 600 }));
  });

  it("deux positions de la même tranche, une même scène : la même clé, un seul appel", async () => {
    xrayScenes.payload = scenes([0, 230, 290, 700]);
    const model = vi.fn(scripted("NOMS: Ariadne\n\nAriadne dessine un plan."));
    setAskModelForTests(model);
    const a = account();
    await sofar(a, { positionS: 10 * 60 + 5 });
    await settle();
    await sofar(a, { positionS: 14 * 60 + 50 });
    expect(model).toHaveBeenCalledTimes(1);
  });
});

describe("10.27.2 — les étapes au journal, le contexte préparé", () => {
  it("une génération : `contextMs`, `ttftMs`, `firstSentenceMs`, `totalMs`, `ctx`", async () => {
    setAskModelForTests(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe."));
    await sofar(account());
    await settle();
    const line = sofarLog.mock.calls.map(([f]) => f as Record<string, unknown>).find((f) => f.cache === "nouveau")!;
    for (const k of ["contextMs", "ttftMs", "firstSentenceMs", "totalMs"]) expect(typeof line[k]).toBe("number");
    expect(line.ctx).toBe("construit");
  });

  it("préparé à l'ouverture du lecteur (GET) : la demande suivante lit le contexte prêt", async () => {
    setAskModelForTests(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe."));
    const a = account();
    const { GET } = await import("@/app/api/cinema/ask/[itemId]/route");
    await GET(req(a, null), { params: Promise.resolve({ itemId: MOVIE }) });
    await settle();
    const r = await question(a);
    expect(r.events.at(-1)).toEqual({ t: "done" });
    expect(askLog).toHaveBeenLastCalledWith(expect.objectContaining({ ctx: "prêt", contextMs: expect.any(Number), ttftMs: expect.any(Number), firstSentenceMs: expect.any(Number), totalMs: expect.any(Number) }));
  });
});
