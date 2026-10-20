import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
// Le droit du compte sur le titre a ses propres tests (`item-visibility.test.ts`) ; ici, accordé.
vi.mock("@/lib/itemVisibility", () => ({ assertVisible: async () => null }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (..._args: unknown[]) => mockVerifySessionFull(..._args) }));
vi.mock("@/lib/config", () => ({
  config: { player: { enabled: true }, jellyfin: { url: "http://jf.test", apiKey: "key" } },
}));

// Les lignes de `server.log` (paramètres écartés, refus de transcodage), observées sans écrire.
const mockLogError = vi.fn();
vi.mock("@/lib/logger", () => ({ logError: (...args: unknown[]) => mockLogError(...args) }));
// Le compte des lectures d'un lien de partage a ses propres tests ; ici, sa réponse est choisie.
const mockShareStreamRefusal = vi.fn((..._args: unknown[]): Response | null => null);
vi.mock("@/lib/share/guard", () => ({ shareStreamRefusal: (...args: unknown[]) => mockShareStreamRefusal(...args) }));

const mockFetch = vi.fn();
const validId = "b".repeat(32);

function fakeReq(url = `http://app/api/jellyfin/stream/${validId}/hls1/main/0.mp4`): NextRequest {
  const parsed = new URL(url);
  return {
    cookies: { get: (name: string) => (name === "cine_session" ? { value: "t" } : undefined) },
    headers: { get: () => null },
    nextUrl: { search: parsed.search, searchParams: parsed.searchParams },
    signal: new AbortController().signal,
  } as unknown as NextRequest;
}

function upstream(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: new ReadableStream({ start: (c) => c.close() }),
    headers: { get: () => null },
    text: async () => "",
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mockFetch);
  mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1" });
  // Le compte des transcodages et la mémoire des noms écartés vivent sur `globalThis` : remis à zéro.
  (await import("@/lib/transcodeBudget")).resetTranscodeBudget();
  (await import("@/lib/streamQuery")).resetDroppedStreamParamLog();
});

async function get(path: string[] = ["hls1", "main", "0.mp4"]) {
  const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
  return GET(fakeReq(), { params: Promise.resolve({ itemId: validId, path }) });
}

