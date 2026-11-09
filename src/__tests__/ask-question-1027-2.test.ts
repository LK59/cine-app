import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// « Poser une question » en 10.27.2 (DECISIONS.md §139) : depuis le panneau d'une personne, ses faits réels
// (TMDB) et la date de diffusion partent avec la question — « quel âge a cette actrice pendant cet
// épisode ? » recevait « les sources ne donnent pas l'âge » sous sa date de naissance affichée ; le filet des
// mots de coulisse (« sources », « documents »… dans les quatre langues) ; le préfixe partagé marqué pour
// le cache de prompts, la question en dernier. Jellyfin, TMDB et le modèle sont des doubles.

await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-ask-10272-"));
});

vi.mock("@/lib/config", () => ({
  config: {
    ask: { enabled: true, audience: "tous", personAudience: "tous", sofarAudience: "tous" },
    // Une question qui porte une personne passe la porte des questions sur une personne (§139) : les
    // acteurs à l'écran branchés.
    xray: { audience: "tous", enabled: true, url: "http://xray", apiKey: "k" },
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
const { fetchMock, logError, askLog, actorFacts } = vi.hoisted(() => ({ fetchMock: vi.fn(), logError: vi.fn(), askLog: vi.fn(), actorFacts: vi.fn() }));
vi.mock("@/lib/jellyfinBreaker", () => ({ jellyfinFetch: fetchMock }));
vi.mock("@/lib/logger", () => ({ logError: (...args: unknown[]) => logError(...args) }));
vi.mock("@/lib/eventLogs", () => ({ logAskQuestion: (...args: unknown[]) => askLog(...args), logJusquici: vi.fn(), logRecap: vi.fn() }));
vi.mock("@/lib/xray/person", () => ({ actorFactsForAsk: (...args: unknown[]) => actorFacts(...args), castPerson: vi.fn(async () => null) }));

import { actorFactsText, AnswerGate, askParts, askSources, METALESS_LIMIT, metaTalk, rewriteMetaPrefix, type AskContextInput } from "@/lib/ask/core";
import { ASK_MAX_OUTPUT_TOKENS, setAskModelForTests, resetAskCachesForTests, type AskModel } from "@/lib/ask/service";

const MOVIE = "a".repeat(32);
const ticks = (s: number) => s * 10_000_000;
const SRT = ["1\n00:05:00,000 --> 00:05:02,000\nAriadne construit le labyrinthe.", "2\n00:30:00,000 --> 00:30:02,000\nAPRES-LA-POSITION"].join("\n\n");
const movie = {
  Id: MOVIE,
  Type: "Movie",
  Name: "Inception",
  ProductionYear: 2010,
  PremiereDate: "2010-07-16T00:00:00.0000000Z",
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

type Req = { system: string; message: string; prefixEnd?: number };
/** Un modèle qui rend, à chaque appel, le texte suivant de la liste — et garde ce qu'il a reçu. */
function scripted(texts: string[], reqs: Req[] = [], usage: { cacheWrite?: number; cacheRead?: number } = {}): AskModel {
  let i = 0;
  return ({ system, message, prefixEnd }) => {
    reqs.push({ system, message, prefixEnd });
    const text = texts[Math.min(i++, texts.length - 1)];
    async function* deltas() {
      for (let k = 0; k < text.length; k += 7) yield text.slice(k, k + 7);
    }
    return { deltas: deltas(), done: Promise.resolve({ inTokens: 100, outTokens: 20, stop: "end_turn", ...usage }) };
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
async function ask(body: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/cinema/ask/[itemId]/route");
  const name = `compte-${++serial}`;
  sessions[name] = { jfId: (serial + 700).toString(16).padStart(32, "d"), jfUser: name, role: "user" };
  const res = await POST(req(name, { question: "Quel âge a cette actrice pendant ce film ?", where: "lecteur", positionS: 600, ...body }), {
    params: Promise.resolve({ itemId: MOVIE }),
  });
  const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: string; v?: string });
  // Le texte tel que l'écran le montre : les mots ajoutés, un `reset` remet tout (10.28.0).
  let text = "";
  for (const e of events) {
    if (e.t === "reset") text = e.v ?? "";
    else if (e.t === "text") text = text ? `${text} ${e.v}` : (e.v ?? "");
  }
  return { events, text };
}
let serial = 0;

beforeEach(() => {
  fetchMock.mockReset();
  askLog.mockReset();
  logError.mockReset();
  actorFacts.mockReset();
  resetAskCachesForTests();
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/Subtitles/")) return new Response(SRT);
    if (url.endsWith(`/Items/${MOVIE}`)) return json(movie);
    return new Response("", { status: 404 });
  });
  actorFacts.mockResolvedValue({
    name: "Elliot Page",
    character: "Ariadne",
    birthday: "1987-02-21",
    deathday: null,
    placeOfBirth: "Halifax, Nova Scotia, Canada",
  });
});

describe("les mots de coulisse (`metaTalk`)", () => {
  it("pris dans les quatre langues", () => {
    expect(metaTalk("Les sources ne donnent pas l'âge.", "")).toEqual(["sources"]);
    expect(metaTalk("The subtitles don't say.", "")).toEqual(["subtitles"]);
    expect(metaTalk("Las fuentes no lo dicen.", "")).toEqual(["fuentes"]);
    expect(metaTalk("Die Quellen sagen nichts darüber.", "")).toEqual(["quellen"]);
    expect(metaTalk("D'après le contexte fourni, rien.", "")).toEqual(["contexte"]);
    // 09/11/2026 (banc des films) : « dans cette scène » passait le filet.
    expect(metaTalk("Vincent devine les codes dans cette scène.", "")).toEqual(["scène"]);
    expect(metaTalk("Une réplique dit qu'il ment.", "")).toEqual(["réplique"]);
    expect(metaTalk("He is in this scene.", "")).toEqual(["scene"]);
    expect(metaTalk("Er ist in dieser Szene.", "")).toEqual(["szene"]);
    // Un théâtre ou une scène de crime nommés par l'histoire restent permis.
    expect(metaTalk("Elle monte sur scène.", "il faut que tu montes sur scène ce soir")).toEqual([]);
  });
  it("un mot que l'histoire emploie elle-même n'est pas de la coulisse", () => {
    expect(metaTalk("Ariadne vole les documents de Saito.", "ariadne : rends-moi ces documents !")).toEqual([]);
    expect(metaTalk("Il ne parle pas.", "")).toEqual([]);
  });
  it("« D'après les sources, … » se reformule ; le reste non", () => {
    expect(rewriteMetaPrefix("D'après les sources, Ariadne dessine.", "fr")).toBe("D'après ce que vous avez vu, Ariadne dessine.");
    expect(rewriteMetaPrefix("According to the subtitles, Ariadne draws.", "en")).toBe("From what you've seen, Ariadne draws.");
    expect(rewriteMetaPrefix("Según las fuentes, Ariadne dibuja.", "es")).toBe("Por lo que ha visto, Ariadne dibuja.");
    expect(rewriteMetaPrefix("Laut den Quellen zeichnet Ariadne.", "de")).toBe("Nach dem, was Sie gesehen haben, zeichnet Ariadne.");
    expect(rewriteMetaPrefix("Les sources ne disent rien.", "fr")).toBeNull();
  });
});

describe("AnswerGate avec le filet des mots de coulisse", () => {
  const sources = "Titre : Inception\n### Dialogues\nAriadne construit le labyrinthe.";
  it("avant toute phrase rendue : `retry` (redemander une fois), rien de rendu", () => {
    const gate = new AnswerGate(sources, undefined, { locale: "fr", sources, retry: true, onMeta: "replace" });
    const out = gate.push("NOMS: —\n\nLes sources ne donnent pas son âge. Autre chose. ");
    expect(out).toEqual({ release: [], retry: true });
  });
  it("sans second passage : la phrase remplacée par la limite dite naturellement, une seule fois", () => {
    const gate = new AnswerGate(sources, undefined, { locale: "fr", sources, retry: false, onMeta: "replace" });
    const out = gate.push("NOMS: —\n\nLes sources ne donnent pas son âge. Le contexte non plus. ");
    expect(out.release.join(" ")).toBe(METALESS_LIMIT.fr);
    expect(gate.rewritten).toBe(true);
  });
  it("après une phrase rendue : reformulée plutôt que redemandée", () => {
    const gate = new AnswerGate(sources, undefined, { locale: "fr", sources, retry: true, onMeta: "replace" });
    const out = gate.push("NOMS: Ariadne\n\nAriadne construit le labyrinthe. D'après les sources, Ariadne dessine. ");
    expect(out.release.join(" ")).toBe("Ariadne construit le labyrinthe. D'après ce que vous avez vu, Ariadne dessine.");
  });
});

describe("la route, depuis le panneau d'une personne", () => {
  it("ses faits réels et la date de sortie partent ; l'âge se répond ; ses noms passent le filet", async () => {
    const reqs: Req[] = [];
    setAskModelForTests(scripted(["NOMS: Elliot Page, Halifax\n\nNé le 21 février 1987 à Halifax, Elliot Page avait 23 ans à la sortie du film."], reqs));
    const r = await ask({ personId: 2 });
    expect(actorFacts).toHaveBeenCalledWith(MOVIE, 2, "fr");
    expect(r.events.at(-1)).toEqual({ t: "done" });
    expect(r.text).toContain("Halifax");
    const { message, prefixEnd } = reqs[0];
    expect(message).toContain("Sortie du film : 2010-07-16");
    expect(message).toContain("Naissance : 1987-02-21");
    expect(message).toContain("Lieu de naissance : Halifax, Nova Scotia, Canada");
    // Les faits viennent après le préfixe partagé (le cache de prompts), la question en tout dernier.
    expect(message.indexOf("<acteur>")).toBeGreaterThanOrEqual(prefixEnd!);
    expect(message.slice(0, prefixEnd)).toContain("<sources>");
    expect(message.trimEnd().endsWith("Quel âge a cette actrice pendant ce film ?")).toBe(true);
    // La consigne dit que ces faits ne disent rien de l'histoire.
    expect(reqs[0].system).toContain("Ils ne disent rien de l'histoire");
    expect(askLog).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ok", personId: 2 }));
  });

  it("la biographie ne part jamais au modèle (10.28.1 : elle peut raconter la suite du personnage)", async () => {
    const reqs: Req[] = [];
    // Même si une source la fournissait : ni la ligne, ni son texte.
    actorFacts.mockResolvedValueOnce({
      name: "Elliot Page",
      character: "Ariadne",
      birthday: "1987-02-21",
      deathday: null,
      placeOfBirth: "Halifax, Nova Scotia, Canada",
      bio: "Ariadne finit par trahir Cobb dans le dernier niveau du rêve.",
    });
    setAskModelForTests(scripted(["NOMS: Elliot Page\n\nElliot Page avait 23 ans à la sortie du film."], reqs));
    await ask({ personId: 2 });
    const { message } = reqs[0];
    expect(message).toContain("Naissance : 1987-02-21");
    expect(message).toContain("Sortie du film : 2010-07-16");
    expect(message).not.toContain("Biographie");
    expect(message).not.toContain("trahir Cobb");
    expect(actorFactsText({ name: "X", bio: "Une longue histoire." } as Parameters<typeof actorFactsText>[0])).toBe("Nom : X");
  });

  it("sans `personId` : aucun fait demandé, aucun bloc `<acteur>` ; une panne des faits laisse partir la question", async () => {
    const reqs: Req[] = [];
    setAskModelForTests(scripted(["NOMS: Ariadne\n\nAriadne construit le labyrinthe."], reqs));
    await ask();
    expect(actorFacts).not.toHaveBeenCalled();
    expect(reqs[0].message).not.toContain("<acteur>");
    actorFacts.mockResolvedValueOnce(null);
    await ask({ personId: 2 });
    expect(reqs[1].message).not.toContain("<acteur>");
  });
});

describe("la route : jamais de « sources » à l'écran", () => {
  it("une première réponse qui parle de « sources » : redemandée une fois avec le rappel, la seconde montrée", async () => {
    const reqs: Req[] = [];
    setAskModelForTests(
      scripted(["NOMS: —\n\nLes sources ne donnent pas l'âge d'aucune actrice.", "NOMS: Elliot Page\n\nElliot Page avait 23 ans à la sortie du film."], reqs)
    );
    const r = await ask({ personId: 2 });
    expect(reqs).toHaveLength(2);
    expect(reqs[1].message).toContain("Rappel impératif");
    expect(reqs[1].prefixEnd).toBe(reqs[0].prefixEnd);
    expect(r.text).toBe("Elliot Page avait 23 ans à la sortie du film.");
    expect(r.text).not.toMatch(/sources/i);
    expect(askLog).toHaveBeenLastCalledWith(expect.objectContaining({ status: "ok", meta: "regénéré" }));
  });

  it("la seconde aussi : la phrase remplacée par la limite dite naturellement — jamais un troisième appel", async () => {
    const reqs: Req[] = [];
    setAskModelForTests(scripted(["NOMS: —\n\nLes sources ne disent rien.", "NOMS: —\n\nLes documents fournis ne le disent pas."], reqs));
    const r = await ask();
    expect(reqs).toHaveLength(2);
    expect(r.text).toBe(METALESS_LIMIT.fr);
    expect(askLog).toHaveBeenLastCalledWith(expect.objectContaining({ meta: "regénéré+réécrit" }));
  });

  it("les jetons du cache de prompts vont au journal", async () => {
    setAskModelForTests(scripted(["NOMS: Ariadne\n\nAriadne construit le labyrinthe."], [], { cacheWrite: 0, cacheRead: 2100 }));
    await ask();
    expect(askLog).toHaveBeenLastCalledWith(expect.objectContaining({ cacheWrite: 0, cacheRead: 2100 }));
  });
});

describe("le message : le préfixe partagé, puis ce qui est propre à la demande", () => {
  it("deux questions au même endroit partagent le préfixe, mot pour mot", () => {
    const input: AskContextInput = {
      kind: "movie",
      title: "Inception",
      cast: [],
      watchedAll: false,
      positionS: 600,
      cues: [{ startS: 300, text: "Ariadne construit le labyrinthe." }],
    };
    const sources = askSources(input);
    const a = askParts(sources, "Le spectateur en est à 10 min du film.", [], "Qui est Ariadne ?");
    const b = askParts(sources, "Le spectateur en est à 10 min du film.", [{ question: "Qui est Ariadne ?", answer: "Une architecte." }], "Et Cobb ?", {
      name: "Leonardo DiCaprio",
    });
    expect(a.message.slice(0, a.prefixEnd)).toBe(b.message.slice(0, b.prefixEnd));
  });
});

describe("le plafond de sortie (10.27.2)", () => {
  it("la question part avec son plafond ; atteint (`max_tokens`), c'est une panne avec « Réessayer », jamais une phrase coupée", async () => {
    const seen: (number | undefined)[] = [];
    setAskModelForTests(({ maxTokens }) => {
      seen.push(maxTokens);
      async function* deltas() {
        yield "NOMS: Ariadne\n\nAriadne construit le labyrinthe. Puis elle";
      }
      return { deltas: deltas(), done: Promise.resolve({ inTokens: 10, outTokens: ASK_MAX_OUTPUT_TOKENS, stop: "max_tokens" }) };
    });
    const r = await ask();
    expect(seen).toEqual([ASK_MAX_OUTPUT_TOKENS]);
    expect(r.events.at(-1)).toEqual({ t: "error", code: "erreur" });
    expect(logError).toHaveBeenCalledWith("ask/model", expect.objectContaining({ message: expect.stringContaining("max_tokens") }));
  });
});
