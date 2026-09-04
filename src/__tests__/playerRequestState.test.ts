import { describe, it, expect } from "vitest";
import { resolveRequestState, isReleased } from "@/lib/playerRequestState";

describe("resolveRequestState", () => {
  it("says available as soon as the media is there, whatever the request says", () => {
    expect(resolveRequestState({ requestStatus: 1, mediaStatus: 5, released: true })).toBe("available");
    // Partiellement disponible compte : une série dont la première saison est là se regarde.
    expect(resolveRequestState({ requestStatus: 2, mediaStatus: 4, released: true })).toBe("available");
  });

  it("prefers availability over an unreleased date", () => {
    // Cas réel : une sortie numérique en avance sur la date que TMDB porte encore.
    expect(resolveRequestState({ mediaStatus: 5, released: false })).toBe("available");
  });

  it("reports a declined or failed request rather than spinning forever", () => {
    expect(resolveRequestState({ requestStatus: 3, mediaStatus: 2, released: true })).toBe("failed");
    expect(resolveRequestState({ requestStatus: 4, mediaStatus: 2, released: true })).toBe("failed");
  });

  it("distinguishes a title that isn't out yet from one being fetched", () => {
    expect(resolveRequestState({ requestStatus: 2, mediaStatus: 3, released: false })).toBe("unreleased");
    expect(resolveRequestState({ requestStatus: 2, mediaStatus: 3, released: true })).toBe("processing");
  });

  // Le piège que ce test existe pour empêcher : si une source cesse un jour de porter la date,
  // `released` arrive à null et TOUT afficherait « pas encore sorti ». Dans le doute, « en cours ».
  it("falls back to processing when the release date is simply unknown", () => {
    expect(resolveRequestState({ requestStatus: 2, mediaStatus: 3, released: null })).toBe("processing");
    expect(resolveRequestState({ requestStatus: 2, mediaStatus: 3 })).toBe("processing");
  });
});

describe("isReleased", () => {
  const now = new Date("2026-09-05T12:00:00Z");

  it("treats a missing date as not released — TMDB leaves it empty until one is announced", () => {
    expect(isReleased(null, now)).toBe(false);
    expect(isReleased(undefined, now)).toBe(false);
    expect(isReleased("", now)).toBe(false);
  });

  it("compares against the given moment", () => {
    expect(isReleased("2012-10-24", now)).toBe(true);
    expect(isReleased("2027-01-01", now)).toBe(false);
  });

  // Une date illisible ne doit pas coincer un titre dans « pas encore sorti » indéfiniment.
  it("treats an unparseable date as released rather than blocking the title", () => {
    expect(isReleased("pas une date", now)).toBe(true);
  });
});
