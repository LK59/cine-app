import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Le client de `laterna-xray` (DECISIONS.md §138) : le contrat v1, une clé en `Bearer`, l'adresse et
 * la clé relues à chaque appel (§48), un 404 du service lu comme « rien » et non comme une erreur.
 */

const cfg = vi.hoisted(() => ({ enabled: true, url: "http://laterna-xray:8000/", apiKey: "clé-1" }));
vi.mock("@/lib/config", () => ({
  config: {
    get xray() {
      return cfg;
    },
  },
}));

const calls: { url: string; init: RequestInit }[] = [];
let answer: () => Response = () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls.length = 0;
  Object.assign(cfg, { enabled: true, url: "http://laterna-xray:8000/", apiKey: "clé-1" });
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer();
  });
});
afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("le client laterna-xray", () => {
  it("signe chaque appel en Bearer, avec une borne de temps", async () => {
    const { xray } = await import("@/lib/clients/xray");
    answer = json({ ok: true, version: "1.0.0", model: { name: "buffalo_l", ready: true, license: "non-commercial", error: null }, decode: { vaapi: true, device: null }, queue: { pending: 0, running: null } });
    const health = await xray.health();
    expect(health.model.name).toBe("buffalo_l");
    expect(calls[0].url).toBe("http://laterna-xray:8000/health");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer clé-1");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("relit l'adresse et la clé à chaque appel", async () => {
    const { xray } = await import("@/lib/clients/xray");
    answer = json({ itemId: "a", status: "queued", position: 1 }, 202);
    await xray.enqueue({ itemId: "a".repeat(32), path: "/media/x.mkv", etag: "e", priority: "high", seriesId: null, cast: [] });
    cfg.url = "http://ailleurs:9000";
    cfg.apiKey = "clé-2";
    await xray.enqueue({ itemId: "a".repeat(32), path: "/media/x.mkv", etag: "e", priority: "high", seriesId: null, cast: [] });
    expect(calls.map((c) => c.url)).toEqual(["http://laterna-xray:8000/jobs", "http://ailleurs:9000/jobs"]);
    expect((calls[1].init.headers as Record<string, string>).Authorization).toBe("Bearer clé-2");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ priority: "high", path: "/media/x.mkv" });
  });

  it("lit un 404 comme « rien sur cet élément », pas comme une erreur", async () => {
    const { xray } = await import("@/lib/clients/xray");
    answer = () => new Response("not found", { status: 404 });
    expect(await xray.itemStatus("b".repeat(32))).toBeNull();
    expect(await xray.scenes("b".repeat(32))).toBeNull();
    await expect(xray.forget("b".repeat(32))).resolves.toBeUndefined();
    expect(calls.map((c) => c.url)).toEqual([
      `http://laterna-xray:8000/items/${"b".repeat(32)}`,
      `http://laterna-xray:8000/items/${"b".repeat(32)}/scenes`,
      `http://laterna-xray:8000/items/${"b".repeat(32)}`,
    ]);
    expect(calls[2].init.method).toBe("DELETE");
  });

  it("lève sur un refus (clé fausse, chemin hors de la médiathèque)", async () => {
    const { xray } = await import("@/lib/clients/xray");
    answer = () => new Response("bad path", { status: 400 });
    await expect(xray.enqueue({ itemId: "a".repeat(32), path: "/ailleurs", etag: "e", priority: "low", seriesId: null, cast: [] })).rejects.toMatchObject({ status: 400 });
    answer = () => new Response("", { status: 401 });
    await expect(xray.health()).rejects.toMatchObject({ status: 401 });
  });

  it("n'est configuré qu'allumé, avec une adresse et une clé", async () => {
    const { xrayConfigured } = await import("@/lib/clients/xray");
    expect(xrayConfigured()).toBe(true);
    cfg.apiKey = "";
    expect(xrayConfigured()).toBe(false);
    cfg.apiKey = "k";
    cfg.enabled = false;
    expect(xrayConfigured()).toBe(false);
  });
});

describe("le test de connexion de la Configuration", () => {
  it("dit le modèle, s'il est prêt, et le décodage matériel", async () => {
    const { testService } = await import("@/lib/settings/testService");
    answer = json({ ok: true, version: "1.0.0", model: { name: "auraface", ready: false, license: "apache-2.0", error: null }, decode: { vaapi: false, device: null }, queue: { pending: 3, running: null } });
    const values: Record<string, string> = { XRAY_URL: "http://laterna-xray:8000", XRAY_API_KEY: "secret" };
    const result = await testService("xray", (k) => values[k] ?? "");
    expect(result).toEqual({
      ok: true,
      detail: "laterna-xray 1.0.0",
      xray: { model: "auraface", ready: false, license: "apache-2.0", error: null, vaapi: false, pending: 3 },
    });
    expect(calls[0].url).toBe("http://laterna-xray:8000/health");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });

  it("dit « refusé » sur une clé fausse, et « adresse invalide » sans réseau", async () => {
    const { testService } = await import("@/lib/settings/testService");
    answer = () => new Response("", { status: 401 });
    expect(await testService("xray", (k) => (k === "XRAY_URL" ? "http://x:8000" : "k"))).toEqual({ ok: false, detail: "unauthorized" });
    calls.length = 0;
    expect(await testService("xray", (k) => (k === "XRAY_URL" ? "laterna-xray:8000" : "k"))).toEqual({ ok: false, detail: "invalid-url" });
    expect(calls).toHaveLength(0);
  });
});

describe("le réglage", () => {
  it("coupé par défaut, l'adresse du conteneur par défaut, la clé secrète, et un service qu'on peut tester", async () => {
    const { SETTINGS_BY_KEY, TESTABLE_GROUPS } = await import("@/lib/settings/schema");
    expect(SETTINGS_BY_KEY.get("XRAY_ENABLED")).toMatchObject({ group: "xray", kind: "audience", fallback: "off", inApp: true });
    expect(SETTINGS_BY_KEY.get("XRAY_URL")).toMatchObject({ group: "xray", kind: "url", fallback: "http://laterna-xray:8000", inApp: true });
    expect(SETTINGS_BY_KEY.get("XRAY_API_KEY")).toMatchObject({ group: "xray", kind: "secret", inApp: true });
    expect(TESTABLE_GROUPS).toContain("xray");
  });
});
