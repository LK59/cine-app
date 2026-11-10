import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Sa propre base : ce fichier écrit et vide les tables de la synchro (voir news-page-105.test.ts).
await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-subsync-routes-"));
});

/**
 * Les routes de Configuration → Synchro des sous-titres (DECISIONS.md §141) : administrateur seul, lecture
 * comprise (proxy et route) ; une portée mal formée refusée avant tout appel ; « Scanner » commande une mesure par
 * élément au service — et rien d'autre ne le fait ; les résultats relus seulement pendant qu'une mesure attend ;
 * « Recaler » refusé à une mesure périmée ; la route des sous-titres réécrit le WebVTT d'une piste recalée.
 */

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 604800,
  shouldRefresh: () => false,
  refreshSessionToken: async () => "renouvelé",
  reissueShareSessionToken: async () => "réémis",
}));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
const mockTaskLog = vi.fn();
vi.mock("@/lib/taskLog", () => ({ taskLog: (...a: unknown[]) => mockTaskLog(...a) }));

const EP1 = "1".repeat(32);
const EP2 = "2".repeat(32);
const SERIES = "5".repeat(32);
const svc = vi.hoisted(() => ({
  configured: true,
  orders: [] as Record<string, unknown>[],
  results: [] as unknown[],
  resultCalls: 0,
  etag: "v1",
}));
vi.mock("@/lib/clients/xray", () => ({
  xrayConfigured: () => svc.configured,
  xray: {
    subsyncEnqueue: async (job: Record<string, unknown>) => {
      svc.orders.push(job);
      return { itemId: job.itemId, status: "queued", position: 0 };
    },
    subsyncResults: async () => {
      svc.resultCalls++;
      return svc.results;
    },
  },
}));
const stream = (over: Record<string, unknown>) => ({ Type: "Subtitle", Index: 3, Codec: "subrip", ...over });
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getEpisodesAdmin: async () => [
      { Id: EP1, Name: "Pilote", ParentIndexNumber: 1, IndexNumber: 1 },
      { Id: EP2, Name: "Deux", ParentIndexNumber: 2, IndexNumber: 1 },
    ],
    getItemsWithStreams: async (ids: string[]) =>
      ids.map((id) => ({
        Id: id,
        Type: "Episode",
        Name: "Pilote",
        SeriesId: SERIES,
        SeriesName: "Show",
        ParentIndexNumber: id === EP1 ? 1 : 2,
        IndexNumber: 1,
        MediaSources: [
          {
            Id: id,
            Path: `/media/tv/Show/${id}.mkv`,
            ETag: svc.etag,
            MediaStreams: [
              stream({}),
              stream({ Index: 7, IsExternal: true, Path: `/media/tv/Show/${id}.fr.srt`, Language: "fre" }),
              stream({ Index: 8, IsExternal: true, Path: `/media/tv/Show/${id}.sup`, Codec: "pgssub" }),
            ],
          },
        ],
      })),
  },
}));
vi.mock("@/lib/server-cache", () => ({
  cachedJellyfinMoviesAdmin: async () => [],
  cachedJellyfinSeriesAdmin: async () => [{ Id: SERIES, Name: "Show" }],
}));
vi.mock("@/lib/subtitleGen/direct", () => ({ generatedForDirect: () => ({ ours: new Set<number>(), fallbacks: [] }) }));

function proxyReq(method: string, pathname: string): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method, headers: new Headers(), cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}
function routeReq(path: string, body?: unknown): NextRequest {
  return { cookies: { get: () => ({ value: "t" }) }, nextUrl: new URL(`https://cine.example${path}`), json: async () => body } as unknown as NextRequest;
}

const admin = () => mockVerify.mockResolvedValue({ u: "louis", role: "admin" });

beforeEach(async () => {
  vi.clearAllMocks();
  svc.orders = [];
  svc.results = [];
  svc.resultCalls = 0;
  svc.etag = "v1";
  svc.configured = true;
  const { getDb } = await import("@/lib/db");
  getDb().prepare("DELETE FROM subtitle_sync").run();
  getDb().prepare("DELETE FROM subtitle_sync_jobs").run();
});

const measured = (itemId: string, resultEtag = "v1") => ({
  itemId,
  etag: resultEtag,
  resultEtag,
  status: "done",
  version: 1,
  speechSource: "parole-seule",
  tracks: [
    {
      trackKey: "emb:3", kind: "embedded", streamIndex: 3, path: null, codec: "subrip", language: "eng", title: null, forced: false, hi: false,
      offset: 2.5, scale: 1, scaleLabel: "1", z: 8, madMs: 20, windows: 12, inliers: 1, cover: 0.8, maxErrorS: 2.5, reliable: true, confidence: "high", verdict: "décalé",
    },
    {
      trackKey: `ext:/media/tv/Show/${itemId}.fr.srt`, kind: "external", streamIndex: null, path: `/media/tv/Show/${itemId}.fr.srt`, codec: "srt", language: "fre", title: null, forced: false, hi: false,
      size: 100, mtime: 5, offset: 0.05, scale: 1, scaleLabel: "1", z: 9, madMs: 10, windows: 12, inliers: 1, cover: 0.8, maxErrorS: 0.05, reliable: true, confidence: "high", verdict: "ok",
    },
  ],
});

