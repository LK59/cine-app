import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Chasse aux bugs du 11/10/2026, zone 5 — le relais de reprise du serveur (castProgress.ts, §64).
// Ils échouaient sur 6712fd2c (8.36.2) ; corrigé en 8.36.3, gardés comme garde-fous.

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
vi.mock("@/lib/itemVisibility", () => ({ assertVisible: async () => null }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));
vi.mock("@/lib/config", () => ({
  config: {
    player: { enabled: true },
    jellyfin: { url: "http://jf.test", apiKey: "key" },
    app: { sessionSecret: "secret-de-test-assez-long-pour-signer" },
  },
}));
const noteCastSegment = vi.fn();
vi.mock("@/lib/castProgress", async (orig) => ({
  ...(await orig<typeof import("@/lib/castProgress")>()),
  castProgressRelay: () => ({ noteCastSegment, notePageReport: vi.fn() }),
}));

const mockFetch = vi.fn();
const itemId = "c".repeat(32);

function req(url: string, cookie: string | null): NextRequest {
  const parsed = new URL(url);
  return {
    method: "GET",
    url: parsed.toString(),
    cookies: { get: (name: string) => (name === "cine_session" && cookie ? { value: cookie } : undefined) },
    headers: new Headers({ host: "cine.example" }),
    nextUrl: parsed,
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

function upstream() {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({ start: (c) => c.close() }),
    headers: new Headers({ "Content-Type": "video/mp4" }),
    text: async () => "",
    blob: async () => new Blob([""]),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
});

describe("bughunt zone 5 — une lecture DANS LA PAGE passe par le relais", () => {
  // Le constat qui rend le reste réel — toute lecture du lecteur serveur dans la page (Fire TV,
  // Mac Safari 17, Edge sans HEVC) demande ses segments avec le laissez-passer de `castUrl` — est
  // gardé sur le lecteur rendu, WebKit et hls.js : PlayerHost-gardes.test.tsx (22/10/2026, plus
  // sur le texte de PlayerHost.tsx).

  it("un segment demandé par la page (cookie + laissez-passer de castUrl) ne doit pas nourrir le relais ni porter CORS", async () => {
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-louis", jti: "j1" });
    mockFetch.mockResolvedValue(upstream());
    const { signCastToken } = await import("@/lib/castToken");
    const token = encodeURIComponent(await signCastToken(itemId, "louis", Date.now(), undefined, "jf-louis"));
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const res = await GET(
      req(`https://cine.example/api/jellyfin/stream/${itemId}/hls1/main/40.mp4?PlaySessionId=p&runtimeTicks=1200000000&castToken=${token}`, "cookie"),
      { params: Promise.resolve({ itemId, path: ["hls1", "main", "40.mp4"] }) }
    );
    // Promis (castProgress.ts en-tête, castCors.ts) : « une lecture dans la page ne passe jamais
    // par ici », « garde exactement ses en-têtes d'avant ».
    expect(noteCastSegment).not.toHaveBeenCalled();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("bughunt zone 5 — page en pause : le battement réel (60–70 s) croise la fraîcheur de 60 s", async () => {
  const { CastProgressRelay, PAGE_FRESH_MS } = await import("@/lib/castProgress");
  const seg = (start: number) => ({
    jfId: "jf-louis",
    user: "louis",
    itemId,
    restPath: `hls1/main/${Math.round(start / 3)}.mp4`,
    search: new URLSearchParams(`runtimeTicks=${start * 10_000_000}`),
  });

  it("une page vivante (pause, un battement toutes les 60–70 s comme usePlaybackSession) n'est jamais relayée ni arrêtée", () => {
    // usePlaybackSession : vérifie toutes les 10 s, envoie en pause quand 60 s sont passées → un
    // battement toutes les 60 à 70 s. À 60 s (8.36.2), la page passait pour morte jusqu'à 10 s par
    // minute ; la fraîcheur doit couvrir largement le battement de pause.
    expect(PAGE_FRESH_MS).toBeGreaterThan(70_000);
    const save = vi.fn(async () => "position");
    const log = vi.fn();
    const r = new CastProgressRelay({ save, log });
    const T0 = 1_000_000;
    // La page rapporte (pause) à 0, 70 s, 140 s, 210 s.
    r.notePageReport("jf-louis", itemId, T0);
    // Le lecteur (ou la télé) finit de remplir son tampon juste après la mise en pause, puis un
    // dernier segment tombe dans la fenêtre 60–70 s.
    r.noteCastSegment(seg(600), T0 + 5_000);
    r.noteCastSegment(seg(603), T0 + 65_000);
    r.notePageReport("jf-louis", itemId, T0 + 70_000);
    r.notePageReport("jf-louis", itemId, T0 + 140_000);
    // Plus aucun segment (tampon plein), la page toujours là, en pause : le ménage passe à 205 s.
    r.sweep(T0 + 205_000);
    r.notePageReport("jf-louis", itemId, T0 + 210_000);
    expect(save).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
