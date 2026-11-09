import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// « Poser une question » (DECISIONS.md §139) : ce qui part au modèle — seulement ce que le compte a vu —,
// le tri de la réponse au fil de l'eau (un nom absent des sources arrête tout), et la route : option,
// session, bornes, titre caché, journal sans la question ni la réponse. Jellyfin et le modèle sont des
// doubles — aucun appel réseau ne part.

await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-ask-"));
});

const settings = { enabled: true, audience: undefined as undefined | "off" | "admins" | "tous", provider: "anthropic", apiKey: "sk-test" };
vi.mock("@/lib/config", () => ({
  config: {
    ask: { get enabled() { return settings.enabled; }, get audience() { return settings.audience; } },
    recap: { enabled: false },
    subtitleGen: { get provider() { return settings.provider; }, get apiKey() { return settings.apiKey; } },
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
const { fetchMock, logError, askLog } = vi.hoisted(() => ({ fetchMock: vi.fn(), logError: vi.fn(), askLog: vi.fn() }));
vi.mock("@/lib/jellyfinBreaker", () => ({ jellyfinFetch: fetchMock }));
vi.mock("@/lib/logger", () => ({ logError: (...args: unknown[]) => logError(...args) }));
vi.mock("@/lib/eventLogs", () => ({ logAskQuestion: (...args: unknown[]) => askLog(...args), logRecap: vi.fn() }));

import { AnswerGate, askSystem, askSources, seenCues, seenEpisodes, positionBucket, type AskContextInput } from "@/lib/ask/core";
import { setAskModelForTests, resetAskCachesForTests, type AskModel } from "@/lib/ask/service";
import { shareRuleFor } from "@/lib/share/gate";

const MOVIE = "a".repeat(32);
const SERIES = "b".repeat(32);
const ep = (n: number) => `${n}`.repeat(1) + "e".repeat(31);
const HIDDEN = "c".repeat(32);
const ticks = (s: number) => s * 10_000_000;

const SRT = [
  "1\n00:05:00,000 --> 00:05:02,000\nAriadne construit le labyrinthe.",
  "2\n00:30:00,000 --> 00:30:02,000\nMal apparaît dans le rêve. APRES-LA-POSITION",
  "3\n01:30:00,000 --> 01:30:02,000\nFischer accepte l'idée. FIN-DU-FILM",
].join("\n\n");

const subtitleStreams = [{ Index: 3, Type: "Subtitle", Language: "fre", IsTextSubtitleStream: true }];
function movie(positionS: number, played = false) {
  return {
    Id: MOVIE,
    Type: "Movie",
    Name: "Inception",
    ProductionYear: 2010,
    Overview: "Dom Cobb vole des secrets dans les rêves.",
    Taglines: ["Votre esprit est la scène du crime."],
    People: [
      { Name: "Leonardo DiCaprio", Role: "Cobb", Type: "Actor" },
      { Name: "Elliot Page", Role: "Ariadne", Type: "Actor" },
      { Name: "Christopher Nolan", Type: "Director" },
    ],
    UserData: { Played: played, PlayCount: 0, PlaybackPositionTicks: ticks(positionS) },
    MediaSources: [{ Id: "f".repeat(32) }],
    MediaStreams: subtitleStreams,
  };
}
const episodes = [1, 2, 3, 4].map((n) => ({
  Id: ep(n),
  Type: "Episode",
  Name: `Épisode ${n}`,
  SeriesId: SERIES,
  ParentIndexNumber: 1,
  IndexNumber: n,
  Overview: `Ted Lasso arrive à Richmond. RESUME-E${n}`,
  UserData: { Played: n <= 2, PlayCount: n <= 2 ? 1 : 0, PlaybackPositionTicks: n === 3 ? ticks(25 * 60) : 0 },
  MediaSources: [{ Id: `${n}`.repeat(32) }],
  MediaStreams: subtitleStreams,
}));
const series = {
  Id: SERIES,
  Type: "Series",
  Name: "Ted Lasso",
  Overview: "Un entraîneur américain en Angleterre.",
  People: [{ Name: "Jason Sudeikis", Role: "Ted Lasso", Type: "Actor" }],
  UserData: { Played: false, PlayCount: 0 },
};

let movieState = movie(600);
function json(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
function serveJellyfin() {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/Subtitles/")) return new Response(SRT);
    if (url.includes(`/Shows/${SERIES}/Episodes`)) return json({ Items: episodes });
    if (url.endsWith(`/Items/${MOVIE}`)) return json(movieState);
    if (url.endsWith(`/Items/${SERIES}`)) return json(series);
    for (const e of episodes) if (url.endsWith(`/Items/${e.Id}`)) return json(e);
    return new Response("", { status: 404 });
  });
}

/** Un modèle scripté : il rend ce texte, et garde le message reçu. */
function scripted(text: string, seen: string[] = []): AskModel {
  return ({ message }) => {
    seen.push(message);
    async function* deltas() {
      // Coupé au hasard des morceaux, comme un vrai flux.
      for (let i = 0; i < text.length; i += 7) yield text.slice(i, i + 7);
    }
    return { deltas: deltas(), done: Promise.resolve({ inTokens: 1000, outTokens: 50, stop: "end_turn" }) };
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

async function ask(account: string, itemId: string, body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/cinema/ask/[itemId]/route");
  const res = await POST(req(account, { question: "Que vient-il de se passer ?", ...body }), { params: Promise.resolve({ itemId }) });
  const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: string; v?: string; code?: string });
  return { status: res.status, events, text: events.filter((e) => e.t === "text").map((e) => e.v).join(" ") };
}

let serial = 0;
/** Un compte neuf par test : les bornes par compte vivent dans le module de la route. */
function account(extra: Partial<{ jfId: string; role: string }> = {}) {
  const name = `compte-${++serial}`;
  sessions[name] = { jfId: (serial + 100).toString(16).padStart(32, "d"), jfUser: name, role: "user", ...extra };
  return name;
}

beforeEach(() => {
  settings.enabled = true;
  settings.audience = undefined;
  fetchMock.mockReset();
  askLog.mockReset();
  logError.mockReset();
  resetAskCachesForTests();
  movieState = movie(600);
  serveJellyfin();
});

describe("les sources — seulement ce qui a été vu", () => {
  const cues = [
    { startS: 60, text: "avant" },
    { startS: 600, text: "à la position" },
    { startS: 601, text: "juste après" },
  ];
  it("aucune réplique après la position, aucune sans position, toutes le titre fini", () => {
    expect(seenCues(cues, 600, false).map((c) => c.text)).toEqual(["avant", "à la position"]);
    expect(seenCues(cues, null, false)).toEqual([]);
    expect(seenCues(cues, 0, false)).toEqual([]);
    expect(seenCues(cues, 100, true)).toHaveLength(3);
  });

  it("le résumé d'un épisode non terminé ne part jamais — l'épisode en cours compris", () => {
    const list = [
      { code: "S01E01", title: "Un", overview: "fini", played: true },
      { code: "S01E02", title: "Deux", overview: "en cours", played: false },
      { code: "S01E03", title: "Trois", overview: "à venir", played: false },
    ];
    expect(seenEpisodes(list, false).map((e) => e.code)).toEqual(["S01E01"]);
    const input: AskContextInput = { kind: "series", title: "X", cast: [], watchedAll: false, episodes: list, current: { code: "S01E02", title: "Deux" }, positionS: 600, cues };
    const s = askSources(input);
    expect(s.text).toContain("fini");
    expect(s.text).not.toContain("en cours");
    expect(s.text).not.toContain("à venir");
    expect(s.text).not.toContain("juste après");
    expect(s.episodes).toBe(1);
  });

  it("la position au journal : la tranche de dix minutes, jamais la seconde", () => {
    expect(positionBucket(1499)).toBe(20);
    expect(positionBucket(null)).toBeNull();
  });
});

describe("AnswerGate — la réponse vérifiée phrase par phrase", () => {
  const sources = "Inception\nLeonardo DiCaprio — Cobb\nElliot Page — Ariadne\nAriadne construit le labyrinthe.";

  it("un nom déclaré absent des sources : rejeté avant la première phrase", () => {
    const gate = new AnswerGate(sources);
    const out = gate.push("NOMS: Cobb, Saito\n\nCobb parle à Saito. ");
    expect(out.release).toEqual([]);
    expect(out.rejected).toEqual(["Saito"]);
    expect(gate.push("Encore une phrase. ").release).toEqual([]);
  });

  it("des noms connus : chaque phrase rendue quand elle est complète, la ligne des noms jamais", () => {
    const gate = new AnswerGate(sources);
    expect(gate.push("NOMS: Cobb, Ariadne\n\nCobb recrute Ariadne. Elle constr").release).toEqual(["Cobb recrute Ariadne."]);
    expect(gate.end().release).toEqual(["Elle constr"]);
  });

  it("un nom inconnu au milieu de la deuxième phrase : la première est partie, la suite est arrêtée", () => {
    const gate = new AnswerGate(sources);
    const out = gate.push("NOMS: —\n\nLe rêve s'effondre. Puis il rejoint Mombasa avec Eames. ");
    expect(out.release).toEqual(["Le rêve s'effondre."]);
    expect(out.rejected).toEqual(expect.arrayContaining(["Mombasa", "Eames"]));
  });

  it("sans ligne des noms : la règle des majuscules reste", () => {
    const gate = new AnswerGate(sources);
    expect(gate.push("Le film parle de rêves. ").release).toEqual(["Le film parle de rêves."]);
  });

  it("la longueur demandée n'est pas tenue : coupée à cinq phrases", () => {
    const gate = new AnswerGate(sources);
    const out = gate.push("NOMS: —\n\n" + "Une phrase. ".repeat(8));
    expect(out.release).toHaveLength(5);
  });
});

describe("/api/cinema/ask/[itemId]", () => {
  it("option coupée : une fin « off », rien demandé à personne", async () => {
    settings.enabled = false;
    const model = vi.fn();
    setAskModelForTests(model);
    const r = await ask(account(), MOVIE, { where: "lecteur", positionS: 600 });
    expect(r.status).toBe(200);
    expect(r.events).toEqual([{ t: "error", code: "off" }]);
    expect(model).not.toHaveBeenCalled();
  });

  it("réglée sur `admins` : « off » pour un compte ordinaire ou un lien, la réponse pour un administrateur", async () => {
    settings.audience = "admins";
    const model = vi.fn(scripted("NOMS: —\n\nLe film parle de rêves."));
    setAskModelForTests(model);
    expect((await ask(account(), MOVIE, { where: "fiche" })).events).toEqual([{ t: "error", code: "off" }]);
    expect((await ask(account({ role: "share" }), MOVIE, { where: "fiche" })).events).toEqual([{ t: "error", code: "off" }]);
    expect(model).not.toHaveBeenCalled();
    const r = await ask(account({ role: "admin" }), MOVIE, { where: "fiche" });
    expect(r.text).toBe("Le film parle de rêves.");
    // Ce que l'écran lit pour cacher la pilule : la même porte.
    const { GET } = await import("@/app/api/cinema/ask/[itemId]/route");
    const res = await GET(req(account(), {}), { params: Promise.resolve({ itemId: MOVIE }) });
    expect(await res.json()).toEqual({ available: false });
  });

  it("sans session : 401 ; un identifiant malformé : 400", async () => {
    const { POST } = await import("@/app/api/cinema/ask/[itemId]/route");
    const anon = await POST(req("inconnu", { question: "x" }), { params: Promise.resolve({ itemId: MOVIE }) });
    expect(anon.status).toBe(401);
    const bad = await POST(req(account(), { question: "x" }), { params: Promise.resolve({ itemId: "../System" }) });
    expect(bad.status).toBe(400);
  });

  it("au lecteur, un film à 20 min : les dialogues jusqu'à 20 min, rien après", async () => {
    const seen: string[] = [];
    setAskModelForTests(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe.", seen));
    const r = await ask(account(), MOVIE, { where: "lecteur", positionS: 20 * 60 });
    expect(r.text).toBe("Ariadne construit le labyrinthe.");
    expect(r.events.at(-1)).toEqual({ t: "done" });
    expect(seen[0]).toContain("Ariadne construit le labyrinthe.");
    expect(seen[0]).toContain("Leonardo DiCaprio — Cobb");
    expect(seen[0]).not.toContain("APRES-LA-POSITION");
    expect(seen[0]).not.toContain("FIN-DU-FILM");
  });

  it("sur la fiche, la position du corps est ignorée : la reprise gardée par Jellyfin fait foi", async () => {
    const seen: string[] = [];
    setAskModelForTests(scripted("NOMS: —\n\nLe film parle de rêves.", seen));
    movieState = movie(10 * 60);
    await ask(account(), MOVIE, { where: "fiche", positionS: 2 * 3600 });
    expect(seen[0]).toContain("Ariadne construit");
    expect(seen[0]).not.toContain("APRES-LA-POSITION");
  });

  it("un film terminé : tout ce qu'on a est permis", async () => {
    const seen: string[] = [];
    setAskModelForTests(scripted("NOMS: —\n\nLe film parle de rêves.", seen));
    movieState = movie(0, true);
    await ask(account(), MOVIE, { where: "fiche" });
    expect(seen[0]).toContain("FIN-DU-FILM");
  });

  it("une série au lecteur : les résumés des épisodes finis seulement, jamais celui en cours ni les suivants", async () => {
    const seen: string[] = [];
    setAskModelForTests(scripted("NOMS: Ted Lasso\n\nTed Lasso arrive à Richmond.", seen));
    const r = await ask(account(), ep(3), { where: "lecteur", positionS: 20 * 60 });
    expect(r.text).toBe("Ted Lasso arrive à Richmond.");
    expect(seen[0]).toContain("RESUME-E1");
    expect(seen[0]).toContain("RESUME-E2");
    expect(seen[0]).not.toContain("RESUME-E3");
    expect(seen[0]).not.toContain("RESUME-E4");
    expect(seen[0]).toContain("Ariadne construit");
    expect(seen[0]).not.toContain("APRES-LA-POSITION");
  });

  it("une série depuis la fiche : l'épisode commencé à sa reprise, les épisodes non vus absents", async () => {
    const seen: string[] = [];
    setAskModelForTests(scripted("NOMS: —\n\nL'histoire commence en Angleterre.", seen));
    await ask(account(), SERIES, { where: "fiche" });
    expect(seen[0]).toContain("S01E03");
    expect(seen[0]).not.toContain("RESUME-E3");
    expect(seen[0]).not.toContain("RESUME-E4");
    expect(seen[0]).toContain("Ariadne construit");
    expect(seen[0]).not.toContain("APRES-LA-POSITION");
  });

  it("un nom sorti de la mémoire du modèle : « rejected », aucune phrase, et le journal le dit", async () => {
    setAskModelForTests(scripted("NOMS: Cobb, Saito\n\nCobb travaille pour Saito."));
    const r = await ask(account(), MOVIE, { where: "lecteur", positionS: 20 * 60 });
    expect(r.events).toEqual([{ t: "rejected" }]);
    expect(askLog).toHaveBeenCalledWith(expect.objectContaining({ status: "rejeté", where: "lecteur", bucket: 20 }));
  });

  it("un titre que le compte ne voit pas : « indisponible », le modèle n'est pas appelé", async () => {
    const model = vi.fn();
    setAskModelForTests(model);
    const r = await ask(account(), HIDDEN, { where: "fiche" });
    expect(r.events).toEqual([{ t: "error", code: "indisponible" }]);
    expect(model).not.toHaveBeenCalled();
  });

  it("soixante questions par heure et par compte (10.27), puis « limite »", async () => {
    setAskModelForTests(scripted("NOMS: —\n\nLe film parle de rêves."));
    const who = account();
    for (let i = 0; i < 60; i++) await ask(who, MOVIE, { where: "fiche" });
    const r = await ask(who, MOVIE, { where: "fiche" });
    expect(r.events).toEqual([{ t: "error", code: "limite" }]);
    expect(askLog).toHaveBeenLastCalledWith(expect.objectContaining({ status: "limite" }));
  });

  it("une panne du modèle : une fin « erreur » dite, au journal du serveur", async () => {
    setAskModelForTests(() => {
      const err = Object.assign(new Error("boom"), { status: 500 });
      async function* deltas(): AsyncGenerator<string> {
        throw err;
      }
      return { deltas: deltas(), done: Promise.reject(err) };
    });
    const r = await ask(account(), MOVIE, { where: "fiche" });
    expect(r.events).toEqual([{ t: "error", code: "erreur" }]);
    expect(logError).toHaveBeenCalledWith("ask/model", expect.anything());
  });

  it("le journal ne porte jamais la question ni la réponse", async () => {
    setAskModelForTests(scripted("NOMS: Ariadne\n\nAriadne construit le labyrinthe."));
    await ask(account(), MOVIE, { where: "lecteur", positionS: 600, question: "QUESTION-PRIVEE ?" });
    const line = JSON.stringify(askLog.mock.calls);
    expect(line).not.toContain("QUESTION-PRIVEE");
    expect(line).not.toContain("labyrinthe");
    expect(askLog).toHaveBeenCalledWith(expect.objectContaining({ status: "ok", itemId: MOVIE, bucket: 10, turn: 1, dialogue: true }));
  });

  it("les échanges d'avant : quatre au plus, coupés, et jamais pris pour des sources", async () => {
    const seen: string[] = [];
    setAskModelForTests(scripted("NOMS: —\n\nLe film parle de rêves.", seen));
    const previous = Array.from({ length: 7 }, (_, i) => ({ question: `Q${i}`, answer: `R${i}` }));
    await ask(account(), MOVIE, { where: "fiche", previous });
    expect(seen[0]).toContain("Q6");
    expect(seen[0]).not.toContain("Q2");
    expect(seen[0].indexOf("Q6")).toBeGreaterThan(seen[0].indexOf("</sources>"));
  });
});

describe("liens de partage", () => {
  it("la route est dans la liste fermée, portée par l'élément de l'adresse", () => {
    expect(shareRuleFor("POST", `/api/cinema/ask/${MOVIE}`)?.rule.scope).toEqual({ kind: "path" });
    expect(shareRuleFor("GET", `/api/cinema/ask/${MOVIE}`)?.rule.scope).toEqual({ kind: "path" });
  });
});

describe("la consigne : jamais de « sources » dites au spectateur (09/11/2026)", () => {
  // Une réponse finissait par « Les sources ne vont pas au-delà de ces neuf premières minutes. »
  it("interdit le mot et donne, dans chaque langue, une façon naturelle de dire la limite", () => {
    const phrases = { fr: "D'après ce que vous avez vu jusqu'ici", en: "From what you've seen so far", es: "Por lo que ha visto hasta ahora", de: "Nach dem, was Sie bisher gesehen haben" } as const;
    for (const [locale, phrase] of Object.entries(phrases)) {
      const system = askSystem(locale as keyof typeof phrases);
      expect(system).toContain("Ne parle jamais au spectateur de « sources »");
      expect(system).toContain(phrase);
      // Les autres règles ne bougent pas.
      expect(system).toContain("Ne parle jamais de la suite");
      expect(system).toContain("N'utilise QUE les sources");
    }
  });
});
