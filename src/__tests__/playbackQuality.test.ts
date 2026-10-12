// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Le réglage « Qualité » et la seule mémoire de la version allégée, la règle des deux minutes
// (DECISIONS.md §78).

let account: string | null = "louis";
vi.mock("@/lib/persistentCache", () => ({ persistedCacheAccount: () => account }));

import { LIGHTER_CARRY_MS, carriedLighter, forgetLighterCarry, readPlaybackQuality, rememberLighter, writePlaybackQuality } from "@/lib/playbackQuality";

const STEP = { targetBps: 2_500_000, tier: 1 };

beforeEach(() => {
  account = "louis";
  writePlaybackQuality("auto");
  forgetLighterCarry();
});

describe("la règle des deux minutes", () => {
  it("une séance allégée arrêtée : la lecture lancée dans les 2 min reprend son palier, quel que soit le titre ; après, non", () => {
    rememberLighter(STEP, 1000);
    expect(carriedLighter(1000 + LIGHTER_CARRY_MS - 1)).toEqual(STEP);
    expect(carriedLighter(1000 + LIGHTER_CARRY_MS + 1)).toBeNull();
    forgetLighterCarry();
    expect(carriedLighter(2000)).toBeNull();
  });

  it("« Originale » efface la mémoire, et n'en lit ni n'en écrit aucune", () => {
    rememberLighter(STEP, 1000);
    writePlaybackQuality("original");
    expect(carriedLighter(2000)).toBeNull();
    rememberLighter(STEP, 3000);
    writePlaybackQuality("auto");
    // Rien n'a été retenu pendant « Originale », et ce qui l'était avant reste effacé.
    expect(carriedLighter(4000)).toBeNull();
  });

  it("liée au compte : un appareil partagé ne passe pas le palier de l'un à l'autre", () => {
    rememberLighter(STEP, 1000);
    account = "sarah";
    expect(carriedLighter(2000)).toBeNull();
    account = "louis";
    expect(carriedLighter(2000)).toEqual(STEP);
  });
});

describe("le réglage", () => {
  it("lu une fois puis gardé en mémoire : un rendu ne touche plus le stockage", () => {
    writePlaybackQuality("original");
    const get = vi.spyOn(Storage.prototype, "getItem");
    try {
      for (let i = 0; i < 5; i++) expect(readPlaybackQuality()).toBe("original");
      expect(get).not.toHaveBeenCalled();
      // Un autre compte : sa propre clé, relue une fois.
      account = "sarah";
      expect(readPlaybackQuality()).toBe("auto");
      expect(readPlaybackQuality()).toBe("auto");
      expect(get).toHaveBeenCalledTimes(1);
    } finally {
      get.mockRestore();
    }
  });
});
