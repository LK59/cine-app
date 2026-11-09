import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import type { NextRequest } from "next/server";

// Les fonctions payantes chez les trois fournisseurs, et un seul plafond mensuel (DECISIONS.md §140) ;
// les réglages détachés des questions — titre, personne, « Jusqu'ici » (§139, 09/11/2026).
// Le fournisseur est un double (`setProviderFactoryForTests`) : aucun appel réseau ne part.

await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-ai140-"));
});

type Aud = "off" | "admins" | "tous";
const cfg = {
  provider: "openai",
  apiKey: "sk-test",
  model: "",
  budget: "5",
  ask: "tous" as Aud,
  person: "" as "" | Aud,
  sofar: "" as "" | Aud,
  xray: "tous" as Aud,
  xrayUrl: "http://xray",
  describe: true,
  recap: true,
};
const parse = (v: string): Aud => (v === "admins" ? "admins" : v === "tous" ? "tous" : "off");
vi.mock("@/lib/config", () => ({
  config: {
    subtitleGen: {
      enabled: true,
      get provider() { return cfg.provider; },
      get apiKey() { return cfg.apiKey; },
      get model() { return cfg.model; },
      get budgetUsd() { return cfg.budget; },
      priceInput: "",
      priceOutput: "",
    },
    describeSearch: { get enabled() { return cfg.describe; } },
    recap: { get enabled() { return cfg.recap; } },
    ask: {
      get audience() { return cfg.ask; },
      get enabled() { return cfg.ask !== "off"; },
      get personAudience() { return cfg.person ? parse(cfg.person) : cfg.ask; },
      get sofarAudience() { return cfg.sofar ? parse(cfg.sofar) : cfg.ask; },
    },
    xray: {
      get audience() { return cfg.xray; },
      get enabled() { return cfg.xray !== "off"; },
      get url() { return cfg.xrayUrl; },
      apiKey: "x",
    },
    jellyfin: { url: "http://jf", apiKey: "k" },
    app: { language: "fr" },
  },
}));
const sessions: Record<string, { jfId?: string; jfUser?: string; role: string }> = {};
vi.mock("@/lib/session", () => ({ verifySessionFull: vi.fn(async (token?: string) => (token ? sessions[token] ?? null : null)) }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/jellyfinAuth", () => ({ jellyfinAuthHeaders: () => ({}) }));
const { fetchMock, taskLines } = vi.hoisted(() => ({ fetchMock: vi.fn(), taskLines: vi.fn() }));
vi.mock("@/lib/jellyfinBreaker", () => ({ jellyfinFetch: fetchMock }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/taskLog", () => ({ taskLog: (...a: unknown[]) => taskLines(...a) }));
vi.mock("@/lib/eventLogs", () => ({ logAskQuestion: vi.fn(), logJusquici: vi.fn(), logRecap: vi.fn() }));
vi.mock("@/lib/xray/person", () => ({
  castPerson: async () => ({ person: { personId: 2, name: "Elliot Page", character: "Ariadne", order: 1, profilePath: null }, tmdb: { kind: "movie", id: 27205 } }),
}));

import { setProviderFactoryForTests, ProviderError, type TranslationCall } from "@/lib/subtitleGen/providers";
import { resetAskCachesForTests } from "@/lib/ask/service";
import { resetSofarForTests } from "@/lib/ask/sofar";
import { getDb } from "@/lib/db";
import { spendDb } from "@/lib/subtitleGen/store";
import { aiBudgetReached, askPersonAvailableFor, featureStatuses, sofarAvailableFor } from "@/lib/aiFeatures";
import { describedTitles, describeSearchAvailable, setDescribeModelForTests } from "@/lib/describeSearch";
import { defaultRecapModelForTests, runRecapPass } from "@/lib/recap/service";
import { AI_FEATURES } from "@/lib/aiFeatureTable";
import { SETTINGS_BY_KEY } from "@/lib/settings/schema";

const MOVIE = "a".repeat(32);
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
  UserData: { Played: false, PlayCount: 0, PlaybackPositionTicks: 600 * 10_000_000 },
  MediaSources: [{ Id: "f".repeat(32) }],
  MediaStreams: [{ Index: 3, Type: "Subtitle", Language: "fre", IsTextSubtitleStream: true }],
};

/** Le double du fournisseur : il garde chaque appel, et rend le texte réglé avec 1000/500/100 jetons. */
const calls: { provider: string; model: string; call: TranslationCall }[] = [];
let reply: string | ProviderError = "";
function fakeProvider() {
  setProviderFactoryForTests((s) => ({
    name: s.provider,
    model: s.model,
    async complete(call) {
      calls.push({ provider: s.provider, model: s.model, call });
      if (reply instanceof ProviderError) throw reply;
      const usage = { inputTokens: 1000, cacheWriteTokens: 0, cacheReadTokens: 500, outputTokens: 100 };
      return call.schema ? { json: JSON.parse(reply), text: reply, usage } : { text: reply, usage };
    },
  }));
}

function req(account: string, body: unknown): NextRequest {
  const cookies: Record<string, string> = { cine_session: account, "cine-lang": "fr" };
  return {
    headers: new Headers({ "user-agent": "Mozilla/5.0" }),
    cookies: { get: (name: string) => (cookies[name] ? { value: cookies[name] } : undefined) },
    json: async () => body,
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}
async function post(account: string, body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/cinema/ask/[itemId]/route");
  const res = await POST(req(account, body), { params: Promise.resolve({ itemId: MOVIE }) });
  const events = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: string; v?: string; code?: string });
  // Le texte tel que l'écran le montre : les mots ajoutés, un `reset` remet tout (10.28.0).
  let text = "";
  for (const e of events) {
    if (e.t === "reset") text = e.v ?? "";
    else if (e.t === "text") text = text ? `${text} ${e.v}` : (e.v ?? "");
  }
  return { events, text };
}
const question = (account: string, extra: Record<string, unknown> = {}) => post(account, { question: "Que vient-il de se passer ?", where: "lecteur", positionS: 600, ...extra });
const sofar = (account: string) => post(account, { mode: "jusquici", personId: 2, positionS: 12 * 60 });
const settle = () => new Promise((r) => setTimeout(r, 20));

let serial = 0;
function account(role = "user") {
  const name = `compte-${++serial}`;
  sessions[name] = { jfId: (serial + 500).toString(16).padStart(32, "d"), jfUser: name, role };
  return name;
}
const spent = () => spendDb.month().cost;

beforeEach(() => {
  Object.assign(cfg, { provider: "openai", apiKey: "sk-test", model: "", budget: "5", ask: "tous", person: "", sofar: "", xray: "tous", xrayUrl: "http://xray", describe: true, recap: true });
  calls.length = 0;
  reply = "NOMS: Ariadne\n\nAriadne construit le labyrinthe.";
  fakeProvider();
  resetAskCachesForTests();
  resetSofarForTests();
  getDb().prepare("DELETE FROM sofar_texts").run();
  getDb().prepare("DELETE FROM subtitle_gen_spend").run();
  taskLines.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/Subtitles/")) return new Response(SRT);
    if (url.endsWith(`/Items/${MOVIE}`)) return new Response(JSON.stringify(movie), { headers: { "content-type": "application/json" } });
    return new Response("", { status: 404 });
  });
});
afterEach(() => setProviderFactoryForTests(null));

