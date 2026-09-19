import { describe, it, expect } from "vitest";
import { dailyTop10, dayKey, type ThemedItem } from "@/lib/cinemaRails";

// Le classement ne bouge pas — c'est ce qu'on classe qui change. Un palmarès qui se remélange
// chaque matin n'est plus un palmarès : le premier d'hier disparaît sans que rien ne l'explique.

let prochain = 1;
const film = (note: number, genres: string[], year: number): ThemedItem & { id: number } => ({
  id: prochain++,
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

describe("les tranches croisées", () => {
  // « Comédie · années 2000 » : une tranche qui se comprend mieux qu'un genre seul, et qui
  // multiplie les combinaisons sans rien coûter de plus.
  function large() {
    const out: (ThemedItem & { id: number })[] = [];
    for (const g of ["Comedy", "Horror"]) for (const y of [1995, 2005]) for (let i = 0; i < 12; i++) out.push(film(5 + i * 0.1, [g], y));
    return out;
  }

  it("propose des thèmes qui croisent un genre et une décennie", () => {
    const vus = new Set<string>();
    for (let j = 1; j <= 28; j++) {
      const t = dailyTop10(large(), `2026-11-${String(j).padStart(2, "0")}`).theme;
      if (t?.kind === "genreDecade") vus.add(`${t.genre}|${t.decade}`);
    }
    expect(vus.size).toBeGreaterThan(0);
  });

  it("ne retient alors que ce qui satisfait les deux conditions", () => {
    for (let j = 1; j <= 28; j++) {
      const { theme, items } = dailyTop10(large(), `2026-11-${String(j).padStart(2, "0")}`);
      if (theme?.kind !== "genreDecade") continue;
      for (const i of items) {
        expect(i.genres).toContain(theme.genre);
        expect(Math.floor((i.year as number) / 10) * 10).toBe(theme.decade);
      }
    }
  });

  it("écarte une combinaison trop maigre", () => {
    // Douze comédies de 2005, mais deux seulement en 1975 : la seconde tranche n'existe pas.
    const maigre = [...large(), film(9.9, ["Comedy"], 1975), film(9.8, ["Comedy"], 1975)];
    for (let j = 1; j <= 31; j++) {
      const t = dailyTop10(maigre, `2026-12-${String(j).padStart(2, "0")}`).theme;
      if (t?.kind === "genreDecade") expect(t.decade).not.toBe(1970);
    }
  });
});

describe("le repos après trois jours d'affilée", () => {
  // Un très bon film appartient à plusieurs genres et à une décennie : sans borne, il reviendrait
  // presque tous les jours et le palmarès redeviendrait la liste figée qu'il remplace.
  function collectionAvecUneVedette() {
    const out = collection() as (ThemedItem & { id: number })[];
    // Notée au-dessus de tout, et dans les deux genres : elle sortirait chaque jour.
    out.push(film(9.9, ["Thriller", "Comedy"], 1995));
    return out;
  }

  const idDe = (i: ThemedItem & { id: number }) => i.id;

  it("met au repos un titre sorti les trois jours précédents", () => {
    const items = collectionAvecUneVedette();
    const vedette = items[items.length - 1].id;
    const jours = ["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"];
    const sorties = jours.map((j) => dailyTop10(items, j, idDe).items.map(idDe));
    // Le dernier jour ne doit pas la reprendre si les trois précédents l'avaient.
    const troisAvant = sorties.slice(0, 3).every((s) => s.includes(vedette));
    if (troisAvant) expect(sorties[3]).not.toContain(vedette);
  });

  it("ne bannit personne sans moyen de reconnaître les titres", () => {
    // Sans clé, on ne peut pas suivre un titre d'un jour à l'autre : on ne prétend pas le faire.
    const items = collectionAvecUneVedette();
    expect(() => dailyTop10(items, "2026-09-22")).not.toThrow();
    expect(dailyTop10(items, "2026-09-22").items.length).toBeGreaterThan(0);
  });

  it("rend toujours dix titres malgré les exclusions", () => {
    const items = collectionAvecUneVedette();
    for (let j = 19; j <= 30; j++) {
      const { items: sortie } = dailyTop10(items, `2026-09-${j}`, idDe);
      expect(sortie.length).toBe(10);
    }
  });
});
