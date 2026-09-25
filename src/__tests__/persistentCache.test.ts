import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fakeIndexedDb } from "./helpers/fakeIndexedDb";
import {
  MAX_AGE_MS,
  PERSISTED_CACHE_SCHEMA,
  PERSISTED_KEYS,
  catalogueCacheReady,
  clearPersistedCache,
  flushPersistentWritesForTests,
  hydrateFromDisk,
  isAwaitingFresh,
  isPersistedKey,
  noteResponse,
  readAccountCache,
  requestPersistence,
  resetPersistentCacheForTests,
  writeEntries,
} from "@/lib/persistentCache";
import { MOVIES_CATALOGUE_KEY, NEXT_UP_KEY, RESUME_KEY, SERIES_CATALOGUE_KEY, TO_WATCH_KEY } from "@/lib/swr";

/**
 * Le catalogue de la dernière visite, gardé sur l'appareil (25/09/2026) : chaque ouverture
 * redemandait tout au serveur, une à deux secondes d'écran de chargement en itinérance.
 */

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const entry = (account: string, key: string, data: unknown, savedAt = Date.now(), schema = PERSISTED_CACHE_SCHEMA) => ({
  account,
  key,
  data,
  savedAt,
  schema,
});

beforeEach(() => {
  resetPersistentCacheForTests();
  vi.stubGlobal("indexedDB", fakeIndexedDb());
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("ce qui se garde", () => {
  it("les flux de l'écran d'accueil, sous les mêmes adresses que SWR", () => {
    // Écrites en toutes lettres dans le module (qui ne peut pas importer `swr.ts`) : elles doivent
    // rester exactement celles des écrans, sinon le cache se range sous une clé que personne ne lit.
    for (const key of [MOVIES_CATALOGUE_KEY, SERIES_CATALOGUE_KEY, RESUME_KEY, NEXT_UP_KEY, TO_WATCH_KEY, "/api/player/lists"]) {
      expect(PERSISTED_KEYS).toContain(key);
    }
  });

  // 25/09/2026 : sans elle, le bouton Lire de chaque fiche attendait cette réponse à chaque
  // lancement — `usePlayerEnabled` dit « non » tant qu'il ne sait pas — et surgissait après coup.
  it("la configuration du lecteur, qui décide si les fiches ont un bouton Lire", () => {
    expect(PERSISTED_KEYS).toContain("/api/config/public");
  });

  it("et rien d'autre", () => {
    expect(isPersistedKey("/api/cinema/progress/abc")).toBe(false);
    expect(isPersistedKey("/api/auth/me")).toBe(false);
  });
});

describe("le cache d'un compte", () => {
  it("se relit tel qu'il a été écrit", async () => {
    await writeEntries([entry("louis", MOVIES_CATALOGUE_KEY, { genres: ["Drame"] })]);
    const [read] = await readAccountCache("louis");
    expect(read.data).toEqual({ genres: ["Drame"] });
  });

  it("n'est jamais lu par un autre compte", async () => {
    await writeEntries([entry("louis", RESUME_KEY, { items: [{ id: "a" }] })]);
    expect(await readAccountCache("lucas")).toEqual([]);
  });

  it(`n'est plus lu au-delà de sept jours, ni d'une autre version de format`, async () => {
    const now = Date.now();
    await writeEntries([
      entry("louis", MOVIES_CATALOGUE_KEY, {}, now - MAX_AGE_MS - 1),
      entry("louis", SERIES_CATALOGUE_KEY, {}, now, PERSISTED_CACHE_SCHEMA - 1),
      entry("louis", RESUME_KEY, { items: [] }, now),
    ]);
    const read = await readAccountCache("louis", now);
    expect(read.map((e) => e.key)).toEqual([RESUME_KEY]);
  });

  it("disparaît entièrement à la déconnexion, tous comptes compris", async () => {
    await writeEntries([entry("louis", RESUME_KEY, {}), entry("lucas", RESUME_KEY, {})]);
    await clearPersistedCache();
    expect(await readAccountCache("louis")).toEqual([]);
    expect(await readAccountCache("lucas")).toEqual([]);
  });

  it("sans IndexedDB — navigation privée —, il n'y a rien, et rien ne lève", async () => {
    resetPersistentCacheForTests();
    vi.stubGlobal("indexedDB", undefined);
    expect(await readAccountCache("louis")).toEqual([]);
    expect(await writeEntries([entry("louis", RESUME_KEY, {})])).toBe(false);
    await expect(clearPersistedCache()).resolves.toBeUndefined();
  });

  it("un IndexedDB qui lève à l'ouverture ne lève pas plus loin", async () => {
    resetPersistentCacheForTests();
    vi.stubGlobal("indexedDB", { open: () => { throw new Error("SecurityError"); } });
    expect(await readAccountCache("louis")).toEqual([]);
  });
});

describe("au démarrage", () => {
  function target(known: string[] = []) {
    const set = vi.fn();
    return { has: (key: string) => known.includes(key), set };
  }

  it("pose le cache du compte dans SWR, et le marque en attente de sa version fraîche", async () => {
    await writeEntries([entry("louis", MOVIES_CATALOGUE_KEY, { genres: [] }), entry("louis", RESUME_KEY, { items: [] })]);
    const t = target();
    expect(await hydrateFromDisk("louis", t)).toBe(2);
    expect(t.set).toHaveBeenCalledWith(MOVIES_CATALOGUE_KEY, { genres: [] });
    expect(isAwaitingFresh(MOVIES_CATALOGUE_KEY)).toBe(true);
  });

  it("ne touche pas une clé qu'un écran a déjà demandée — SWR jetterait sa réponse en cours", async () => {
    await writeEntries([entry("louis", RESUME_KEY, { items: [] })]);
    const t = target([RESUME_KEY]);
    expect(await hydrateFromDisk("louis", t)).toBe(0);
    expect(t.set).not.toHaveBeenCalled();
  });

  it("sans compte, ne lit rien et libère tout de suite le cinéma", async () => {
    const t = target();
    expect(await hydrateFromDisk(null, t)).toBe(0);
    await expect(catalogueCacheReady(10_000)).resolves.toBeUndefined();
  });

  it("le cinéma n'attend jamais plus que son budget", async () => {
    const started = Date.now();
    await catalogueCacheReady(30);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("les réponses fraîches", () => {
  it("sont réécrites pour la prochaine ouverture, et lèvent l'attente", async () => {
    await writeEntries([entry("louis", RESUME_KEY, { items: [] })]);
    await hydrateFromDisk("louis", { has: () => false, set: () => {} });
    expect(isAwaitingFresh(RESUME_KEY)).toBe(true);

    noteResponse(RESUME_KEY, { items: [{ id: "neuf" }] });
    expect(isAwaitingFresh(RESUME_KEY)).toBe(false);
    flushPersistentWritesForTests();
    await settle();
    const [read] = await readAccountCache("louis");
    expect(read.data).toEqual({ items: [{ id: "neuf" }] });
  });

  it("une donnée relue du disque qui repasse n'est pas une réponse", async () => {
    const cached = { items: [{ id: "ancien" }] };
    const savedAt = Date.now() - 3 * 24 * 3600_000;
    await writeEntries([entry("louis", RESUME_KEY, cached, savedAt)]);
    let posed: unknown;
    await hydrateFromDisk("louis", { has: () => false, set: (_k, data) => (posed = data) });
    noteResponse(RESUME_KEY, posed);
    expect(isAwaitingFresh(RESUME_KEY)).toBe(true);
    flushPersistentWritesForTests();
    await settle();
    // Pas redaté : sinon un cache jamais rafraîchi ne périmerait jamais.
    const [read] = await readAccountCache("louis");
    expect(read.savedAt).toBe(savedAt);
  });

  it("ne s'écrivent pas pour une page sans compte", async () => {
    await hydrateFromDisk(null, { has: () => false, set: () => {} });
    noteResponse(RESUME_KEY, { items: [] });
    flushPersistentWritesForTests();
    await settle();
    expect(await readAccountCache("louis")).toEqual([]);
  });

  it("une clé qui n'est pas gardée est ignorée", async () => {
    await hydrateFromDisk("louis", { has: () => false, set: () => {} });
    noteResponse("/api/auth/me", { username: "louis" });
    flushPersistentWritesForTests();
    await settle();
    expect(await readAccountCache("louis")).toEqual([]);
  });
});

describe("le journal des vitesses", () => {
  it("part une fois, à la première réponse du catalogue, avec ce que le cache a fait", async () => {
    await writeEntries([entry("louis", MOVIES_CATALOGUE_KEY, { genres: [] }, Date.now() - 60_000)]);
    await hydrateFromDisk("louis", { has: () => false, set: () => {} });
    noteResponse(MOVIES_CATALOGUE_KEY, { genres: ["Drame"] });
    noteResponse(MOVIES_CATALOGUE_KEY, { genres: ["Drame", "Comédie"] });
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => url === "/api/startup-timing");
    expect(calls).toHaveLength(1);
    const body = JSON.parse((calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ cacheUsed: true });
    expect(body.cacheAgeMs).toBeGreaterThanOrEqual(60_000);
    expect(typeof body.networkMs).toBe("number");
    expect(typeof body.build).toBe("string");
  });

  it("dit aussi une ouverture sans cache", async () => {
    await hydrateFromDisk("louis", { has: () => false, set: () => {} });
    noteResponse(MOVIES_CATALOGUE_KEY, { genres: [] });
    const [call] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => url === "/api/startup-timing");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toMatchObject({ cacheUsed: false, cacheMs: null });
  });
});

describe("garder le cache à l'abri d'iOS", () => {
  const WEBKIT = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1";
  const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0";

  it("demande la persistance sur WebKit et Chromium, où c'est silencieux", async () => {
    const storage = { persisted: vi.fn(async () => false), persist: vi.fn(async () => true) };
    expect(await requestPersistence(WEBKIT, storage)).toBe("accordé");
    expect(storage.persist).toHaveBeenCalledTimes(1);
  });

  it("ne redemande pas ce qui est déjà accordé", async () => {
    const storage = { persisted: vi.fn(async () => true), persist: vi.fn(async () => true) };
    expect(await requestPersistence(WEBKIT, storage)).toBe("déjà");
    expect(storage.persist).not.toHaveBeenCalled();
  });

  it("ne demande jamais rien à Firefox, qui afficherait une invite", async () => {
    const storage = { persisted: vi.fn(async () => false), persist: vi.fn(async () => true) };
    expect(await requestPersistence(FIREFOX, storage)).toBe("ignoré");
    expect(storage.persist).not.toHaveBeenCalled();
    expect(storage.persisted).not.toHaveBeenCalled();
  });

  it("un navigateur sans l'API, ou qui lève, ne coûte rien", async () => {
    expect(await requestPersistence(WEBKIT, undefined)).toBe("ignoré");
    expect(await requestPersistence(WEBKIT, { persisted: async () => { throw new Error("x"); }, persist: async () => true })).toBe("ignoré");
  });
});
