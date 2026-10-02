import { describe, it, expect } from "vitest";
import { collectionSuite } from "@/lib/collectionSuite";

/**
 * « La suite » d'une saga, à la fin d'un film : le premier après lui, ouvrable ici et pas encore vu.
 * DECISIONS.md §44.
 */

const film = (radarrId: number) => ({ radarrId, jellyfinItemId: `jf-${radarrId}` });
/** Une saga de cinq, dans l'ordre de la rangée ; le troisième n'est pas dans la bibliothèque. */
const SAGA = [{ movie: film(1) }, { movie: film(2) }, { movie: null }, { movie: film(4) }, { movie: film(5) }];

describe("collectionSuite", () => {
  it("propose le film qui suit, dans l'ordre de la saga — jamais un film d'avant", () => {
    expect(collectionSuite(SAGA, 2, { "jf-4": false, "jf-1": false })).toEqual({ kind: "next", movie: film(4) });
    expect(collectionSuite(SAGA, 1, { "jf-2": false })).toEqual({ kind: "next", movie: film(2) });
  });

  it("passe les films déjà vus, et ceux qu'on ne peut pas ouvrir d'ici", () => {
    expect(collectionSuite(SAGA, 1, { "jf-2": true, "jf-4": true, "jf-5": false })).toEqual({ kind: "next", movie: film(5) });
  });

  it("demande l'état d'un film qu'il ne connaît pas encore, un à la fois et dans l'ordre", () => {
    expect(collectionSuite(SAGA, 1, {})).toEqual({ kind: "ask", movie: film(2) });
    expect(collectionSuite(SAGA, 1, { "jf-2": true })).toEqual({ kind: "ask", movie: film(4) });
  });

  it("ne propose rien après le dernier de la saga", () => {
    expect(collectionSuite(SAGA, 5, {})).toEqual({ kind: "none" });
  });

  it("ne propose rien quand tout ce qui suit a été vu", () => {
    expect(collectionSuite(SAGA, 2, { "jf-4": true, "jf-5": true })).toEqual({ kind: "none" });
  });

  it("ne propose rien hors d'une saga", () => {
    expect(collectionSuite([], 2, {})).toEqual({ kind: "none" });
    expect(collectionSuite(SAGA, 99, {})).toEqual({ kind: "none" });
    expect(collectionSuite(SAGA, null, {})).toEqual({ kind: "none" });
  });
});