describe("les portes", () => {
  it("le proxy refuse la lecture et les gestes à un compte ordinaire", async () => {
    const { proxy } = await import("@/proxy");
    mockVerify.mockResolvedValue({ u: "compte", role: "user" });
    for (const [m, p] of [["GET", "/api/admin/subsync"], ["POST", "/api/admin/subsync/scan"], ["POST", "/api/admin/subsync/decide"]] as const) {
      expect((await proxy(proxyReq(m, p))).status, `${m} ${p}`).toBe(403);
    }
    const { isAdminOnlyPage } = await import("@/proxy");
    expect(isAdminOnlyPage("/parametres/synchro-sous-titres")).toBe(true);
  });

  it("les routes refusent tout compte qui n'est pas administrateur", async () => {
    mockVerify.mockResolvedValue({ u: "compte", role: "user" });
    const tree = await import("@/app/api/admin/subsync/route");
    const scan = await import("@/app/api/admin/subsync/scan/route");
    const decide = await import("@/app/api/admin/subsync/decide/route");
    expect((await tree.GET(routeReq("/api/admin/subsync"))).status).toBe(403);
    expect((await scan.POST(routeReq("/api/admin/subsync/scan", { scope: "item", itemId: EP1 }))).status).toBe(403);
    expect((await decide.POST(routeReq("/api/admin/subsync/decide", { scope: "item", itemId: EP1, action: "apply" }))).status).toBe(403);
    expect(svc.orders).toHaveLength(0);
  });

  it("une portée ou une action mal formée est refusée avant tout appel ; le service coupé répond 409", async () => {
    admin();
    const scan = await import("@/app/api/admin/subsync/scan/route");
    const decide = await import("@/app/api/admin/subsync/decide/route");
    const tree = await import("@/app/api/admin/subsync/route");
    expect((await scan.POST(routeReq("/x", { scope: "item", itemId: "../x" }))).status).toBe(400);
    expect((await scan.POST(routeReq("/x", { scope: "track", itemId: EP1, trackKey: "emb:3" }))).status).toBe(400);
    expect((await decide.POST(routeReq("/x", { scope: "item", itemId: EP1, action: "delete" }))).status).toBe(400);
    expect((await tree.GET(routeReq("/api/admin/subsync?series=nope"))).status).toBe(400);
    svc.configured = false;
    expect((await scan.POST(routeReq("/x", { scope: "item", itemId: EP1 }))).status).toBe(409);
    const off = await (await tree.GET(routeReq("/api/admin/subsync"))).json();
    expect(off.configured).toBe(false);
    expect(svc.orders).toHaveLength(0);
  });
});

