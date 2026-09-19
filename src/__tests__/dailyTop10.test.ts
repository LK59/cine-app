import { describe, it, expect } from "vitest";
import { dailyTop10, dayKey, type ThemedItem } from "@/lib/cinemaRails";

// Le classement ne bouge pas — c'est ce qu'on classe qui change. Un palmarès qui se remélange
// chaque matin n'est plus un palmarès : le premier d'hier disparaît sans que rien ne l'explique.

const film = (note: number, genres: string[], year: number): ThemedItem => ({
  imdbRating: String(note),
  addedAt: "2026-01-01T00:00:00Z",
  genres,
  year,
});

/** Une collection assez fournie pour porter deux genres et deux décennies. */
function collection(): ThemedItem[] {
  const out: ThemedItem[] = [];
  for (let i = 0; i < 12; i++) out.push(film(5 + i * 0.1, ["Thriller"], 1995));
  for (let i = 0; i < 12; i++) out.push(film(5 + i * 0.1, ["Comedy"], 2015));
  return out;
}

describe("le palmarès du jour", () => {
  it("classe par note, du meilleur au moins bon", () => {
    const { items } = dailyTop10(collection(), "2026-09-19");
    expect(items).toHaveLength(10);
    const notes = items.map((i) => Number(i.imdbRating));
    expect([...notes].sort((a, b) => b - a)).toEqual(notes);
  });

  it("ne retient que des titres du thème annoncé", () => {
    const { theme, items } = dailyTop10(collection(), "2026-09-19");
    expect(theme).not.toBeNull();
    for (const i of items) {
      if (theme!.kind === "genre") expect(i.genres).toContain(theme!.genre);
      else expect(Math.floor((i.year as number) / 10) * 10).toBe(theme!.decade);
    }
  });

  it("donne le même thème à tout le monde, toute la journée", () => {
    // La rangée serait autrement redessinée à chaque revalidation : la charge utile est en cache
    // deux minutes, et le palmarès changerait sous les yeux sans raison visible.
    const a = dailyTop10(collection(), "2026-09-19").theme;
    const b = dailyTop10(collection(), "2026-09-19").theme;
    expect(a).toEqual(b);
  });

  it("change de thème d'un jour à l'autre", () => {
    const jours = ["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24"];
    const themes = new Set(jours.map((j) => JSON.stringify(dailyTop10(collection(), j).theme)));
    expect(themes.size).toBeGreaterThan(1);
  });

  it("écarte un thème qui ne peut pas remplir dix places", () => {
    // Un « top 10 » de quatre titres est pire que pas de thème du tout.
    const maigre = [...collection(), ...Array.from({ length: 4 }, () => film(9, ["Documentary"], 2001))];
    const vus = new Set<string>();
    for (let j = 1; j <= 31; j++) {
      const t = dailyTop10(maigre, `2026-10-${String(j).padStart(2, "0")}`).theme;
      if (t?.kind === "genre") vus.add(t.genre);
    }
    expect(vus.has("Documentary")).toBe(false);
  });

  it("retombe sur toute la collection quand rien n'est assez fourni", () => {
    // Une bibliothèque qui débute vaut mieux avec un palmarès général qu'avec un thème creux.
    const petite = [film(8, ["Drama"], 2000), film(7, ["Drama"], 2001)];
    const { theme, items } = dailyTop10(petite, "2026-09-19");
    expect(theme).toBeNull();
    expect(items).toHaveLength(2);
  });

  it("ne classe jamais un titre sans note", () => {
    const sansNote = { imdbRating: null, addedAt: null, genres: ["Thriller"], year: 1995 };
    const { items } = dailyTop10([...collection(), sansNote], "2026-09-19");
    expect(items).not.toContain(sansNote);
  });
});

describe("dayKey", () => {
  it("nomme le jour civil, pas l'instant", () => {
    expect(dayKey(new Date(2026, 8, 19, 0, 1))).toBe("2026-09-19");
    expect(dayKey(new Date(2026, 8, 19, 23, 59))).toBe("2026-09-19");
    expect(dayKey(new Date(2026, 8, 20, 0, 0))).toBe("2026-09-20");
  });
});
