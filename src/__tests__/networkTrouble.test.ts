import { describe, it, expect, beforeEach } from "vitest";
import { networkUnstable, noteFetchRetrying, noteFetchSettled, resetNetworkTrouble, subscribeNetworkTrouble } from "@/lib/networkTrouble";

// « Connexion perdue ou instable… » (DECISIONS.md §78) : tant qu'un morceau réessaie.

beforeEach(() => resetNetworkTrouble());

describe("des tentatives en cours", () => {
  it("instable tant qu'un morceau réessaie, stable quand le dernier a fini — et prévenu une fois par changement", () => {
    const seen: boolean[] = [];
    const stop = subscribeNetworkTrouble((v) => seen.push(v));
    noteFetchRetrying();
    noteFetchRetrying();
    expect(networkUnstable()).toBe(true);
    noteFetchSettled();
    expect(networkUnstable()).toBe(true);
    noteFetchSettled();
    expect(networkUnstable()).toBe(false);
    noteFetchSettled();
    expect(seen).toEqual([true, false]);
    stop();
  });
});