describe("scanner, relire, recaler", () => {
  it("une série : une mesure par épisode, les fichiers texte à côté seulement, puis les résultats", async () => {
    admin();
    const scan = await import("@/app/api/admin/subsync/scan/route");
    const tree = await import("@/app/api/admin/subsync/route");
    // Rien n'est demandé au service tant qu'aucune mesure n'attend.
    await (await tree.GET(routeReq("/api/admin/subsync?filter=all"))).json();
    expect(svc.resultCalls).toBe(0);

    const res = await scan.POST(routeReq("/x", { scope: "series", seriesId: SERIES }));
    expect(await res.json()).toMatchObject({ queued: 2, failed: 0 });
    expect(svc.orders.map((o) => o.itemId)).toEqual([EP1, EP2]);
    expect(svc.orders[0]).toMatchObject({
      path: `/media/tv/Show/${EP1}.mkv`,
      etag: "v1",
      priority: "low",
      externals: [{ path: `/media/tv/Show/${EP1}.fr.srt`, language: "fre", title: null, forced: false, hi: false }],
    });
    expect(mockTaskLog).toHaveBeenCalledWith("synchro des sous-titres", expect.stringContaining("2 éléments"), expect.anything());

    // En attente : l'arbre le dit, et relit le service.
    svc.results = [{ itemId: EP1, etag: "v1", status: "queued", tracks: [] }, measured(EP2)];
    let body = await (await tree.GET(routeReq("/api/admin/subsync?filter=affected"))).json();
    expect(svc.resultCalls).toBe(1);
    expect(body.pending).toBe(1);
    expect(body.series[0]).toMatchObject({ seriesId: SERIES, title: "Show" });
    expect(body.series[0].counts).toMatchObject({ measured: 1, affected: 1, pending: 1 });

    // Une mesure d'un autre fichier n'est pas retenue.
    svc.results = [measured(EP1, "v0")];
    // Les relectures sont espacées de quatre secondes au moins : l'horloge avance d'autant.
    const later = Date.now() + 5000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    body = await (await tree.GET(routeReq("/api/admin/subsync?filter=measured"))).json();
    clock.mockRestore();
    expect(body.pending).toBe(0);
    const series = await (await tree.GET(routeReq(`/api/admin/subsync?filter=all&series=${SERIES}`))).json();
    expect(series.seasons.map((s: { season: number }) => s.season)).toEqual([1, 2]);
    const ep1 = series.seasons[0].episodes[0];
    expect(ep1.job).toMatchObject({ state: "failed" });
    const ep2 = series.seasons[1].episodes[0];
    expect(ep2.tracks.map((t: { verdict: string; stale: boolean }) => [t.verdict, t.stale])).toEqual([["décalé", false], ["ok", false]]);
    expect(mockTaskLog).toHaveBeenCalledWith("synchro des sous-titres", expect.stringContaining("passe terminée"), expect.objectContaining({ "décalés": 1 }));
  });

  it("« Recaler » une saison applique la mesure fiable, jamais une mesure périmée", async () => {
    admin();
    const { recordMeasurement } = await import("@/lib/subtitleSync/store");
    const meta = { itemKind: "Episode" as const, itemTitle: "Show S02E01", seriesId: SERIES, seriesTitle: "Show", season: 2, episode: 1 };
    recordMeasurement(EP2, "v1", meta, "voix", 1, measured(EP2).tracks as never);
    const decide = await import("@/app/api/admin/subsync/decide/route");
    // Le fichier a changé depuis la mesure : rien n'est recalé.
    svc.etag = "v2";
    let res = await (await decide.POST(routeReq("/x", { scope: "season", seriesId: SERIES, season: 2, action: "apply" }))).json();
    expect(res.changed).toBe(0);
    svc.etag = "v1";
    res = await (await decide.POST(routeReq("/x", { scope: "season", seriesId: SERIES, season: 2, action: "apply" }))).json();
    expect(res.changed).toBe(1);
    const { appliedFor } = await import("@/lib/subtitleSync/store");
    expect([...appliedFor(EP2, "v1").keys()]).toEqual(["emb:3"]);
    // Une piste seule, même « ok », se recale à la main.
    res = await (await decide.POST(routeReq("/x", { scope: "track", itemId: EP2, trackKey: `ext:/media/tv/Show/${EP2}.fr.srt`, action: "apply" }))).json();
    expect(res.changed).toBe(1);
    res = await (await decide.POST(routeReq("/x", { scope: "series", seriesId: SERIES, action: "reset" }))).json();
    expect(res.changed).toBe(2);
    expect(appliedFor(EP2, "v1").size).toBe(0);
  });
});

describe("la route des sous-titres", () => {
  it("réécrit le WebVTT d'une piste recalée seulement quand l'adresse porte `&sync=`", async () => {
    vi.resetModules();
    vi.doMock("@/lib/config", () => ({ config: { player: { enabled: true }, jellyfin: { url: "http://jf", apiKey: "k" } } }));
    vi.doMock("@/lib/itemVisibility", () => ({ assertVisible: async () => null }));
    vi.doMock("@/lib/jellyfinBreaker", () => ({
      passJellyfinFetch: async () => new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nBonjour\n", { status: 200 }),
    }));
    vi.doMock("@/lib/subtitleSync/serve", () => ({ syncForSubtitleStream: async () => ({ offset: 2, scale: 1 }) }));
    mockVerify.mockResolvedValue({ u: "louis", role: "user", jfId: "f".repeat(32) });
    const { GET } = await import("@/app/api/jellyfin/stream/subtitle/[itemId]/route");
    const req = (q: string) =>
      ({ cookies: { get: () => ({ value: "t" }) }, nextUrl: new URL(`https://cine.example/api/jellyfin/stream/subtitle/${EP1}?mediaSourceId=${EP1}&index=3${q}`), signal: new AbortController().signal, headers: new Headers() }) as unknown as NextRequest;
    const params = { params: Promise.resolve({ itemId: EP1 }) };
    const plain = await (await GET(req(""), params)).text();
    expect(plain).toContain("00:00:01.000 --> 00:00:02.000");
    const synced = await (await GET(req("&sync=123"), params)).text();
    expect(synced).toContain("00:00:03.000 --> 00:00:04.000");
    vi.doUnmock("@/lib/config");
    vi.doUnmock("@/lib/itemVisibility");
    vi.doUnmock("@/lib/jellyfinBreaker");
    vi.doUnmock("@/lib/subtitleSync/serve");
  });
});
