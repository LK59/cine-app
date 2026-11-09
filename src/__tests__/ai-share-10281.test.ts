import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Un lien de partage n'a **aucune** fonction d'IA (10.28.1, DECISIONS.md §112, §139, §140 — consigne du
// propriétaire) : ni questions sur le titre, ni questions sur une personne, ni « Jusqu'ici », quel que soit le
// public réglé (`tous` veut dire les comptes du foyer). Chaque porte est au serveur : la route des questions
// (GET de préparation, POST titre / personne / « Jusqu'ici ») répond `off` sans appeler le modèle, et la
// configuration publique dit `false` aux trois drapeaux — ce que l'écran lit pour cacher la pilule. Les acteurs à
// l'écran ordinaires restent (`xrayAvailable`) ; leur route est testée dans `xray-player-route.test.ts`.

await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-ai-share-"));
});

vi.mock("@/lib/config", () => ({
  config: {
    app: { language: "fr" },
    player: { enabled: true, serverFallback: false },
    home: { continueHero: false },
    ask: { enabled: true, audience: "tous", personAudience: "tous", sofarAudience: "tous" },
    xray: { enabled: true, audience: "tous", url: "http://xray", apiKey: "x" },
    recap: { enabled: false },
    subtitleGen: { provider: "anthropic", apiKey: "sk-test" },
    jellyfin: { url: "http://jf", apiKey: "k" },
    radarr: { apiKey: "" },
    sonarr: { apiKey: "" },
    bazarr: { apiKey: "" },
    jackett: { apiKey: "" },
    jellyseerr: { apiKey: "" },
    qbittorrent: { password: "" },
    tmdb: { apiKey: "" },
  },
}));
const session = vi.hoisted(() => ({ current: null as null | { role: string; jfId?: string; jfUser?: string; u?: string; sh?: string } }));
vi.mock("@/lib/session", () => ({ verifySessionFull: vi.fn(async () => session.current) }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const { fetchMock, askLog, sofarLog } = vi.hoisted(() => ({ fetchMock: vi.fn(async () => new Response("", { status: 404 })), askLog: vi.fn(), sofarLog: vi.fn() }));
vi.mock("@/lib/jellyfinBreaker", () => ({ jellyfinFetch: fetchMock }));
vi.mock("@/lib/jellyfinAuth", () => ({ jellyfinAuthHeaders: () => ({}) }));
vi.mock("@/lib/eventLogs", () => ({ logAskQuestion: (...a: unknown[]) => askLog(...a), logJusquici: (...a: unknown[]) => sofarLog(...a), logRecap: vi.fn() }));
vi.mock("@/lib/xray/person", () => ({ castPerson: vi.fn(async () => null), actorFactsForAsk: vi.fn(async () => null) }));
vi.mock("@/lib/xray/scenes", () => ({ scenesForPlayer: async () => ({ status: "none", complete: false, analyzedUntil: 0, scenes: [] }) }));

import { setAskModelForTests } from "@/lib/ask/service";

const ITEM = "a".repeat(32);
const SHARE = { role: "share", jfId: "e".repeat(32), jfUser: "partage-1", sh: "lien-1" };
const ADMIN = { role: "admin", jfId: "d".repeat(32), jfUser: "admin" };

function req(body?: unknown): NextRequest {
  return {
    headers: new Headers({ "user-agent": "Mozilla/5.0" }),
    cookies: { get: (name: string) => (name === "cine_session" ? { value: "t" } : name === "cine-lang" ? { value: "fr" } : undefined) },
    json: async () => body,
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

const model = vi.fn();
beforeEach(() => {
  model.mockReset();
  askLog.mockReset();
  setAskModelForTests(model);
});

describe("la route des questions refuse tout à un lien de partage, même réglée sur `tous`", () => {
  it("GET (la préparation) : `available: false`, rien de préparé chez Jellyfin", async () => {
    session.current = SHARE;
    const { GET } = await import("@/app/api/cinema/ask/[itemId]/route");
    const body = await (await GET(req(), { params: Promise.resolve({ itemId: ITEM }) })).json();
    expect(body).toEqual({ available: false });
    expect(fetchMock).not.toHaveBeenCalled();
    session.current = ADMIN;
    expect(await (await GET(req(), { params: Promise.resolve({ itemId: ITEM }) })).json()).toEqual({ available: true });
  });

  it.each([
    ["une question sur le titre", { question: "Qui est Cobb ?", where: "lecteur", positionS: 600 }],
    ["une question sur une personne", { question: "Quel âge a-t-elle ?", where: "lecteur", positionS: 600, personId: 2, about: "person" }],
    ["« Jusqu'ici »", { mode: "jusquici", personId: 2, positionS: 600 }],
  ])("POST, %s : `off`, le modèle jamais appelé", async (_label, body) => {
    session.current = SHARE;
    const { POST } = await import("@/app/api/cinema/ask/[itemId]/route");
    const res = await POST(req(body), { params: Promise.resolve({ itemId: ITEM }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`${JSON.stringify({ t: "error", code: "off" })}\n`);
    expect(model).not.toHaveBeenCalled();
  });
});

describe("la configuration publique : aucun drapeau d'IA pour un lien", () => {
  it("`askAvailable`, `askPersonAvailable`, `sofarAvailable` faux ; les acteurs à l'écran ordinaires restent", async () => {
    const { GET } = await import("@/app/api/config/public/route");
    session.current = SHARE;
    const share = await (await GET(req())).json();
    expect(share).toMatchObject({ askAvailable: false, askPersonAvailable: false, sofarAvailable: false, xrayAvailable: true });
    session.current = ADMIN;
    const admin = await (await GET(req())).json();
    expect(admin).toMatchObject({ askAvailable: true, askPersonAvailable: true, sofarAvailable: true, xrayAvailable: true });
  });
});

describe("la préparation suit les trois portes (10.28.1)", () => {
  it("« Jusqu'ici » seul ouvert : le GET prépare le contexte (il ne préparait que pour les questions)", async () => {
    const { config } = await import("@/lib/config");
    const ask = config.ask as unknown as Record<string, string | boolean>;
    const saved = { ...ask };
    Object.assign(ask, { audience: "off", enabled: false, personAudience: "off", sofarAudience: "tous" });
    try {
      session.current = ADMIN;
      fetchMock.mockClear();
      const other = "b".repeat(32);
      const { GET } = await import("@/app/api/cinema/ask/[itemId]/route");
      expect(await (await GET(req(), { params: Promise.resolve({ itemId: other }) })).json()).toEqual({ available: true });
      await vi.waitFor(() => expect((fetchMock.mock.calls as unknown[][]).some(([url]) => String(url).includes(other))).toBe(true));
    } finally {
      Object.assign(ask, saved);
    }
  });
});
