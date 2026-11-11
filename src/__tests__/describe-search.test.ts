import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// La recherche par description (07/11/2026) : la phrase va au modèle, ses titres sont retrouvés
// dans TMDB, et seules des cartes de recherche ordinaires ressortent — jamais un titre que TMDB n'a
// pas, jamais un titre caché au compte. Aucun appel réseau : le modèle est remplacé.

const settings = { enabled: true, provider: "anthropic", apiKey: "sk-test" };
vi.mock("@/lib/config", () => ({
  config: {
    describeSearch: { get enabled() { return settings.enabled; } },
    subtitleGen: { get provider() { return settings.provider; }, get apiKey() { return settings.apiKey; } },
  },
}));
const sessions: Record<string, { jfId: string; role: string }> = {
  libre: { jfId: "jf-libre", role: "user" },
  bloque: { jfId: "jf-bloque", role: "user" },
};
vi.mock("@/lib/session", () => ({
  verifySessionFull: vi.fn(async (token?: string) => (token ? sessions[token] ?? null : null)),
}));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/i18n", () => ({ LOCALE_COOKIE: "cine-lang", getTmdbLocale: () => "fr-FR" }));
vi.mock("@/lib/catalogueMembers", () => ({
  catalogueMembers: async () => ({ movies: [{ id: 7 }], series: [] }),
}));
vi.mock("@/lib/blockedTags", () => ({
  hiddenTmdbKeysFor: async (jfId?: string | null) => new Set(jfId === "jf-bloque" ? ["movie:137"] : []),
}));
const logError = vi.fn();
vi.mock("@/lib/logger", () => ({ logError: (...args: unknown[]) => logError(...args) }));
const searchLog = vi.fn();
vi.mock("@/lib/eventLogs", () => ({ logDescribeSearch: (...args: unknown[]) => searchLog(...args) }));

const tmdbMock = {
  isEnabled: () => true,
  searchMovies: vi.fn(),
  searchTv: vi.fn(),
};
vi.mock("@/lib/clients/tmdb", () => ({
  tmdb: tmdbMock,
  createTmdbClient: () => tmdbMock,
  TMDB_IMAGE_BASE: "https://image.tmdb.org/t/p",
}));
// Le cache disque des phrases : traversé d'office ; `persist.on` le fait garder (la borne du jour, 11/11/2026).
const persist = vi.hoisted(() => ({ on: false, kept: new Map<string, unknown>() }));
vi.mock("@/lib/server-cache", () => ({
  cachedMovies: async () => [{ tmdbId: 137, id: 7, hasFile: true }],
  cachedSeries: async () => [],
  withCache: async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn(),
  withPersistentCache: async (key: string, _ttl: number, fn: () => Promise<unknown>) => {
    if (persist.on && persist.kept.has(key)) return persist.kept.get(key);
    const value = await fn();
    if (persist.on) persist.kept.set(key, value);
    return value;
  },
}));

import { looksLikeDescription, describeKey } from "@/lib/describeQuery";
import { parseDescribed, pickTmdbMatch, setDescribeModelForTests, type DescribedTitle } from "@/lib/describeSearch";
import { AI_CALLS_PER_DAY, aiDailyTake, resetAiDailyForTests } from "@/lib/aiFeatures";

const movie = (id: number, title: string, date: string, original = title) => ({
  id, title, original_title: original, release_date: date, overview: "", poster_path: null, backdrop_path: null, vote_average: 7, genre_ids: [],
});

function req(q: string | null, account = "libre"): NextRequest {
  const cookies: Record<string, string> = { cine_session: account };
  return {
    nextUrl: { searchParams: new URLSearchParams(q === null ? {} : { q }) },
    headers: new Headers({ "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)" }),
    cookies: { get: (name: string) => (cookies[name] ? { value: cookies[name] } : undefined) },
  } as unknown as NextRequest;
}

async function call(q: string | null, account = "libre") {
  const { GET } = await import("@/app/api/search/describe/route");
  const res = await GET(req(q, account));
  return { status: res.status, body: await res.json() };
}

const model = vi.fn<(q: string) => Promise<DescribedTitle[]>>();

beforeEach(() => {
  settings.enabled = true;
  settings.provider = "anthropic";
  settings.apiKey = "sk-test";
  model.mockReset();
  persist.on = false;
  persist.kept.clear();
  resetAiDailyForTests();
  logError.mockReset();
  searchLog.mockReset();
  setDescribeModelForTests(model);
  tmdbMock.searchMovies.mockReset();
  tmdbMock.searchTv.mockReset();
  tmdbMock.searchTv.mockResolvedValue({ results: [] });
});

