import { describe, it, expect, vi, beforeEach } from "vitest";

const awaiting = new Set<string>();
vi.mock("@/lib/persistentCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/persistentCache")>()),
  isAwaitingFresh: (key: string) => awaiting.has(key),
}));

import { feedResumeAt } from "@/lib/sheetFacts";

// Une carte « Reprendre » relue du cache de l'appareil peut dater de la veille : sa position n'est
// pas une affirmation. Tant que la liste fraîche n'est pas arrivée, on laisse le serveur répondre
// (`resumeAt` absent) au lieu d'imposer une position périmée — ou zéro (25/09/2026).

describe("feedResumeAt", () => {
  beforeEach(() => awaiting.clear());

  it("donne la position d'une liste fraîche, zéro compris", () => {
    expect(feedResumeAt(1_200 * 10_000_000, "/k")).toBe(1_200);
    expect(feedResumeAt(0, "/k")).toBe(0);
    expect(feedResumeAt(null, "/k")).toBe(0);
  });

  it("ne dit rien tant que la liste vient du cache", () => {
    awaiting.add("/k");
    expect(feedResumeAt(1_200 * 10_000_000, "/k")).toBeUndefined();
  });
});
