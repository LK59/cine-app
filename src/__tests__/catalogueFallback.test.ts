// Le catalogue de secours (DECISIONS.md §92) : le dernier servi à chaque compte, gardé sur disque,
// resservi marqué pendant une panne — et jamais celui d'un autre compte.
import { describe, it, expect, vi, beforeEach } from "vitest";

let account: string | null = "jf-alice";
let down = false;
vi.mock("@/lib/blockedTags", () => ({ requestJfId: async () => account }));
vi.mock("@/lib/jellyfinBreaker", async (original) => ({ ...(await original<typeof import("@/lib/jellyfinBreaker")>()), jellyfinIsDown: () => down }));

import { catalogueFallbackResponse, catalogueResponse, forgetCatalogueFallbackMemory } from "@/lib/catalogueFallback";
import { kvCacheDb } from "@/lib/db";
import { preparedCount } from "@/lib/cachedJson";
import { HttpError, UpstreamUnreachableError } from "@/lib/http";

const outage = new UpstreamUnreachableError("jellyfin ne répond pas", "ENOTFOUND", "jellyfin");

const req = () => new Request("https://cine.example/api/cinema/movies");
const payload = (ids: number[]) => ({ genres: ["Action"], rows: { Action: ids }, items: ids.map((radarrId) => ({ radarrId, title: `#${radarrId}` })), spotlight: ids, recentlyAdded: [], top10: [], top10Theme: null });

let n = 0;
beforeEach(() => {
  // Un compte neuf à chaque test : la base de la suite est commune au fichier.
  n += 1;
  account = `jf-alice-${n}`;
  down = false;
  forgetCatalogueFallbackMemory();
});

describe("catalogueFallback", () => {
  it("resert au même compte son dernier catalogue, marqué périmé — et rien à un autre compte", async () => {
    const alice = account;
    await catalogueResponse(req(), { kind: "movies", locale: "fr", jfId: alice, cacheKey: `k-${n}`, payload: payload([1, 2]) }).json();

    down = true;
    const kept = await catalogueFallbackResponse(req(), "movies", "fr", outage);
    expect(kept).not.toBeNull();
    const body = await kept!.json();
    expect(body.items.map((i: { radarrId: number }) => i.radarrId)).toEqual([1, 2]);
    expect(body).toMatchObject({ stale: true, jellyfinDown: true });
    expect(typeof body.savedAt).toBe("number");

    // Un autre compte — ses tags bloqués pouvaient lui cacher ces titres : rien.
    account = `jf-bob-${n}`;
    expect(await catalogueFallbackResponse(req(), "movies", "fr", outage)).toBeNull();
    // Ni une autre langue, ni l'autre sorte.
    account = alice;
    expect(await catalogueFallbackResponse(req(), "movies", "en", outage)).toBeNull();
    expect(await catalogueFallbackResponse(req(), "series", "fr", outage)).toBeNull();
  });

  it("n'écrit que ce qui change", async () => {
    const set = vi.spyOn(kvCacheDb, "set");
    const opts = { kind: "movies" as const, locale: "fr" as const, jfId: account, cacheKey: `w-${n}`, payload: payload([3]) };
    catalogueResponse(req(), opts);
    const afterFirst = set.mock.calls.length;
    expect(afterFirst).toBe(2);
    catalogueResponse(req(), opts);
    expect(set.mock.calls.length).toBe(afterFirst);
    // Après un redémarrage (mémoire vide), l'étiquette lue sur disque suffit.
    forgetCatalogueFallbackMemory();
    catalogueResponse(req(), opts);
    expect(set.mock.calls.length).toBe(afterFirst);
    catalogueResponse(req(), { ...opts, payload: payload([3, 4]) });
    expect(set.mock.calls.length).toBe(afterFirst + 2);
    set.mockRestore();
  });

  it("le chemin heureux ne porte aucune marque ; Jellyfin réputé hors ligne, la même réponse est marquée", async () => {
    const opts = { kind: "series" as const, locale: "fr" as const, jfId: account, cacheKey: `h-${n}`, payload: payload([5]) };
    const happy = await catalogueResponse(req(), opts).json();
    expect(happy.stale).toBeUndefined();
    expect(happy.jellyfinDown).toBeUndefined();
    down = true;
    const marked = await catalogueResponse(req(), opts).json();
    expect(marked.jellyfinDown).toBe(true);
    expect(marked.stale).toBeUndefined();
  });

  it("sans copie gardée : null, et l'erreur d'origine reste à la route", async () => {
    expect(await catalogueFallbackResponse(req(), "movies", "fr", outage)).toBeNull();
  });

  // Relecture du 14/10/2026 : un défaut de code aurait été masqué par le catalogue d'hier.
  it("seulement pour une panne amont : un défaut de notre code sort en erreur, comme avant", async () => {
    await catalogueResponse(req(), { kind: "movies", locale: "fr", jfId: account, cacheKey: `c-${n}`, payload: payload([7]) }).json();
    expect(await catalogueFallbackResponse(req(), "movies", "fr", new TypeError("Cannot read properties of undefined"))).toBeNull();
    expect(await catalogueFallbackResponse(req(), "movies", "fr", new HttpError("not found", 404))).toBeNull();
    expect(await catalogueFallbackResponse(req(), "movies", "fr", new HttpError("bad gateway", 503))).not.toBeNull();
    expect(await catalogueFallbackResponse(req(), "movies", "fr", new DOMException("timeout", "TimeoutError"))).not.toBeNull();
    expect(await catalogueFallbackResponse(req(), "movies", "fr", outage)).not.toBeNull();
  });

  it("servie à la volée : rien ne s'ajoute à la mémoire des réponses préparées", async () => {
    await catalogueResponse(req(), { kind: "movies", locale: "fr", jfId: account, cacheKey: `p-${n}`, payload: payload([8]) }).json();
    const before = preparedCount();
    for (let i = 0; i < 3; i++) await (await catalogueFallbackResponse(req(), "movies", "fr", outage))!.json();
    expect(preparedCount()).toBe(before);
  });
});
