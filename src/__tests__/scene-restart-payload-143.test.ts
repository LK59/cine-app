import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Les débuts de scène du service jusqu'au lecteur (DECISIONS.md §143) : `entry`, `cut` et `speechShare` passent
 * quand le service les donne — relus avec soin —, et une scène sans eux reste exactement celle d'avant.
 */

const ITEM = "e".repeat(32);
const svc = vi.hoisted(() => ({ scenes: null as unknown }));
vi.mock("@/lib/clients/xray", () => ({
  xrayConfigured: () => true,
  xray: { scenes: async () => svc.scenes, itemStatus: async () => null },
}));
vi.mock("@/lib/xray/cast", () => ({
  analysisTarget: async (itemId: string) => ({ itemId, etag: "v1", tmdb: null, durationS: null }),
  castOf: async () => [],
  tmdbPhotoUrl: (p: string) => p,
}));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

import { scenesForPlayer } from "@/lib/xray/scenes";

const person = { personId: 7, screenTime: 8, confidence: 0.9 };
const plain = { itemId: ITEM, etag: "v1", model: "m", version: 5, complete: true, analyzedUntil: 600 };

beforeEach(() => {
  svc.scenes = null;
});

describe("scenesForPlayer", () => {
  it("sans mesure : les scènes d'avant, sans un champ de plus", async () => {
    svc.scenes = { ...plain, scenes: [{ start: 10, end: 20, people: [person] }] };
    const out = await scenesForPlayer(ITEM);
    expect(out).toEqual({
      status: "done",
      complete: true,
      analyzedUntil: 600,
      scenes: [{ start: 10, end: 20, people: [{ personId: 7, name: null, character: null, photo: null, screenTime: 8, confidence: 0.9 }] }],
    });
  });

  it("mesurées : point d'entrée, verdict et part de parole ; le reste ignoré", async () => {
    svc.scenes = {
      ...plain,
      speechShare: 0.56,
      chapters: { kind: "auteur", count: 3, aligned: 1 },
      cutsVersion: 1,
      scenes: [
        { start: 0, end: 100, people: [], entry: 0, cut: { ok: true, why: "début" } },
        { start: 100, end: 200, people: [], entry: 98.5, cut: { ok: false, why: "parole" }, extra: "x" },
        { start: 200, end: 300, people: [], entry: "200", cut: { ok: "oui", why: 3 } },
      ],
    };
    const out = await scenesForPlayer(ITEM);
    expect(out.speechShare).toBe(0.56);
    expect(out.scenes[0]).toEqual({ start: 0, end: 100, people: [], entry: 0, cut: { ok: true, why: "début" } });
    expect(out.scenes[1]).toEqual({ start: 100, end: 200, people: [], entry: 98.5, cut: { ok: false, why: "parole" } });
    expect(out.scenes[2]).toEqual({ start: 200, end: 300, people: [] });
    expect(out).not.toHaveProperty("chapters");
  });

  it("la parole inconnue reste dite (`null`)", async () => {
    svc.scenes = { ...plain, speechShare: null, scenes: [] };
    expect((await scenesForPlayer(ITEM)).speechShare).toBeNull();
  });
});
