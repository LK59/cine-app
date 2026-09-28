import { describe, it, expect } from "vitest";
import { continueOrder } from "@/lib/continueOrder";

/**
 * L'ordre de « Reprendre » (28/09/2026) : les films passaient toujours devant les épisodes, et les
 * épisodes suivaient l'ordre d'« À suivre » selon Jellyfin — pas celui de la dernière lecture.
 */
describe("continueOrder", () => {
  const movie = (id: string, lastPlayedAt: string | null) => ({ id, lastPlayedAt });
  const episode = (jellyfinItemId: string, lastPlayedAt: string | null) => ({ jellyfinItemId, lastPlayedAt });

  it("met le dernier lu en premier, films et épisodes mêlés", () => {
    const order = continueOrder(
      [movie("guillaume", "2026-09-26T12:39:29Z")],
      [episode("ted", "2026-09-28T09:27:30Z"), episode("robot", "2026-09-28T09:28:48Z"), episode("love", "2026-09-23T22:42:37Z")]
    );
    expect(order.map((e) => e.key)).toEqual(["robot", "ted", "guillaume", "love"]);
    expect(order.map((e) => e.kind)).toEqual(["episode", "episode", "movie", "episode"]);
  });

  it("garde en place, après les datés, ce qui n'a pas de date — les films avant les épisodes", () => {
    const order = continueOrder([movie("m1", null), movie("m2", "2026-09-20T00:00:00Z")], [episode("e1", null), episode("e2", "2026-09-21T00:00:00Z")]);
    expect(order.map((e) => e.key)).toEqual(["e2", "m2", "m1", "e1"]);
  });

  it("rend l'élément tel quel, pour que la carte le lise", () => {
    const m = { id: "x", lastPlayedAt: null, name: "Film" };
    const [entry] = continueOrder([m], []);
    expect(entry).toEqual({ kind: "movie", key: "x", item: m });
  });
});