describe("looksLikeDescription — un appel payant ne part que pour une description", () => {
  it("reconnaît une description, dans les quatre langues", () => {
    expect(looksLikeDescription("le film où un type revit la même journée")).toBe(true);
    expect(looksLikeDescription("the movie where a guy lives in a fake show")).toBe(true);
    expect(looksLikeDescription("película del laberinto con un fauno")).toBe(true);
    expect(looksLikeDescription("Film über einen Mann, der rückwärts altert")).toBe(true);
  });

  it("laisse un titre à la recherche ordinaire", () => {
    expect(looksLikeDescription("dune")).toBe(false);
    expect(looksLikeDescription("le seigneur des anneaux")).toBe(false);
    expect(looksLikeDescription("film avec dicaprio")).toBe(false); // trois mots
  });

  it("une longue phrase est une description même sans mot repère", () => {
    expect(looksLikeDescription("un astronaute bloqué sur mars cultive des patates")).toBe(true);
  });

  it("une même phrase, à la ponctuation et aux accents près, est la même clé", () => {
    expect(describeKey("Le film où, un type…")).toBe(describeKey("le film ou un type"));
  });
});

describe("parseDescribed — la réponse du modèle n'est pas crue sur parole", () => {
  it("écarte ce qui est mal formé", () => {
    expect(parseDescribed("pas du json")).toEqual([]);
    expect(parseDescribed(JSON.stringify({ titles: "non" }))).toEqual([]);
    const out = parseDescribed(JSON.stringify({ titles: [
      { type: "movie", title: "Memento", original: "Memento", year: 2000 },
      { type: "poème", title: "x", original: "x", year: 2000 },
      { type: "series", title: "", original: "", year: 2008 },
      { type: "movie", title: "Sans année", original: "Sans année", year: 99999 },
    ] }));
    expect(out).toEqual([
      { type: "movie", title: "Memento", original: "Memento", year: 2000 },
      { type: "movie", title: "Sans année", original: "Sans année", year: 0 },
    ]);
  });

  it("ne garde pas plus de huit titres", () => {
    const titles = Array.from({ length: 20 }, (_, i) => ({ type: "movie", title: `T${i}`, original: `T${i}`, year: 2000 }));
    expect(parseDescribed(JSON.stringify({ titles }))).toHaveLength(8);
  });
});

describe("pickTmdbMatch — le bon titre, ou rien", () => {
  const wanted: DescribedTitle = { type: "movie", title: "Groundhog Day", original: "Groundhog Day", year: 1993 };

  it("le même titre à l'année près", () => {
    const hits = [movie(1, "Un jour sans fin", "2022-01-01", "Groundhog Day"), movie(137, "Un jour sans fin", "1993-02-11", "Groundhog Day")];
    expect(pickTmdbMatch(wanted, hits)?.id).toBe(137);
    expect(pickTmdbMatch({ ...wanted, year: 1994 }, [movie(137, "x", "1993-02-11", "Groundhog Day")])?.id).toBe(137);
  });

  it("un titre traduit autrement : le premier résultat, s'il est de la même année", () => {
    const intouchables: DescribedTitle = { type: "movie", title: "The Intouchables", original: "Les Intouchables", year: 2011 };
    expect(pickTmdbMatch(intouchables, [movie(77338, "Intouchables", "2011-11-02")])?.id).toBe(77338);
  });

  it("un homonyme d'une autre époque n'est pas ce titre", () => {
    expect(pickTmdbMatch(wanted, [movie(9, "Groundhog Day", "2015-01-01")])).toBeNull();
    expect(pickTmdbMatch(wanted, [movie(9, "Autre chose", "2015-01-01")])).toBeNull();
  });
});

