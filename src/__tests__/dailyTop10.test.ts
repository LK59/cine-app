import { describe, it, expect } from "vitest";
import { dailyTop10, dayKey, themeKey, themeOfDay, type ThemedItem, type Top10Theme, type Top10Memory } from "@/lib/cinemaRails";

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


/**
 * Le palmarès ne doit pas bouger parce que le serveur a redémarré.
 *
 * Signalé à l'usage, et la cause n'était pas le redémarrage lui-même : le tirage se déduisait de
 * la date *et du nombre de thèmes éligibles*, via un modulo. Or un catalogue construit pendant
 * que Jellyfin finit de démarrer est amputé — moins de titres, moins de genres assez fournis — et
 * un seul thème en plus ou en moins redistribuait tous les jours à la fois.
 */
describe("le palmarès du jour — une bibliothèque qui bouge", () => {
  const JOUR = "2026-09-19";

  /** La même collection, plus un genre entier qui vient de franchir la barre des dix titres. */
  function pluslarge(): ThemedItem[] {
    const out = collection();
    for (let i = 0; i < 12; i++) out.push(film(4 + i * 0.1, ["Western"], 1975));
    return out;
  }

  it("garde le même thème quand un genre entre dans la liste sans gagner", () => {
    const avant = themeOfDay(collection(), JOUR)!;
    const apres = themeOfDay(pluslarge(), JOUR)!;
    // Le nouveau venu ne peut changer la journée que s'il l'emporte vraiment. Ici il ne l'emporte
    // pas — et avec un modulo, il aurait tout décalé.
    if (themeKey(apres) !== "g:Western" && themeKey(apres) !== "d:1970") {
      expect(themeKey(apres)).toBe(themeKey(avant));
    }
  });

  // La propriété qui compte vraiment, vérifiée sur un mois : ajouter des titres ne doit presque
  // jamais changer la journée, là où le modulo la changeait presque toujours.
  it("ne change presque jamais de thème quand la collection grandit", () => {
    let changes = 0;
    for (let d = 1; d <= 28; d++) {
      const jour = `2026-09-${String(d).padStart(2, "0")}`;
      if (themeKey(themeOfDay(collection(), jour)!) !== themeKey(themeOfDay(pluslarge(), jour)!)) changes++;
    }
    // Deux thèmes nouveaux sur six : au pire un tiers des jours, jamais la totalité.
    expect(changes).toBeLessThan(14);
  });

  it("donne toujours la même réponse pour une date donnée", () => {
    expect(themeKey(themeOfDay(collection(), JOUR)!)).toBe(themeKey(themeOfDay(collection(), JOUR)!));
  });
});

/**
 * Et la garantie dure, elle, ne se déduit de rien : elle se retient.
 *
 * Le tirage pondéré est robuste, pas inviolable — si le thème gagnant passe lui-même sous la barre
 * des dix titres, un autre gagne. La première réponse de la journée fait donc foi.
 */
describe("le palmarès du jour — la mémoire", () => {
  const JOUR = "2026-09-19";

  function memoire(): Top10Memory & { rows: Map<string, Top10Theme | null> } {
    const rows = new Map<string, Top10Theme | null>();
    return {
      rows,
      recall: (day) => (rows.has(day) ? rows.get(day)! : undefined),
      // Le premier a raison : c'est exactement ce que fait le DO NOTHING de la table.
      remember: (day, theme) => { if (!rows.has(day)) rows.set(day, theme); },
    };
  }

  it("retient le thème du jour à la première réponse", () => {
    const m = memoire();
    const { theme } = dailyTop10(collection(), JOUR, (i) => (i as unknown as { id: number }).id, m);
    expect(m.rows.get(JOUR)).toEqual(theme);
  });

  it("le rejoue tel quel même si la bibliothèque a changé entre-temps", () => {
    const m = memoire();
    const premier = dailyTop10(collection(), JOUR, (i) => (i as unknown as { id: number }).id, m).theme!;

    // Le pire cas réel : Jellyfin démarre encore, le catalogue arrive amputé du genre gagnant.
    const ampute = collection().filter((i) => !i.genres!.includes(premier.kind === "genre" ? premier.genre : "—"));
    const second = dailyTop10(ampute, JOUR, (i) => (i as unknown as { id: number }).id, m).theme!;
    expect(themeKey(second)).toBe(themeKey(premier));
  });

  // Elle n'invente pas d'histoire : les jours passés qu'elle n'a pas vécus sont recalculés, pas
  // écrits — une première installation les fabriquerait tous.
  it("n'écrit que le jour demandé", () => {
    const m = memoire();
    dailyTop10(collection(), JOUR, (i) => (i as unknown as { id: number }).id, m);
    expect([...m.rows.keys()]).toEqual([JOUR]);
  });
});

/**
 * Et surtout : ne pas figer une panne.
 *
 * Vérifié sur la production au premier déploiement — la ligne du jour avait été écrite *vide*,
 * c'est-à-dire qu'un catalogue trop maigre pour porter un thème venait de s'installer pour
 * vingt-quatre heures. « Le premier a raison » n'est vrai que si le premier sait de quoi il parle.
 */
describe("le palmarès du jour — ne pas retenir une réponse malade", () => {
  const JOUR = "2026-09-19";

  function memoire(): Top10Memory & { rows: Map<string, Top10Theme | null> } {
    const rows = new Map<string, Top10Theme | null>();
    return {
      rows,
      recall: (day) => (rows.has(day) ? rows.get(day)! : undefined),
      remember: (day, theme) => { if (!rows.has(day)) rows.set(day, theme); },
    };
  }

  it("n'écrit rien quand la bibliothèque ne porte aucun thème", () => {
    const m = memoire();
    // Trois films : aucun genre n'atteint les dix titres, donc aucun thème éligible.
    const maigre = [film(7, ["Thriller"], 1995), film(6, ["Comedy"], 2015), film(5, ["Thriller"], 1995)];
    const { theme } = dailyTop10(maigre, JOUR, (i) => (i as unknown as { id: number }).id, m);
    expect(theme).toBeNull();
    expect(m.rows.size).toBe(0);
  });

  // Et la journée reste ouverte : la première réponse saine l'emporte et devient celle de tous.
  it("retient la première réponse saine, même si une malade l'a précédée", () => {
    const m = memoire();
    dailyTop10([film(7, ["Thriller"], 1995)], JOUR, (i) => (i as unknown as { id: number }).id, m);
    expect(m.rows.size).toBe(0);

    const { theme } = dailyTop10(collection(), JOUR, (i) => (i as unknown as { id: number }).id, m);
    expect(m.rows.get(JOUR)).toEqual(theme);
  });
});
