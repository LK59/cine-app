import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { selfWarmPassFor, runSelfWarm, SELF_WARM_HEADER, SELF_WARM_PATHS } from "@/lib/selfWarm";

/** Une requête telle que le proxy la voit. */
function req(path: string, headers: Record<string, string>, method = "GET") {
  const h = new Headers(headers);
  return { method, nextUrl: { pathname: path }, headers: h };
}

describe("le préchauffage des catalogues par le serveur lui-même", () => {
  let token = "";

  beforeEach(async () => {
    process.env.CINE_PEER_HEADER = "1";
    delete process.env.CINE_SELF_WARM_TOKEN;
    // Le jeton est tiré par le premier préchauffage : on le récupère sur la requête envoyée.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
    await runSelfWarm("3999");
    token = new Headers(fetchSpy.mock.calls[0][1]?.headers).get(SELF_WARM_HEADER) ?? "";
    fetchSpy.mockRestore();
  });

  afterEach(() => {
    delete process.env.CINE_PEER_HEADER;
    delete process.env.CINE_SELF_WARM_TOKEN;
    vi.restoreAllMocks();
  });

  it("demande les deux catalogues sur la boucle locale, avec le jeton", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}"));
    await runSelfWarm("3999");
    expect(fetchSpy.mock.calls.map((c) => String(c[0]))).toEqual(SELF_WARM_PATHS.map((p) => `http://127.0.0.1:3999${p}`));
    expect(token.length).toBeGreaterThan(30);
  });

  it("passe : boucle locale + jeton + GET sur un catalogue", () => {
    for (const path of SELF_WARM_PATHS) {
      expect(selfWarmPassFor(req(path, { "x-cine-peer": "127.0.0.1", [SELF_WARM_HEADER]: token }))).toBe(true);
    }
  });

  it("refuse le jeton venu d'ailleurs que la machine elle-même", () => {
    expect(selfWarmPassFor(req("/api/cinema/movies", { "x-cine-peer": "172.20.0.16", [SELF_WARM_HEADER]: token }))).toBe(false);
  });

  it("refuse la boucle locale sans le bon jeton", () => {
    expect(selfWarmPassFor(req("/api/cinema/movies", { "x-cine-peer": "127.0.0.1" }))).toBe(false);
    expect(selfWarmPassFor(req("/api/cinema/movies", { "x-cine-peer": "127.0.0.1", [SELF_WARM_HEADER]: token + "x" }))).toBe(false);
  });

  it("refuse toute autre adresse, et tout autre verbe", () => {
    const ok = { "x-cine-peer": "127.0.0.1", [SELF_WARM_HEADER]: token };
    expect(selfWarmPassFor(req("/api/jellyfin/resume", ok))).toBe(false);
    expect(selfWarmPassFor(req("/api/cinema/movies/1", ok))).toBe(false);
    expect(selfWarmPassFor(req("/api/cinema/movies", ok, "POST"))).toBe(false);
  });

  it("sans connexion notée par le démarrage (next dev), rien ne passe", () => {
    delete process.env.CINE_PEER_HEADER;
    expect(selfWarmPassFor(req("/api/cinema/movies", { "x-cine-peer": "127.0.0.1", [SELF_WARM_HEADER]: token }))).toBe(false);
  });

  it("sans jeton tiré (pas de préchauffage dans ce processus), rien ne passe", () => {
    delete process.env.CINE_SELF_WARM_TOKEN;
    expect(selfWarmPassFor(req("/api/cinema/movies", { "x-cine-peer": "127.0.0.1", [SELF_WARM_HEADER]: token }))).toBe(false);
  });
});
