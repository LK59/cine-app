// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { EARLY_FETCH_MAX_AGE_MS, EARLY_FETCH_URLS, earlyFetchScript, fetchOrEarly, takeEarlyResponse } from "@/lib/earlyFetch";
import { NEXT_UP_KEY, RESUME_KEY, fetcher } from "@/lib/swr";
import { MOVIES_CATALOGUE_KEY } from "@/lib/catalogueKeys";
import { cinemaFetcher } from "@/lib/cinemaPayload";

/**
 * Les requêtes de l'ouverture, parties avec le HTML et reprises par l'écran (15/10/2026) : sur iPhone,
 * sans amorce, le catalogue partait une seconde après le démarrage du code. Une requête par adresse,
 * jamais deux — c'est ce que l'amorce `<link rel="preload">` ratait sur Safari.
 */
const runScript = () => new Function(earlyFetchScript())();

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  delete window.__cineEarly;
  sessionStorage.clear();
  fetchMock = vi.fn((url: string) => Promise.resolve(Response.json({ url, items: [] })));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("le script de l'ouverture", () => {
  it("lance un fetch nu par adresse, et un seul même s'il est relu", () => {
    runScript();
    runScript();
    expect(fetchMock).toHaveBeenCalledTimes(EARLY_FETCH_URLS.length);
    for (const url of EARLY_FETCH_URLS) expect(fetchMock).toHaveBeenCalledWith(url);
    // Nu : un seul argument. Des options donneraient une autre réponse que celle des récupérateurs.
    for (const call of fetchMock.mock.calls) expect(call).toHaveLength(1);
  });

  it("ne demande rien quand la page se recharge pour rouvrir un film", () => {
    sessionStorage.setItem("cine:player-reload-intent", "{}");
    runScript();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.__cineEarly).toBeUndefined();
  });

  it("ne lève jamais, même sans fetch", () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("pas de fetch");
    });
    expect(runScript).not.toThrow();
  });

  it("une requête rejetée sans preneur ne fait pas d'erreur non rattrapée", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("réseau")));
    runScript();
    await new Promise((r) => setTimeout(r, 20));
    process.off("unhandledRejection", unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("couvre exactement les adresses que l'écran demande, et la clé du rechargement", () => {
    expect([...EARLY_FETCH_URLS].sort()).toEqual([MOVIES_CATALOGUE_KEY, RESUME_KEY, NEXT_UP_KEY].sort());
    // La clé est recopiée (composant client) : elle doit rester celle de PlaybackProvider.
    const provider = fs.readFileSync(path.join(process.cwd(), "src/components/PlaybackProvider.tsx"), "utf8");
    expect(provider).toMatch(/export const PLAYER_RELOAD_INTENT_KEY = "cine:player-reload-intent";/);
  });
});

describe("la reprise par le récupérateur", () => {
  it("prend la réponse rangée une seule fois", async () => {
    runScript();
    const early = takeEarlyResponse(MOVIES_CATALOGUE_KEY);
    expect(early).not.toBeNull();
    expect(await (await early!).json()).toEqual({ url: MOVIES_CATALOGUE_KEY, items: [] });
    expect(takeEarlyResponse(MOVIES_CATALOGUE_KEY)).toBeNull();
  });

  it("ne prend pas une réponse trop vieille : ce n'est plus une ouverture", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    runScript();
    now += EARLY_FETCH_MAX_AGE_MS + 1;
    expect(takeEarlyResponse(RESUME_KEY)).toBeNull();
  });

  it("sans script, fait le fetch d'avant", async () => {
    await fetchOrEarly(NEXT_UP_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(NEXT_UP_KEY);
  });

  it("refait la requête quand l'anticipée a échoué", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("réseau")));
    runScript();
    const res = await fetchOrEarly(MOVIES_CATALOGUE_KEY);
    expect(res.ok).toBe(true);
    // Les trois du script, puis la nouvelle tentative du catalogue.
    expect(fetchMock).toHaveBeenCalledTimes(EARLY_FETCH_URLS.length + 1);
    expect(fetchMock.mock.calls.at(-1)).toEqual([MOVIES_CATALOGUE_KEY]);
  });

  it("les deux récupérateurs de l'écran ne redemandent pas ce que le script a demandé", async () => {
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        url === MOVIES_CATALOGUE_KEY
          ? Response.json({ genres: [], items: [{ radarrId: 1 }], rows: {}, spotlight: [1], recentlyAdded: [], top10: [] })
          : Response.json({ items: [{ id: url }] })
      )
    );
    runScript();
    const movies = await cinemaFetcher<{ spotlight: { radarrId: number }[] }>(MOVIES_CATALOGUE_KEY);
    const resume = await fetcher(RESUME_KEY);
    const nextUp = await fetcher(NEXT_UP_KEY);
    expect(movies.spotlight).toEqual([{ radarrId: 1 }]);
    expect(resume).toEqual({ items: [{ id: RESUME_KEY }] });
    expect(nextUp).toEqual({ items: [{ id: NEXT_UP_KEY }] });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Le relu d'après (retour au premier plan, mutate) repart au réseau, comme avant.
    await fetcher(RESUME_KEY);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("une session expirée reçue par l'anticipée est traitée comme avant", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ error: "Session expirée" }), { status: 401, headers: { "x-session-expired": "1" } }))
    );
    runScript();
    await expect(fetcher(RESUME_KEY)).rejects.toThrow("Session expirée");
    expect(fetchMock).toHaveBeenCalledTimes(EARLY_FETCH_URLS.length);
  });
});
