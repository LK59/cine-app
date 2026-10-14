// Le catalogue de secours (DECISIONS.md §92) : le dernier servi à chaque compte, gardé sur disque,
// resservi marqué pendant une panne — et jamais celui d'un autre compte.
import { describe, it, expect, vi, beforeEach } from "vitest";

let account: string | null = "jf-alice";
let down = false;
vi.mock("@/lib/blockedTags", () => ({ requestJfId: async () => account }));
vi.mock("@/lib/jellyfinBreaker", () => ({ jellyfinIsDown: () => down }));

import { catalogueFallbackResponse, catalogueResponse, forgetCatalogueFallbackMemory } from "@/lib/catalogueFallback";
import { kvCacheDb } from "@/lib/db";

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
    const kept = await catalogueFallbackResponse(req(), "movies", "fr");
    expect(kept).not.toBeNull();
    const body = await kept!.json();
    expect(body.items.map((i: { radarrId: number }) => i.radarrId)).toEqual([1, 2]);
    expect(body).toMatchObject({ stale: true, jellyfinDown: true });
    expect(typeof body.savedAt).toBe("number");

    // Un autre compte — ses tags bloqués pouvaient lui cacher ces titres : rien.
    account = `jf-bob-${n}`;
    expect(await catalogueFallbackResponse(req(), "movies", "fr")).toBeNull();
    // Ni une autre langue, ni l'autre sorte.
    account = alice;
    expect(await catalogueFallbackResponse(req(), "movies", "en")).toBeNull();
    expect(await catalogueFallbackResponse(req(), "series", "fr")).toBeNull();
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
    expect(await catalogueFallbackResponse(req(), "movies", "fr")).toBeNull();
  });
});