describe("/api/search/describe", () => {
  it("coupée ou sans clé : n'existe pas, et rien ne part — OpenAI et Gemini comptent depuis le 09/11/2026 (§140)", async () => {
    settings.enabled = false;
    expect((await call(null)).body).toEqual({ available: false, results: [] });
    expect((await call("le film où un type revit la même journée")).body.results).toEqual([]);
    settings.enabled = true;
    settings.provider = "openai";
    expect((await call(null)).body.available).toBe(true);
    settings.provider = "google";
    expect((await call(null)).body.available).toBe(true);
    settings.provider = "anthropic";
    settings.apiKey = " ";
    expect((await call(null)).body.available).toBe(false);
    expect(model).not.toHaveBeenCalled();
  });

  it("un titre tapé en entier n'appelle pas le modèle", async () => {
    expect((await call("dune")).body).toEqual({ available: true, results: [] });
    expect(model).not.toHaveBeenCalled();
  });

  it("rend des cartes ordinaires : dans la bibliothèque ou à demander, sans ce que TMDB n'a pas", async () => {
    model.mockResolvedValue([
      { type: "movie", title: "Groundhog Day", original: "Groundhog Day", year: 1993 },
      { type: "movie", title: "Palm Springs", original: "Palm Springs", year: 2020 },
      { type: "movie", title: "Inventé", original: "Inventé", year: 2001 },
    ]);
    tmdbMock.searchMovies.mockImplementation(async (q: string) => ({
      results: q === "Groundhog Day" ? [movie(137, "Un jour sans fin", "1993-02-11", "Groundhog Day")] : q === "Palm Springs" ? [movie(587792, "Palm Springs", "2020-07-10")] : [],
    }));
    const { status, body } = await call("le film où un type revit la même journée");
    expect(status).toBe(200);
    expect(body.results.map((r: { tmdbId: number; inLibrary: boolean; available: boolean; radarrId: number | null }) => [r.tmdbId, r.inLibrary, r.available, r.radarrId])).toEqual([
      [137, true, true, 7],
      [587792, false, false, null],
    ]);
    expect(body.results[0].title).toBe("Un jour sans fin");
    // Le journal : des chiffres, jamais la phrase.
    expect(searchLog).toHaveBeenCalledTimes(1);
    const line = searchLog.mock.calls[0][0];
    expect(line).toMatchObject({ status: "ok", words: 9, titles: 3, results: 2, inLibrary: 1 });
    expect(typeof line.ms).toBe("number");
    expect(typeof line.modelMs).toBe("number");
    expect(JSON.stringify(line)).not.toMatch(/journée|revit/);
  });

  it("un titre caché au compte ne sort pas (§54)", async () => {
    model.mockResolvedValue([{ type: "movie", title: "Groundhog Day", original: "Groundhog Day", year: 1993 }]);
    tmdbMock.searchMovies.mockResolvedValue({ results: [movie(137, "Un jour sans fin", "1993-02-11", "Groundhog Day")] });
    expect((await call("le film où un type revit la même journée", "bloque")).body.results).toEqual([]);
    expect((await call("le film où un type revit la même journée", "libre")).body.results).toHaveLength(1);
  });

  it("un échec du modèle est journalisé et ne rend rien", async () => {
    model.mockRejectedValue(new Error("529"));
    const { status, body } = await call("le film où un type revit la même journée");
    expect(status).toBe(502);
    expect(body.results).toEqual([]);
    expect(logError).toHaveBeenCalledWith("describe-search", expect.any(Error));
    expect(searchLog).toHaveBeenCalledWith(expect.objectContaining({ status: "erreur", words: 9 }));
  });
});

describe("la borne journalière commune aux appels payants (11/11/2026)", () => {
  it(`${AI_CALLS_PER_DAY} par compte et par jour, questions et « Jusqu'ici » compris : au-delà, « limite » et rien ne part ; une réponse du cache ne compte pas`, async () => {
    model.mockResolvedValue([]);
    persist.on = true;
    // Le compte a déjà fait le reste de ses appels du jour ailleurs (questions, « Jusqu'ici ») : il lui en reste deux.
    for (let i = 0; i < AI_CALLS_PER_DAY - 2; i++) expect(aiDailyTake("jf-libre")).toBe(true);
    expect((await call("le film où un type revit la même journée")).status).toBe(200);
    // La même phrase, servie par le cache : rien n'a coûté, la place est rendue.
    expect((await call("le film où un type revit la même journée")).status).toBe(200);
    expect(model).toHaveBeenCalledTimes(1);
    // La dernière place sert donc encore une phrase nouvelle…
    expect((await call("le film où une femme perd la mémoire chaque nuit")).status).toBe(200);
    expect(model).toHaveBeenCalledTimes(2);
    // …puis la borne est atteinte : « limite », le modèle n'est pas appelé.
    const over = await call("le film où un robot tombe amoureux dans l'espace");
    expect(over).toEqual({ status: 429, body: { available: true, results: [] } });
    expect(model).toHaveBeenCalledTimes(2);
    expect(searchLog).toHaveBeenLastCalledWith(expect.objectContaining({ status: "limite" }));
    // Un autre compte n'en est pas touché.
    expect((await call("le film où un robot tombe amoureux dans l'espace", "bloque")).status).toBe(200);
  });
});
