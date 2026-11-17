// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Le levier (1) de Lumen serveur dans le cinéma (DECISIONS.md §180) : la fiche ouverte fait préparer le fichier au
 * serveur — borné, sans rafale (pare-feu : `http-crawl-non_statics`), une seule en vol, annulée si la fiche se
 * ferme avant le délai, rien du tout là où Lumen serveur ne lirait pas.
 */
vi.mock("@/lib/playbackPrefetch", () => ({
  peekPrefetchedPlaybackState: () => Promise.resolve({ resumeSeconds: 600, preferences: null }),
}));
vi.mock("@/lib/resumeRewind", () => ({ openingPosition: (_id: string, p: number) => p }));

import {
  LUMEN_PREPARE_DELAY_MS,
  LUMEN_PREPARE_PER_MINUTE,
  forgetLumenPrepares,
  readLumenPrepared,
  scheduleLumenPrepare,
} from "@/lib/lumenSheetPrepare";

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
const yes = { wanted: () => true };

beforeEach(() => {
  vi.useFakeTimers();
  forgetLumenPrepares();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  // Une mesure du lien récente : ces essais-ci ne parlent que de la préparation (la sonde a le sien, plus bas).
  localStorage.setItem("cine:lumen-debit", JSON.stringify({ mbps: 50, at: Date.now() }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const settle = async () => {
  await vi.advanceTimersByTimeAsync(LUMEN_PREPARE_DELAY_MS);
  await vi.advanceTimersByTimeAsync(0);
};

describe("la mesure du lien depuis la fiche (17/11/2026)", () => {
  it("sans mesure récente : un échantillon de 3 Mo après la préparation, retenu pour la lecture ; une seule fois", async () => {
    localStorage.clear();
    // L'horloge de la page avance de 100 ms à chaque lecture : 3 Mo en 100 ms, ~252 Mb/s.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 100));
    fetchMock.mockImplementation(async (url: string) =>
      url.includes("/chrono?") ? new Response(new Uint8Array(3 * 1024 * 1024), { status: 200 }) : new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    scheduleLumenPrepare("abc", yes);
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls[0]).toBe("/api/lumen/abc/prepare");
    expect(urls[1]).toMatch(/^\/api\/lumen\/abc\/chrono\?s=fiche-sonde&bytes=3145728&t=/);
    expect(JSON.parse(localStorage.getItem("cine:lumen-debit") ?? "{}").mbps).toBeGreaterThan(200);
    scheduleLumenPrepare("def", yes);
    await settle();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes("/chrono?"))).toHaveLength(1);
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.restoreAllMocks();
  });
});

describe("la préparation à l'ouverture d'une fiche", () => {
  it("après le délai : un POST prepare, à la position de reprise, et son verdict retenu pour la ligne `start`", async () => {
    scheduleLumenPrepare("abc", yes);
    expect(fetchMock).not.toHaveBeenCalled();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/lumen/abc/prepare");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ position: 600 });
    expect(readLumenPrepared("abc")?.status).toBe("ok");
  });

  it("une fiche fermée avant le délai n'envoie rien", async () => {
    const cancel = scheduleLumenPrepare("abc", yes);
    cancel();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rien là où Lumen serveur ne lirait pas (option coupée, autre navigateur…)", async () => {
    scheduleLumenPrepare("abc", { wanted: () => false });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rouvrir la même fiche dans les deux minutes ne redemande rien", async () => {
    scheduleLumenPrepare("abc", yes);
    await settle();
    scheduleLumenPrepare("abc", yes);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("parcourir trente fiches ne fait pas trente requêtes : un plafond par minute", async () => {
    for (let i = 0; i < 30; i++) {
      scheduleLumenPrepare(`t${i}`, yes);
      await settle();
    }
    expect(fetchMock).toHaveBeenCalledTimes(LUMEN_PREPARE_PER_MINUTE);
  });

  it("une seule en vol : la fiche suivante coupe la précédente", async () => {
    let firstSignal: AbortSignal | undefined;
    fetchMock.mockImplementationOnce((...args) => {
      firstSignal = args[1]?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    scheduleLumenPrepare("a", yes);
    await settle();
    scheduleLumenPrepare("b", yes);
    await settle();
    expect(firstSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
