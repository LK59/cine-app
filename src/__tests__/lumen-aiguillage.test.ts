// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { choosePlayer } from "@/lib/playerRoute";
import {
  LUMEN_SERVER_KEY,
  declineLumen,
  lumenChoiceFor,
  lumenDeclined,
  lumenServerOn,
  lumenWanted,
  noteMediaSourceServed,
  pageServedMediaSource,
  resetLumenServerChoice,
  setLumenServer,
} from "@/lib/lumenServerChoice";

/**
 * L'aiguillage de Lumen serveur (étape 4, DECISIONS.md §180) : la route `"lumen"` de `choosePlayer`, prise seulement
 * là où la route serait `"native"`, et `lumenWanted`, qui dit si la page peut la prendre — l'option de l'appareil,
 * WebKit et son HLS natif, une page sans MediaSource, un titre jamais rendu, ni banc ni extrait ni hors ligne.
 */
const base = { serverFallback: true, handedOver: [] as string[], carried: null, takeover: null };
const on = { option: true, nativeHls: () => true, mediaSourceServed: () => false, declined: () => false };

beforeEach(() => {
  resetLumenServerChoice();
  localStorage.clear();
});

describe("choosePlayer — la route lumen", () => {
  it("sans `lumen`, exactement l'aiguillage d'avant", () => {
    expect(choosePlayer({ itemId: "a" }, base)).toBe("native");
    expect(choosePlayer({ itemId: "a" }, { ...base, lumen: false })).toBe("native");
    expect(choosePlayer({ itemId: "a" }, { ...base, handedOver: ["a"] })).toBe("server");
  });

  it("`lumen` vrai remplace seulement la route native", () => {
    expect(choosePlayer({ itemId: "a" }, { ...base, lumen: true })).toBe("lumen");
    // Sans lecteur serveur sur l'installation, la route reste celle du natif : Lumen serveur aussi.
    expect(choosePlayer({ itemId: "a" }, { ...base, serverFallback: false, lumen: true })).toBe("lumen");
  });

  it("un relais, une page rechargée sur le lecteur serveur, une version allégée passent avant", () => {
    expect(choosePlayer({ itemId: "a" }, { ...base, handedOver: ["a"], lumen: true })).toBe("server");
    expect(choosePlayer({ itemId: "a", reloadedOnServer: "a" }, { ...base, lumen: true })).toBe("server");
    expect(choosePlayer({ itemId: "a", lighter: { targetBps: 1, tier: 1 } }, { ...base, lumen: true })).toBe("server");
  });
});

describe("lumenWanted — chaque condition", () => {
  it("toutes réunies : oui", () => {
    expect(lumenWanted({ itemId: "a" }, on)).toBe(true);
  });
  it("l'option coupée", () => {
    expect(lumenWanted({ itemId: "a" }, { ...on, option: false })).toBe(false);
  });
  it("hors WebKit (pas de HLS natif) — Chrome et Firefox restent sur le lecteur actuel", () => {
    expect(lumenWanted({ itemId: "a" }, { ...on, nativeHls: () => false })).toBe(false);
  });
  it("une page qui a servi une MediaSource (WebKit y refuse le HLS natif, code 4)", () => {
    expect(lumenWanted({ itemId: "a" }, { ...on, mediaSourceServed: () => true })).toBe(false);
  });
  it("un titre déjà rendu au lecteur actuel", () => {
    expect(lumenWanted({ itemId: "a" }, { ...on, declined: (id) => id === "a" })).toBe(false);
    expect(lumenWanted({ itemId: "b" }, { ...on, declined: (id) => id === "a" })).toBe(true);
  });
  it("« Améliorer les dialogues » allumé sur l'appareil (§188) : le lecteur actuel, qui fait le traitement", () => {
    expect(lumenWanted({ itemId: "a" }, { ...on, dialogue: () => true })).toBe(false);
    expect(lumenWanted({ itemId: "a" }, { ...on, dialogue: () => false })).toBe(true);
  });
  it("ni banc d'essai, ni extrait de test, ni fichier hors ligne", () => {
    expect(lumenWanted({ itemId: "a", bench: "x" }, on)).toBe(false);
    expect(lumenWanted({ itemId: "a", labSample: {} }, on)).toBe(false);
    expect(lumenWanted({ itemId: "a", offline: { id: "o" } }, on)).toBe(false);
  });
  it("sans sonde, l'état de la page : MediaSource notée, titre rendu", () => {
    expect(pageServedMediaSource()).toBe(false);
    noteMediaSourceServed();
    expect(pageServedMediaSource()).toBe(true);
    expect(lumenWanted({ itemId: "a" }, { option: true, nativeHls: () => true })).toBe(false);
    resetLumenServerChoice();
    declineLumen("a");
    expect(lumenDeclined("a")).toBe(true);
    expect(lumenWanted({ itemId: "a" }, { option: true, nativeHls: () => true })).toBe(false);
  });
});

describe("l'option de l'appareil", () => {
  it("rangée dans `cine:lumen-serveur`, absente = coupée", () => {
    expect(lumenServerOn()).toBe(false);
    setLumenServer(true);
    expect(localStorage.getItem(LUMEN_SERVER_KEY)).toBe("1");
    expect(lumenServerOn()).toBe(true);
    setLumenServer(false);
    expect(localStorage.getItem(LUMEN_SERVER_KEY)).toBeNull();
  });

  it("figée par séance : basculer l'option en plein film ne change pas de lecteur ; la séance suivante relit", () => {
    const film = {};
    setLumenServer(true);
    expect(lumenChoiceFor(film)).toBe(true);
    setLumenServer(false);
    expect(lumenChoiceFor(film)).toBe(true);
    expect(lumenChoiceFor({})).toBe(false);
  });
});
