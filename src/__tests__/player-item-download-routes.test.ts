import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

/**
 * Les deux routes du 19/10/2026 : ce que le lecteur sait d'un titre (`/api/player/item` — la série
 * d'un épisode, le droit de télécharger) et le téléchargement du fichier (`/api/player/download`).
 * Le droit est vérifié par la route elle-même : cacher la ligne n'est pas interdire.
 */

vi.mock("@/lib/config", () => ({ config: { jellyfin: { url: "http://jf", apiKey: "k" } } }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const verify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => verify(...a) }));
const allowed = vi.fn();
vi.mock("@/lib/transcodePolicy", () => ({ contentDownloadingAllowed: (...a: unknown[]) => allowed(...a) }));
const visible = vi.fn();
vi.mock("@/lib/itemVisibility", () => ({ assertVisible: (...a: unknown[]) => visible(...a) }));
const getItemFile = vi.fn();
const getItemNaming = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { getItemFile: (...a: unknown[]) => getItemFile(...a), getItemNaming: (...a: unknown[]) => getItemNaming(...a) } }));
const upstream = vi.fn();
vi.mock("@/lib/jellyfinBreaker", () => ({ passJellyfinFetch: (...a: unknown[]) => upstream(...a) }));
const logDownload = vi.fn();
vi.mock("@/lib/logger", () => ({ logDownload: (...a: unknown[]) => logDownload(...a) }));
vi.mock("@/lib/repliques/playbackActivity", () => ({ noteMediaRead: () => {} }));

import { GET as itemGET } from "@/app/api/player/item/[itemId]/route";
import { GET as downloadGET } from "@/app/api/player/download/[itemId]/route";

const EP = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SERIES = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const req = (headers: Record<string, string> = {}) =>
  ({ cookies: { get: () => ({ value: "t" }) }, headers: new Headers(headers), signal: new AbortController().signal }) as unknown as NextRequest;
const params = (id: string) => ({ params: Promise.resolve({ itemId: id }) });

beforeEach(() => {
  vi.clearAllMocks();
  verify.mockResolvedValue({ u: "mathis", jfId: "cccccccccccccccccccccccccccccccc", jti: "j", role: "user" });
  visible.mockResolvedValue(null);
  getItemNaming.mockResolvedValue({ Type: "Episode", SeriesName: "Série", ParentIndexNumber: 1, IndexNumber: 2, Name: "Deux" });
});

describe("/api/player/item", () => {
  it("un épisode : sa série ; le droit de télécharger avec la taille", async () => {
    getItemFile.mockResolvedValue({ Type: "Episode", SeriesId: SERIES, MediaSources: [{ Size: 1_100_000_000 }] });
    allowed.mockResolvedValue(true);
    const body = await (await itemGET(req(), params(EP))).json();
    expect(body).toEqual({ seriesId: SERIES, download: { sizeBytes: 1_100_000_000 } });
  });

  it("un film sans le droit : ni série, ni téléchargement", async () => {
    getItemFile.mockResolvedValue({ Type: "Movie", MediaSources: [{ Size: 5 }] });
    allowed.mockResolvedValue(false);
    expect(await (await itemGET(req(), params(EP))).json()).toEqual({ seriesId: null, download: null });
  });

  it("un titre hors des droits du compte : 404 ; sans session : 401", async () => {
    getItemFile.mockResolvedValue(null);
    allowed.mockResolvedValue(true);
    expect((await itemGET(req(), params(EP))).status).toBe(404);
    verify.mockResolvedValue(null);
    expect((await itemGET(req(), params(EP))).status).toBe(401);
  });
});

describe("/api/player/download", () => {
  const file = (status = 200, extra: Record<string, string> = {}) =>
    new Response("octets", {
      status,
      headers: {
        "Content-Type": "video/x-matroska",
        "Content-Length": "1100000000",
        "Content-Disposition": 'attachment; filename="Série - S01E02.mkv"',
        "Accept-Ranges": "bytes",
        ...extra,
      },
    });

  it("refuse sans le droit de Jellyfin, avant de rien demander à Jellyfin", async () => {
    allowed.mockResolvedValue(false);
    const res = await downloadGET(req(), params(EP));
    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(logDownload).not.toHaveBeenCalled();
  });

  it("refuse un titre que le compte ne voit pas", async () => {
    allowed.mockResolvedValue(true);
    visible.mockResolvedValue(new Response(null, { status: 404 }));
    expect((await downloadGET(req(), params(EP))).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("relaie le fichier de Jellyfin avec son nom, et écrit une ligne au journal", async () => {
    allowed.mockResolvedValue(true);
    upstream.mockResolvedValue(file());
    const res = await downloadGET(req(), params(EP));
    expect(res.status).toBe(200);
    expect(upstream.mock.calls[0][0]).toBe(`http://jf/Items/${EP}/Download`);
    expect(res.headers.get("content-disposition")).toContain("S01E02.mkv");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    await vi.waitFor(() => expect(logDownload).toHaveBeenCalledTimes(1));
    expect(logDownload).toHaveBeenCalledWith("mathis", { itemId: EP, title: "Série — S01E02 · Deux", sizeBytes: 1_100_000_000 });
  });

  it("une plage depuis zéro : une ligne, avec la taille du fichier entier", async () => {
    allowed.mockResolvedValue(true);
    upstream.mockResolvedValue(file(206, { "Content-Length": "16", "Content-Range": "bytes 0-15/1100000000" }));
    await downloadGET(req({ range: "bytes=0-15" }), params(EP));
    await vi.waitFor(() => expect(logDownload).toHaveBeenCalledTimes(1));
    expect(logDownload.mock.calls[0][1].sizeBytes).toBe(1_100_000_000);
  });

  it("une reprise : la plage part à Jellyfin, la réponse partielle revient telle quelle, sans seconde ligne", async () => {
    allowed.mockResolvedValue(true);
    upstream.mockResolvedValue(file(206, { "Content-Range": "bytes 500-1099999999/1100000000" }));
    const res = await downloadGET(req({ range: "bytes=500-" }), params(EP));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 500-1099999999/1100000000");
    expect((upstream.mock.calls[0][1] as { headers: Record<string, string> }).headers.Range).toBe("bytes=500-");
    await new Promise((r) => setTimeout(r, 10));
    expect(logDownload).not.toHaveBeenCalled();
  });
});
