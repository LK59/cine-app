import { describe, it, expect } from "vitest";
import { HOLD_AFTER_AWAY_MS, holdPausedOnReturn, rewoundPosition } from "@/lib/backgroundReturn";

/** Verrouillé une minute en plein film, sur un iPhone : WebKit relançait tout seul (25/09/2026). */
const locked = { awayMs: 60_000, playingWhenHidden: true, positionWhenHidden: 4115, positionOnReturn: 4115.2 };

describe("la lecture au retour d'arrière-plan", () => {
  it("attend en pause après une absence de plus de quelques secondes", () => {
    expect(holdPausedOnReturn(locked)).toBe(true);
  });

  it("reprend comme avant après un aller-retour rapide", () => {
    expect(holdPausedOnReturn({ ...locked, awayMs: HOLD_AFTER_AWAY_MS - 1 })).toBe(false);
  });

  it("ne touche pas à un film qui était déjà en pause", () => {
    expect(holdPausedOnReturn({ ...locked, playingWhenHidden: false })).toBe(false);
  });

  it("ne touche pas à une vidéo qui a continué pendant l'absence — image dans l'image", () => {
    expect(holdPausedOnReturn({ ...locked, positionOnReturn: 4175 })).toBe(false);
  });

  it("reprend quelques secondes avant, jamais avant le début", () => {
    expect(rewoundPosition(4115)).toBe(4112);
    expect(rewoundPosition(1)).toBe(0);
  });
});