describe("l'aiguillage : chaque fonction passe par le fournisseur réglé (§140)", () => {
  it.each(["openai", "google"])("une question (%s) : le modèle rapide, sans flux, réflexion basse, comptée", async (provider) => {
    cfg.provider = provider;
    const r = await question(account());
    expect(r.text).toBe("Ariadne construit le labyrinthe.");
    expect(r.events.at(-1)).toEqual({ t: "done" });
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe(provider === "openai" ? "gpt-6-luna" : "gemini-3.8-flash");
    expect(calls[0].call.effort).toBe("low");
    expect(calls[0].call.schema).toBeUndefined();
    // Les consignes d'abord, les sources et la question dans le message : le début stable, puis le variable.
    expect(calls[0].call.system).toContain("NOMS");
    expect(calls[0].call.user).toContain("Que vient-il de se passer ?");
    // 1000 × entrée + 500 × cache relu + 100 × sortie, au prix du modèle.
    const expected = provider === "openai" ? (1000 * 0.1 + 500 * 0.01 + 100 * 0.5) / 1e6 : (1000 * 0.75 + 500 * 0.075 + 100 * 3.75) / 1e6;
    expect(spent()).toBeCloseTo(expected, 12);
  });

  it("la recherche décrite (openai) : même prompt, même schéma, sortie structurée, comptée", async () => {
    setDescribeModelForTests(null);
    reply = JSON.stringify({ titles: [{ type: "movie", title: "Groundhog Day", original: "Groundhog Day", year: 1993 }] });
    const titles = await describedTitles(`le film où un type revit la même journée ${Date.now()}`);
    expect(titles).toEqual([{ type: "movie", title: "Groundhog Day", original: "Groundhog Day", year: 1993 }]);
    expect(calls[0].call.schemaName).toBe("described_titles");
    expect(calls[0].call.schema).toBeTruthy();
    expect(spent()).toBeGreaterThan(0);
  });

  it("un refus du fournisseur pour la recherche : rien, mais compté s'il a été facturé", async () => {
    setDescribeModelForTests(null);
    reply = new ProviderError("refusal", "refus", { inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 10 });
    expect(await describedTitles(`un film refusé ${Date.now()}`)).toEqual([]);
    expect(spent()).toBeCloseTo((100 * 0.1 + 10 * 0.5) / 1e6, 12);
  });

  it("« Précédemment » (google) : réflexion moyenne, schéma du récit, comptée", async () => {
    cfg.provider = "google";
    reply = JSON.stringify({ text: "Ted arrive.", names: [] });
    const out = await defaultRecapModelForTests()("consignes", "sources");
    expect(out.raw).toEqual({ text: "Ted arrive.", names: [] });
    expect(calls[0].call.effort).toBe("medium");
    expect(calls[0].call.schemaName).toBe("recap");
    expect(spent()).toBeGreaterThan(0);
  });

  it("une limite de débit chez le fournisseur : « limite » pour la question, comme chez Anthropic", async () => {
    reply = new ProviderError("rate", "limite de débit");
    const r = await question(account());
    expect(r.events).toEqual([{ t: "error", code: "limite" }]);
  });
});

