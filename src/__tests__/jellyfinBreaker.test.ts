// Le coupe-circuit de Jellyfin (DECISIONS.md §92) : une panne ne se paie qu'une fois par 30 s, un
// film en cours n'est jamais retenu, et une réponse — même un refus — referme.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({
  config: { jellyfin: { url: "http://jellyfin.test:8096", apiKey: "k" } },
}));

import {
  OPEN_MS,
  asJellyfinWitness,
  jellyfinDownSince,
  jellyfinFetch,
  jellyfinIsDown,
  passJellyfinFetch,
  throughJellyfinBreaker,
} from "@/lib/jellyfinBreaker";
import { HttpError, UpstreamUnreachableError, UPSTREAM_UNREACHABLE } from "@/lib/http";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-14T20:00:00Z"));
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const dnsFailure = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });

describe("jellyfinBreaker", () => {
  it("après un échec de transport, les appels suivants échouent tout de suite, nommés, sans partir", async () => {
    fetchMock.mockRejectedValue(dnsFailure());
    await expect(jellyfinFetch("http://jellyfin.test:8096/Items")).rejects.toThrow("fetch failed");
    expect(jellyfinIsDown()).toBe(true);
    expect(jellyfinDownSince()).toBe(Date.now());

    const fast = jellyfinFetch("http://jellyfin.test:8096/Items");
    await expect(fast).rejects.toBeInstanceOf(UpstreamUnreachableError);
    await expect(fast).rejects.toMatchObject({ code: UPSTREAM_UNREACHABLE, host: "jellyfin.test:8096" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passé 30 s, une sonde part en arrière-plan — l'appel du spectateur échoue vite quand même — et sa réponse referme", async () => {
    fetchMock.mockRejectedValueOnce(dnsFailure());
    await expect(jellyfinFetch("http://jellyfin.test:8096/a")).rejects.toThrow();
    vi.advanceTimersByTime(OPEN_MS + 1);

    let answer!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    await expect(jellyfinFetch("http://jellyfin.test:8096/b")).rejects.toBeInstanceOf(UpstreamUnreachableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("http://jellyfin.test:8096/System/Info/Public");
    // Une seule sonde à la fois : les appels suivants ne la relancent pas.
    await expect(jellyfinFetch("http://jellyfin.test:8096/c")).rejects.toBeInstanceOf(UpstreamUnreachableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    answer(new Response("{}", { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(jellyfinIsDown()).toBe(false);
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await jellyfinFetch("http://jellyfin.test:8096/d");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("une sonde qui échoue rouvre pour 30 s de plus, sans changer le début de la panne", async () => {
    fetchMock.mockRejectedValue(dnsFailure());
    await expect(jellyfinFetch("http://jellyfin.test:8096/a")).rejects.toThrow();
    const since = jellyfinDownSince();
    vi.advanceTimersByTime(OPEN_MS + 1);
    await expect(jellyfinFetch("http://jellyfin.test:8096/b")).rejects.toBeInstanceOf(UpstreamUnreachableError);
    await vi.advanceTimersByTimeAsync(0);
    expect(jellyfinDownSince()).toBe(since);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Rouvert : pas de nouvelle sonde avant 30 s.
    vi.advanceTimersByTime(OPEN_MS - 1000);
    await expect(jellyfinFetch("http://jellyfin.test:8096/c")).rejects.toBeInstanceOf(UpstreamUnreachableError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("un refus HTTP prouve que Jellyfin répond : il referme", async () => {
    await expect(throughJellyfinBreaker(() => Promise.reject(dnsFailure()))).rejects.toThrow();
    expect(jellyfinIsDown()).toBe(true);
    // La sonde d'arrière-plan reçoit un 503 : Jellyfin démarre, mais il répond.
    vi.advanceTimersByTime(OPEN_MS + 1);
    fetchMock.mockResolvedValueOnce(new Response("starting", { status: 503 }));
    await expect(jellyfinFetch("http://jellyfin.test:8096/b")).rejects.toBeInstanceOf(UpstreamUnreachableError);
    await vi.advanceTimersByTimeAsync(0);
    expect(jellyfinIsDown()).toBe(false);
    // Un HttpError d'un appel ordinaire referme aussi.
    await expect(throughJellyfinBreaker(() => Promise.reject(new HttpError("500", 500)))).rejects.toBeInstanceOf(HttpError);
    expect(jellyfinIsDown()).toBe(false);
  });

  it("un film en cours n'est jamais retenu, et ses octets referment le disjoncteur", async () => {
    fetchMock.mockRejectedValueOnce(dnsFailure());
    await expect(jellyfinFetch("http://jellyfin.test:8096/a")).rejects.toThrow();
    expect(jellyfinIsDown()).toBe(true);

    fetchMock.mockResolvedValueOnce(new Response("octets", { status: 206 }));
    const res = await passJellyfinFetch("http://jellyfin.test:8096/Videos/x/stream");
    expect(res.status).toBe(206);
    expect(jellyfinIsDown()).toBe(false);
  });

  it("une annulation de l'appelant n'est pas une panne", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    await expect(jellyfinFetch("http://jellyfin.test:8096/a")).rejects.toThrow();
    expect(jellyfinIsDown()).toBe(false);
  });

  it("un délai dépassé seul n'ouvre pas — il en faut deux de suite, sans réponse entre les deux", async () => {
    const timeout = () => new DOMException("timeout", "TimeoutError");
    fetchMock.mockRejectedValueOnce(timeout());
    await expect(jellyfinFetch("http://jellyfin.test:8096/a")).rejects.toThrow();
    expect(jellyfinIsDown()).toBe(false);
    fetchMock.mockRejectedValueOnce(timeout());
    await expect(jellyfinFetch("http://jellyfin.test:8096/b")).rejects.toThrow();
    expect(jellyfinIsDown()).toBe(true);
  });

  it("une réponse entre deux délais dépassés efface le premier", async () => {
    const timeout = () => new DOMException("timeout", "TimeoutError");
    fetchMock.mockRejectedValueOnce(timeout());
    await expect(jellyfinFetch("http://jellyfin.test:8096/a")).rejects.toThrow();
    fetchMock.mockResolvedValueOnce(new Response("ok"));
    await jellyfinFetch("http://jellyfin.test:8096/b");
    fetchMock.mockRejectedValueOnce(timeout());
    await expect(jellyfinFetch("http://jellyfin.test:8096/c")).rejects.toThrow();
    expect(jellyfinIsDown()).toBe(false);
  });

  it("deux délais dépassés à plus d'une minute d'écart n'ouvrent pas", async () => {
    const timeout = () => new DOMException("timeout", "TimeoutError");
    fetchMock.mockRejectedValueOnce(timeout());
    await expect(jellyfinFetch("http://jellyfin.test:8096/a")).rejects.toThrow();
    vi.advanceTimersByTime(61_000);
    fetchMock.mockRejectedValueOnce(timeout());
    await expect(jellyfinFetch("http://jellyfin.test:8096/b")).rejects.toThrow();
    expect(jellyfinIsDown()).toBe(false);
  });

  it("deux délais dépassés d'un même lot (partis ensemble) ne comptent qu'une fois", async () => {
    // Relecture du 14/10/2026 : le contrôle de la bibliothèque lançait quatre appels lourds ensemble.
    const pending: ((err: unknown) => void)[] = [];
    fetchMock.mockImplementation(() => new Promise((_, reject) => pending.push(reject)));
    const a = jellyfinFetch("http://jellyfin.test:8096/a").catch(() => undefined);
    const b = jellyfinFetch("http://jellyfin.test:8096/b").catch(() => undefined);
    vi.advanceTimersByTime(8_000);
    pending[0](new DOMException("timeout", "TimeoutError"));
    await a;
    vi.advanceTimersByTime(5);
    pending[1](new DOMException("timeout", "TimeoutError"));
    await b;
    expect(jellyfinIsDown()).toBe(false);
    // Un appel parti après le premier échec, lui, est un second témoignage.
    fetchMock.mockReset();
    fetchMock.mockRejectedValueOnce(new DOMException("timeout", "TimeoutError"));
    await expect(jellyfinFetch("http://jellyfin.test:8096/c")).rejects.toThrow();
    expect(jellyfinIsDown()).toBe(true);
  });

  it("un appel de fond en témoin ne compte pas ses délais dépassés, mais une réponse referme", async () => {
    const timeout = () => new DOMException("timeout", "TimeoutError");
    fetchMock.mockRejectedValue(timeout());
    await asJellyfinWitness(async () => {
      await expect(jellyfinFetch("http://jellyfin.test:8096/a")).rejects.toThrow();
      await expect(jellyfinFetch("http://jellyfin.test:8096/b")).rejects.toThrow();
      await expect(jellyfinFetch("http://jellyfin.test:8096/c")).rejects.toThrow();
    });
    expect(jellyfinIsDown()).toBe(false);
    // Hors témoin, le premier délai dépassé ne fait toujours qu'un premier avertissement.
    await expect(jellyfinFetch("http://jellyfin.test:8096/d")).rejects.toThrow();
    expect(jellyfinIsDown()).toBe(false);
  });

  it("un échec certain en témoin ouvre quand même", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }));
    await asJellyfinWitness(async () => {
      await expect(jellyfinFetch("http://jellyfin.test:8096/a")).rejects.toThrow();
    });
    expect(jellyfinIsDown()).toBe(true);
  });

  it("une connexion refusée est certaine : elle ouvre tout de suite", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    await expect(jellyfinFetch("http://jellyfin.test:8096/a")).rejects.toThrow();
    expect(jellyfinIsDown()).toBe(true);
  });
});

describe("le client Jellyfin derrière le coupe-circuit", () => {
  it("un appel du catalogue n'attend plus pendant la panne, un rapport de lecture part quand même", async () => {
    const { jellyfin } = await import("@/lib/clients/jellyfin");
    fetchMock.mockRejectedValue(dnsFailure());
    await expect(jellyfin.getSystemInfo()).rejects.toBeInstanceOf(UpstreamUnreachableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(jellyfin.getSessions()).rejects.toBeInstanceOf(UpstreamUnreachableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Le rapport de progression d'un film part, lui — et sa réponse rouvre l'accès à tout le reste.
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await jellyfin.reportPlaybackProgress("u", "i", "tok", "ps", "ms", 10, "DirectPlay");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jellyfinIsDown()).toBe(false);
  });

  it("la négociation de lecture et la description du lecteur passent outre : un film en cours n'est pas retenu", async () => {
    const { jellyfin } = await import("@/lib/clients/jellyfin");
    const U = "a".repeat(32);
    const I = "b".repeat(32);
    // Ouvert par un échec certain.
    fetchMock.mockRejectedValueOnce(dnsFailure());
    await expect(jellyfin.getSystemInfo()).rejects.toBeInstanceOf(UpstreamUnreachableError);
    expect(jellyfinIsDown()).toBe(true);
    fetchMock.mockReset();
    // La description ordinaire reste retenue…
    await expect(jellyfin.getItemMediaSources(U, I)).rejects.toBeInstanceOf(UpstreamUnreachableError);
    expect(fetchMock).toHaveBeenCalledTimes(0);
    // … celle du lecteur part, et sa réponse referme.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ MediaSources: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    await jellyfin.getItemMediaSources(U, I, { pass: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jellyfinIsDown()).toBe(false);
    // Rouvert : une renégociation (piste, échelle, relais) part quand même.
    fetchMock.mockRejectedValueOnce(dnsFailure());
    await expect(jellyfin.getSystemInfo()).rejects.toThrow();
    expect(jellyfinIsDown()).toBe(true);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ MediaSources: [{ Id: I }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const info = await jellyfin.getPlaybackInfo(U, I, "tok", { maxBitrate: 1, deviceProfile: {} as never });
    expect(info.MediaSources?.[0]?.Id).toBe(I);
    expect(jellyfinIsDown()).toBe(false);
  });
});