describe("GET /api/jellyfin/stream/[itemId]/[...path]", () => {
  it("passes a successful segment straight through", async () => {
    mockFetch.mockResolvedValue(upstream(200));
    const res = await get();
    expect(res.status).toBe(200);
    // Servi à une session seulement : aucun cache partagé ne doit le garder (25/09/2026).
    expect(res.headers.get("Cache-Control")).toMatch(/^private,/);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("le fichier lu par plages n'est gardé par aucun cache, pas même celui du navigateur", async () => {
    // 28/09/2026 : chaque plage aurait pu finir dans le cache disque du navigateur — la taille de ce
    // qu'on regarde, en écritures sur la mémoire flash, pour rien.
    mockFetch.mockResolvedValue(upstream(206));
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const res = await GET(fakeReq(`http://app/api/jellyfin/stream/${validId}/stream.mkv?static=true&mediaSourceId=${validId}`), {
      params: Promise.resolve({ itemId: validId, path: ["stream.mkv"] }),
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  // The race this retry exists for: right after a fresh transcode starts, the very first segment
  // can beat ffmpeg's own disk writes and come back 500. Safari gives up on one such failure.
  it("retries a transient 5xx from Jellyfin", async () => {
    mockFetch.mockResolvedValueOnce(upstream(500)).mockResolvedValueOnce(upstream(200));
    const res = await get();
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // A 4xx is a definite answer — a segment past the end of a finished transcode after a seek, a
  // stale session. Retrying it used to cost 1.7s of sleeps before telling the browser.
  it("does not retry a 4xx", async () => {
    mockFetch.mockResolvedValue(upstream(404));
    const res = await get();
    expect(res.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("gives up after exhausting the retry budget on a persistent 5xx", async () => {
    mockFetch.mockResolvedValue(upstream(503));
    const res = await get();
    expect(res.status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  // Chasse aux bugs du 22/09/2026 : le délai de 30 s couvrait le corps entier. Un segment du
  // lecteur serveur, ou une plage lue lentement par un téléphone en itinérance, était coupé net au
  // milieu du transfert — seule l'attente de la réponse de Jellyfin doit être bornée.
  describe("délai d'attente de Jellyfin", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      // Le vrai `AbortSignal.timeout` échappe aux horloges simulées : on le rend observable.
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
        const c = new AbortController();
        setTimeout(() => c.abort(new DOMException("timeout", "TimeoutError")), ms);
        return c.signal;
      });
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
    });

    it("ne coupe plus le corps une fois la réponse arrivée", async () => {
      let signal: AbortSignal | undefined;
      mockFetch.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
        signal = init.signal;
        return upstream(200);
      });
      const res = await get();
      expect(res.status).toBe(200);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(signal?.aborted).toBe(false);
    });

    it("abandonne toujours un Jellyfin muet au bout de 30 s", async () => {
      let signal: AbortSignal | undefined;
      mockFetch.mockImplementation(
        (_url: string, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal = init.signal;
            init.signal.addEventListener("abort", () => reject(init.signal.reason));
          })
      );
      const pending = get();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(signal?.aborted).toBe(true);
      await pending.catch(() => undefined);
    });
  });

  it("refuses a malformed item id and an unauthenticated caller", async () => {
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    const bad = await GET(fakeReq(), { params: Promise.resolve({ itemId: "nope", path: ["x"] }) });
    expect(bad.status).toBe(400);

    mockVerifySessionFull.mockResolvedValue(null);
    const anon = await get();
    expect(anon.status).toBe(403);
  });
});

// F-004 rejoué de bout en bout. Le chemin attrape-tout partait tel quel dans l'URL amont, signée
// avec la clé d'administration : `fetch` résolvait les `..` et `/videos/{id}/../../X` devenait
// `/X`. Chacun des ~19 comptes du foyer avait ainsi un GET arbitraire sur l'API Jellyfin avec les
// droits de l'administrateur. La cible ici est volontairement bénigne (`/System/Info/Public`) —
// la chaîne est la même que celle qui atteignait `/Users`, on ne l'écrit simplement pas.
describe("traversée de chemin sur /api/jellyfin/stream/[itemId]/[...path]", () => {
  const adminTarget = "http://jf.test/System/Info/Public";

  // Les deux formes que peut prendre la traversée, selon le moment où Next décode le `%2F` :
  // segments séparés si le décodage précède le découpage, un seul segment porteur de `/` sinon.
  // `path.join("/")` les ramène toutes deux à la même URL, donc les deux sont refusées.
  const shapes: Array<[string, string[]]> = [
    ["segments `..` séparés", ["..", "..", "System", "Info", "Public"]],
    ["un segment portant des `/` décodés", ["../../System/Info/Public"]],
    ["une traversée glissée en fin de chemin", ["hls1", "main", "..", "..", "..", "System"]],
  ];

  for (const [label, path] of shapes) {
    it(`refuse ${label} en 400, sans rien envoyer à Jellyfin`, async () => {
      const res = await get(path);
      expect(res.status).toBe(400);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  }

  // Le test ci-dessus échouerait aussi si la route refusait tout : cette assertion-là dit que
  // l'URL refusée était bien celle qui sortait du dossier, et non un faux positif.
  it("la chaîne refusée atteignait bien un point d'administration", () => {
    const naive = `http://jf.test/videos/${validId}/${["..", "..", "System", "Info", "Public"].join("/")}`;
    expect(new URL(naive).href).toBe(adminTarget);
  });

  it("laisse passer les formes légitimes", async () => {
    for (const path of [["master.m3u8"], ["main.m3u8"], ["hls1", "main", "0.mp4"], ["stream.mkv"]]) {
      mockFetch.mockResolvedValue(upstream(200));
      expect((await get(path)).status).toBe(200);
    }
  });
});

/**
 * Le jeton que Jellyfin écrit dans ses adresses (`ApiKey=`) ne traverse plus le relais.
 *
 * 25/09/2026 : `master.m3u8?…&ApiKey=…` dans le journal du relais inverse — le jeton de la
 * personne, recopié par Jellyfin dans chaque variante et chaque segment. Le relais s'authentifie
 * par l'en-tête, que Jellyfin lit avant la requête : le paramètre ne servait à rien.
 */
describe("GET /api/jellyfin/stream — jeton dans l'adresse", () => {
  async function getUrl(url: string, path: string[]) {
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    return GET(fakeReq(url), { params: Promise.resolve({ itemId: validId, path }) });
  }

  it("ne transmet pas l'ApiKey de la requête à Jellyfin, et s'authentifie par l'en-tête", async () => {
    mockFetch.mockResolvedValue(upstream(200));
    await getUrl(`http://app/api/jellyfin/stream/${validId}/hls1/main/0.mp4?PlaySessionId=p&ApiKey=jeton&runtimeTicks=0`, ["hls1", "main", "0.mp4"]);
    const [target, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(target).toBe(`http://jf.test/videos/${validId}/hls1/main/0.mp4?PlaySessionId=p&runtimeTicks=0`);
    expect((init.headers as Record<string, string>).Authorization).toBe('MediaBrowser Token="key"');
  });

  it("retire les jetons des adresses d'un manifeste, sous-titres compris", async () => {
    const manifest = [
      "#EXTM3U",
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="src/Subtitles/3/subtitles.m3u8?SegmentLength=30&api_key=cle"`,
      "#EXT-X-STREAM-INF:BANDWIDTH=1",
      "main.m3u8?DeviceId=d&ApiKey=jeton&PlaySessionId=p",
      "hls1/main/0.mp4?ApiKey=jeton",
      "",
    ].join("\n");
    mockFetch.mockResolvedValue({ ...upstream(200), text: async () => manifest });
    const res = await getUrl(`http://app/api/jellyfin/stream/${validId}/master.m3u8?ApiKey=jeton`, ["master.m3u8"]);
    const text = await res.text();
    expect(text).not.toMatch(/api_?key/i);
    expect(text).toContain("main.m3u8?DeviceId=d&PlaySessionId=p");
    expect(text).toContain('URI="src/Subtitles/3/subtitles.m3u8?SegmentLength=30"');
    expect(text).toContain("\nhls1/main/0.mp4\n");
  });

  // 20/10/2026, revue de sécurité : `SUBTITLES.M3U8` (Jellyfin ignore la casse) passait par la branche
  // des segments, tel quel, avec la clé d'administration écrite dans chaque adresse.
  it("une liste en majuscules est traitée comme une liste : sans jeton", async () => {
    const playlist = ["#EXTM3U", "stream.vtt?CopyTimestamps=true&ApiKey=key", "stream.vtt?x=1&api_key=key", ""].join("\n");
    mockFetch.mockResolvedValue({ ...upstream(200), text: async () => playlist });
    const res = await getUrl(`http://app/api/jellyfin/stream/${validId}/${validId}/Subtitles/3/SUBTITLES.M3U8?SegmentLength=30`, [validId, "Subtitles", "3", "SUBTITLES.M3U8"]);
    const text = await res.text();
    expect(text).not.toMatch(/api_?key/i);
    expect(text).not.toContain("key\n");
  });

  it("un texte venu de Jellyfin hors des listes ne repart jamais avec la clé, même en « static »", async () => {
    const body = "erreur : http://jf/videos/x?api_key=key&a=1 et Token=key";
    mockFetch.mockResolvedValue({ ...upstream(200), headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? "text/plain" : null) }, text: async () => body });
    const res = await getUrl(`http://app/api/jellyfin/stream/${validId}/stream.txt?static=true`, ["stream.txt"]);
    const text = await res.text();
    expect(text).not.toContain("key");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});

/**
 * Revue de sécurité du 20/10/2026 : le relais recopiait toute chaîne de requête vers Jellyfin, sous la
 * clé d'administration. Un compte pouvait y écrire ses propres débit et définition, et lancer un
 * ffmpeg par `PlaySessionId` inventé, sans borne.
 */
describe("GET /api/jellyfin/stream — paramètres permis et transcodages par compte", () => {
  async function getUrl(url: string, path: string[]) {
    const { GET } = await import("@/app/api/jellyfin/stream/[itemId]/[...path]/route");
    return GET(fakeReq(url), { params: Promise.resolve({ itemId: validId, path }) });
  }
  const master = (ps: string, extra = "") =>
    getUrl(`http://app/api/jellyfin/stream/${validId}/master.m3u8?PlaySessionId=${ps}&MediaSourceId=${validId}${extra}`, ["master.m3u8"]);

  it("transmet tels quels les paramètres qu'écrit Jellyfin, options de codec comprises, sans la casse", async () => {
    mockFetch.mockResolvedValue(upstream(200));
    const query = [
      "DeviceId=d", `MediaSourceId=${validId}`, "VideoCodec=hevc,h264", "AudioCodec=aac", "AudioStreamIndex=1", "VideoBitrate=139616000",
      "AudioBitrate=384000", "MaxWidth=3840", "MaxHeight=2160", "MaxFramerate=23.976", "PlaySessionId=p", "SegmentContainer=mp4",
      "MinSegments=1", "BreakOnNonKeyFrames=True", "TranscodingMaxAudioChannels=6", "RequireAvc=false", "Tag=abc",
      "h264-profile=high,main", "hevc-level=153", "hevc-rangetype=SDR,HDR10", "av1-videobitdepth=10", "aac-audiochannels=6",
      "TranscodeReasons=AudioCodecNotSupported", "segmentlength=6", "EnableAudioVbrEncoding=true",
    ].join("&");
    await getUrl(`http://app/api/jellyfin/stream/${validId}/master.m3u8?${query}`, ["master.m3u8"]);
    expect(mockFetch.mock.calls[0][0]).toBe(`http://jf.test/videos/${validId}/master.m3u8?${query}`);
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("écarte un paramètre inconnu, sans refuser la requête, et le nomme une seule fois au journal", async () => {
    mockFetch.mockResolvedValue(upstream(200));
    const res = await getUrl(`http://app/api/jellyfin/stream/${validId}/hls1/main/0.mp4?PlaySessionId=p&CpuCoreLimit=64&runtimeTicks=0&UserId=x&Params=a;b`, ["hls1", "main", "0.mp4"]);
    expect(res.status).toBe(200);
    expect(mockFetch.mock.calls[0][0]).toBe(`http://jf.test/videos/${validId}/hls1/main/0.mp4?PlaySessionId=p&runtimeTicks=0`);
    expect(mockLogError.mock.calls.map((c) => c[0])).toEqual(["stream.param-dropped", "stream.param-dropped", "stream.param-dropped"]);
    expect(mockLogError.mock.calls.map((c) => (c[2] as { param: string }).param)).toEqual(["CpuCoreLimit", "UserId", "Params"]);

    await getUrl(`http://app/api/jellyfin/stream/${validId}/hls1/main/1.mp4?PlaySessionId=p&cpucorelimit=64`, ["hls1", "main", "1.mp4"]);
    expect(mockLogError).toHaveBeenCalledTimes(3);
  });

  it("le laissez-passer et les jetons sont retirés comme avant, sans être signalés comme écartés", async () => {
    mockFetch.mockResolvedValue(upstream(200));
    await getUrl(`http://app/api/jellyfin/stream/${validId}/hls1/main/0.mp4?PlaySessionId=p&api_key=k&ApiKey=k`, ["hls1", "main", "0.mp4"]);
    expect(mockFetch.mock.calls[0][0]).toBe(`http://jf.test/videos/${validId}/hls1/main/0.mp4?PlaySessionId=p`);
    expect(mockLogError).not.toHaveBeenCalled();
  });

  it("un nom répété ne garde que son premier exemplaire — celui que Jellyfin lit", async () => {
    mockFetch.mockResolvedValue(upstream(200));
    await getUrl(`http://app/api/jellyfin/stream/${validId}/main.m3u8?PlaySessionId=a&playsessionid=b`, ["main.m3u8"]);
    expect(mockFetch.mock.calls[0][0]).toBe(`http://jf.test/videos/${validId}/main.m3u8?PlaySessionId=a`);
  });

  it("refuse en 429 une sixième séance de transcodage du même compte ; un autre compte n'en est pas touché", async () => {
    mockFetch.mockResolvedValue(upstream(200));
    for (const ps of ["p1", "p2", "p3", "p4", "p5"]) expect((await master(ps)).status).toBe(200);
    const refused = await master("p6");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "transcode-limit" });
    expect(mockFetch).toHaveBeenCalledTimes(5);
    expect(mockLogError.mock.calls.filter((c) => c[0] === "stream.transcode-limit")).toHaveLength(1);

    // Une séance déjà ouverte continue : ses segments et ses variantes passent.
    expect((await getUrl(`http://app/api/jellyfin/stream/${validId}/hls1/main/3.mp4?PlaySessionId=p2&runtimeTicks=0`, ["hls1", "main", "3.mp4"])).status).toBe(200);

    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-2" });
    expect((await master("p6")).status).toBe(200);
  });

  it("une lecture du fichier (`static=true`) n'est jamais un transcodage", async () => {
    mockFetch.mockResolvedValue(upstream(206));
    for (let i = 0; i < 8; i++) {
      const res = await getUrl(`http://app/api/jellyfin/stream/${validId}/stream.mkv?static=true&mediaSourceId=${validId}&PlaySessionId=s${i}`, ["stream.mkv"]);
      expect(res.status).toBe(206);
    }
    const { activeTranscodes } = await import("@/lib/transcodeBudget");
    expect(activeTranscodes("jf-1")).toBe(0);
  });

  it("`static=true` ajouté à une adresse HLS ne la fait pas échapper au compte", async () => {
    mockFetch.mockResolvedValue(upstream(200));
    for (const ps of ["p1", "p2", "p3", "p4", "p5"]) expect((await master(ps, "&static=true")).status).toBe(200);
    expect((await master("p6", "&static=true")).status).toBe(429);
  });

  it("un flux progressif sans `static` compte, lui", async () => {
    mockFetch.mockResolvedValue(upstream(200));
    for (const ps of ["p1", "p2", "p3", "p4", "p5"]) {
      expect((await getUrl(`http://app/api/jellyfin/stream/${validId}/stream.mp4?PlaySessionId=${ps}&VideoCodec=h264`, ["stream.mp4"])).status).toBe(200);
    }
    expect((await getUrl(`http://app/api/jellyfin/stream/${validId}/stream.mp4?PlaySessionId=p6&VideoCodec=h264`, ["stream.mp4"])).status).toBe(429);
  });

  it("les sous-titres ne comptent pas", async () => {
    mockFetch.mockResolvedValue(upstream(200));
    for (const ps of ["p1", "p2", "p3", "p4", "p5"]) await master(ps);
    const res = await getUrl(`http://app/api/jellyfin/stream/${validId}/${validId}/Subtitles/3/subtitles.m3u8?SegmentLength=30&PlaySessionId=autre`, [validId, "Subtitles", "3", "subtitles.m3u8"]);
    expect(res.status).toBe(200);
  });

  it("une séance sans nouvelles depuis trois minutes rend sa place", async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockResolvedValue(upstream(200));
      for (const ps of ["p1", "p2", "p3", "p4", "p5"]) await master(ps);
      expect((await master("p6")).status).toBe(429);
      vi.advanceTimersByTime(3 * 60_000 + 1);
      expect((await master("p6")).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("une séance arrêtée (`forgetTranscode`, appelé par la route d'arrêt) libère sa place tout de suite", async () => {
    mockFetch.mockResolvedValue(upstream(200));
    for (const ps of ["p1", "p2", "p3", "p4", "p5"]) await master(ps);
    expect((await master("p6")).status).toBe(429);
    (await import("@/lib/transcodeBudget")).forgetTranscode("jf-1", "p3");
    expect((await master("p6")).status).toBe(200);
  });

  /**
   * Un lien de partage : trois lectures en même temps (§112), comptées aussi sur le fichier lu par
   * plages — un appareil qui rouvrait l'adresse du fichier ne repassait pas par l'ouverture.
   */
  it("un lien de partage déjà lu sur le maximum d'appareils est refusé sur le fichier lui-même", async () => {
    mockFetch.mockResolvedValue(upstream(206));
    const session = { jfId: "jf-share", role: "share", sh: "s1", jti: "j1" };
    mockVerifySessionFull.mockResolvedValue(session);
    mockShareStreamRefusal.mockReturnValueOnce(new Response(JSON.stringify({ code: "share-streams" }), { status: 429 }));
    const file = `http://app/api/jellyfin/stream/${validId}/stream.mkv?static=true&mediaSourceId=${validId}`;
    expect((await getUrl(file, ["stream.mkv"])).status).toBe(429);
    expect(mockShareStreamRefusal).toHaveBeenCalledWith(session);
    expect(mockFetch).not.toHaveBeenCalled();
    // L'appareil déjà en lecture (refus `null`) passe.
    expect((await getUrl(file, ["stream.mkv"])).status).toBe(206);
  });

  it("le compte des lectures d'un lien ne regarde ni les comptes du foyer, ni les segments HLS", async () => {
    mockFetch.mockResolvedValue(upstream(200));
    await getUrl(`http://app/api/jellyfin/stream/${validId}/stream.mkv?static=true`, ["stream.mkv"]);
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-share", role: "share", sh: "s1", jti: "j1" });
    await master("p1");
    expect(mockShareStreamRefusal).not.toHaveBeenCalled();
  });
});