describe("les garde-fous ne dépendent pas du fournisseur", () => {
  it("un nom absent de ce que le compte a vu : « rejected », aucune phrase (OpenAI)", async () => {
    reply = "NOMS: Saito\n\nSaito arrive au Japon.";
    const r = await question(account());
    expect(r.events).toEqual([{ t: "rejected" }]);
  });

  it("ce qui part au modèle s'arrête à la position, comme chez Anthropic", async () => {
    await question(account());
    // Le préfixe partagé dans `stable` (cache implicite du fournisseur), la question dans `user`.
    const sent = [...calls[0].call.stable, calls[0].call.user].join("");
    expect(sent).toContain("Ariadne construit le labyrinthe.");
    expect(sent).not.toContain("Fischer");
    expect(calls[0].call.user).toContain("Que vient-il de se passer ?");
  });

  it("« Jusqu'ici » (OpenAI) : gardé et partagé — le second compte ne rappelle pas le fournisseur", async () => {
    const a = await sofar(account());
    await settle();
    expect(a.text).toBe("Ariadne construit le labyrinthe.");
    const b = await sofar(account());
    expect(b.text).toBe("Ariadne construit le labyrinthe.");
    expect(calls).toHaveLength(1);
  });
});

describe("un seul plafond mensuel pour toutes les fonctions payantes", () => {
  function reach() {
    spendDb.add(5, { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
  }

  it("la dépense des questions s'ajoute à celle des sous-titres, et le franchir le dit une fois au journal", async () => {
    cfg.budget = "0.0002";
    spendDb.add(0.0001, { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 });
    expect(aiBudgetReached()).toBe(false);
    await question(account());
    expect(aiBudgetReached()).toBe(true);
    expect(taskLines).toHaveBeenCalledTimes(1);
    expect(String(taskLines.mock.calls[0][1])).toMatch(/plafond mensuel atteint/);
  });

  it("atteint : une question reçoit « budget », le fournisseur n'est pas appelé", async () => {
    reach();
    expect((await question(account())).events).toEqual([{ t: "error", code: "budget" }]);
    expect(calls).toHaveLength(0);
  });

  it("atteint : la recherche décrite n'est plus proposée", () => {
    expect(describeSearchAvailable()).toBe(true);
    reach();
    expect(describeSearchAvailable()).toBe(false);
  });

  it("atteint : « Précédemment » ne prépare plus rien (aucune requête, aucun appel)", async () => {
    reach();
    expect(await runRecapPass()).toEqual({ prepared: 0, rejected: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("atteint : « Jusqu'ici » se tait pour un texte à écrire, mais sert encore un texte gardé", async () => {
    const first = account();
    await sofar(first);
    await settle();
    reach();
    expect((await sofar(account())).text).toBe("Ariadne construit le labyrinthe.");
    getDb().prepare("DELETE FROM sofar_texts").run();
    resetSofarForTests();
    expect((await sofar(account())).events).toEqual([{ t: "error", code: "budget" }]);
    expect(calls).toHaveLength(1);
  });

  it("l'administrateur le voit : chaque fonction payante bloquée par « budget », les acteurs à l'écran non", () => {
    reach();
    const byId = Object.fromEntries(featureStatuses().map((s) => [s.id, s.blocked]));
    expect(byId).toMatchObject({ subtitles: "budget", describe: "budget", recap: "budget", askTitle: "budget", askPerson: "budget", sofar: "budget", xray: null });
  });
});

describe("les questions détachées : titre, personne, « Jusqu'ici » (§139)", () => {
  const admin = { role: "admin" };
  const user = { role: "user" };

  it("vides, la personne et « Jusqu'ici » suivent ASK_ENABLED — cette installation garde ce qu'elle avait", () => {
    cfg.ask = "admins";
    expect(askPersonAvailableFor(admin)).toBe(true);
    expect(sofarAvailableFor(admin)).toBe(true);
    expect(askPersonAvailableFor(user)).toBe(false);
    expect(sofarAvailableFor(user)).toBe(false);
  });

  it("les acteurs à l'écran sans fournisseur : le panneau d'une personne n'a que ses faits TMDB", () => {
    cfg.apiKey = "";
    expect(askPersonAvailableFor(admin)).toBe(false);
    expect(sofarAvailableFor(admin)).toBe(false);
  });

  it("les questions et « Jusqu'ici » sans les acteurs à l'écran : ni l'un ni l'autre", () => {
    cfg.xray = "off";
    expect(askPersonAvailableFor(admin)).toBe(false);
    expect(sofarAvailableFor(admin)).toBe(false);
    cfg.xray = "tous";
    cfg.xrayUrl = "";
    expect(sofarAvailableFor(admin)).toBe(false);
  });

  it("« Jusqu'ici » coupé mais les questions sur une personne ouvertes : la route refuse l'un, sert l'autre", async () => {
    cfg.sofar = "off";
    expect((await sofar(account())).events).toEqual([{ t: "error", code: "off" }]);
    expect((await question(account(), { about: "person" })).text).toBe("Ariadne construit le labyrinthe.");
  });

  it("les questions sur un titre coupées, celles sur une personne ouvertes", async () => {
    cfg.ask = "off";
    cfg.person = "tous";
    expect((await question(account())).events).toEqual([{ t: "error", code: "off" }]);
    expect((await question(account(), { about: "person" })).events.at(-1)).toEqual({ t: "done" });
    // « Jusqu'ici » suit toujours ASK_ENABLED, ici coupé.
    expect((await sofar(account())).events).toEqual([{ t: "error", code: "off" }]);
  });

  it("les questions sur une personne réservées aux administrateurs : un compte ordinaire reçoit « off »", async () => {
    cfg.person = "admins";
    expect((await question(account("user"), { about: "person" })).events).toEqual([{ t: "error", code: "off" }]);
    expect((await question(account("admin"), { about: "person" })).events.at(-1)).toEqual({ t: "done" });
  });
});

describe("ce que la page des réglages dit de chaque fonction", () => {
  const load = (lang: string) => JSON.parse(readFileSync(`src/locales/${lang}.json`, "utf8")) as Record<string, Record<string, Record<string, string>>>;

  it("chaque fonction a son réglage, et chaque différence entre fournisseurs est dite dans les quatre langues", () => {
    for (const f of AI_FEATURES) expect(SETTINGS_BY_KEY.get(f.setting), f.setting).toBeTruthy();
    const notes = new Set(AI_FEATURES.flatMap((f) => Object.values(f.providers).flat()));
    for (const lang of ["fr", "en", "es", "de"]) {
      const ai = load(lang).aiFeatures;
      for (const f of AI_FEATURES) {
        expect(ai.names[f.id], `${lang} names.${f.id}`).toBeTruthy();
        expect(ai.what[f.id], `${lang} what.${f.id}`).toBeTruthy();
      }
      for (const n of notes) expect(ai.notes[n], `${lang} notes.${n}`).toBeTruthy();
    }
  });

  it("les trois fournisseurs pour chaque fonction payante, les mêmes garde-fous, et le banc dit seulement pour Claude", () => {
    for (const f of AI_FEATURES.filter((x) => x.paid)) {
      expect(Object.keys(f.providers).sort()).toEqual(["anthropic", "google", "openai"]);
      expect(f.providers.anthropic).toContain("benched");
      expect(f.providers.openai).toContain("notBenched");
      expect(f.providers.google).toContain("notBenched");
    }
  });

  it("l'allemand vouvoie, et aucune chaîne ajoutée ne dit « (s) »", () => {
    const de = JSON.stringify(load("de").aiFeatures);
    expect(de).not.toMatch(/\b(du|dein|deine|dich|dir)\b/i);
    expect(JSON.stringify(load("fr").aiFeatures)).not.toContain("(s)");
  });
});
