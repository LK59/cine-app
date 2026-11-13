import { describe, it, expect } from "vitest";
import { formatDurationShort, formatMinutes } from "@/lib/format";

describe("formatMinutes", () => {
  // Le point de départ : « 70 min » oblige à faire la division soi-même pour savoir ce qu'on
  // s'engage à regarder.
  it("says an hour and ten rather than seventy minutes", () => {
    expect(formatMinutes(70)).toBe("1h10");
    expect(formatMinutes(152)).toBe("2h32");
  });

  // En dessous d'une heure, la minute reste la bonne unité — « 0h45 » serait une coquetterie.
  it("keeps minutes below the hour", () => {
    expect(formatMinutes(45)).toBe("45min");
    expect(formatMinutes(1)).toBe("1min");
  });

  it("pads the minutes so two durations line up", () => {
    expect(formatMinutes(65)).toBe("1h05");
    expect(formatMinutes(120)).toBe("2h00");
  });

  // Rien à dire vaut mieux que « 0min » : l'appelant n'affiche alors rien du tout.
  it("says nothing when there is nothing to say", () => {
    expect(formatMinutes(0)).toBeNull();
    expect(formatMinutes(null)).toBeNull();
    expect(formatMinutes(undefined)).toBeNull();
    expect(formatMinutes(-5)).toBeNull();
  });
});

// Relecture des fiches par le propriétaire (13/11/2026) : en français, une espace (insécable, comme
// `fmtSize`) avant l'unité et entre heures et minutes — « 50 min/ép. », « 2 h 47 ». Les autres langues,
// et un appel sans langue, gardent la forme d'avant.
describe("formatMinutes / formatDurationShort — la typographie de la langue", () => {
  const NB = "\u00a0";
  it("en français : « 50 min », « 2 h 47 », « 1 h 05 », « 2 h » pile", () => {
    expect(formatMinutes(50, "fr")).toBe(`50${NB}min`);
    expect(formatMinutes(167, "fr")).toBe(`2${NB}h${NB}47`);
    expect(formatMinutes(65, "fr")).toBe(`1${NB}h${NB}05`);
    expect(formatMinutes(120, "fr")).toBe(`2${NB}h`);
    expect(formatMinutes(0, "fr")).toBeNull();
  });

  it("le temps restant aussi : « 30 min », « 1 h 10 »", () => {
    expect(formatDurationShort(30 * 60 * 10_000_000, "fr")).toBe(`30${NB}min`);
    expect(formatDurationShort(70 * 60 * 10_000_000, "fr-FR")).toBe(`1${NB}h${NB}10`);
  });

  it("en anglais, espagnol, allemand et sans langue : inchangé", () => {
    for (const locale of ["en", "es", "de", undefined]) {
      expect(formatMinutes(50, locale)).toBe("50min");
      expect(formatMinutes(167, locale)).toBe("2h47");
      expect(formatMinutes(120, locale)).toBe("2h00");
      expect(formatDurationShort(30 * 60 * 10_000_000, locale)).toBe("30min");
    }
  });

  it("la fiche du téléphone : « 50 min/ép. » et « 30 min restantes » avec le vrai dictionnaire", async () => {
    const { createT } = await import("@/lib/i18n");
    const fr = (await import("@/locales/fr.json")).default as Record<string, unknown>;
    const t = createT(fr, fr, "fr");
    expect(t("cinema.perEpisode", { time: formatMinutes(50, "fr")! })).toBe(`50${NB}min/ép.`);
    expect(t("cinema.timeRemaining", { time: formatDurationShort(30 * 60 * 10_000_000, "fr") })).toBe(`30${NB}min restantes`);
  });
});
