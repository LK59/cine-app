import { describe, it, expect, beforeAll, vi } from "vitest";

/**
 * Chercher dans l'index des répliques (DECISIONS.md §88) : accents et casse ignorés, fautes de
 * frappe rattrapées, expression exacte devant, films cachés retirés dans la requête, écritures par
 * tranches qui rendent la main à la boucle.
 */

vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/repliques-search-`);
});

import { writeLines, writeStats, deleteFilmLines, repliquesDb, type LineRow } from "@/lib/repliques/store";
import { corrections, editDistance, searchDialogue, dialogueIndexHasLines, splits, TOO_COMMON } from "@/lib/repliques/search";
import { normalizedText } from "@/lib/repliques/text";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const D = "d".repeat(31) + "1";
const E = "e".repeat(32);
const F = "f".repeat(32);

function row(itemId: string, radarrId: number, startMs: number, text: string, lang = "fr"): LineRow {
  return { itemId, radarrId, lang, startMs, endMs: startMs + 2000, text, norm: normalizedText(text) };
}

beforeAll(async () => {
  expect(dialogueIndexHasLines()).toBe(false);
  await writeLines([
    row(A, 1, 10_000, "Non. Je suis ton père."),
    row(A, 1, 20_000, "Le Cœur a ses raisons."),
    row(A, 1, 30_000, "Personne ne bouge !"),
    row(B, 2, 5_000, "Ton père et moi, je suis sûr qu'il viendra."),
    row(B, 2, 6_000, "On va avoir besoin d'un plus gros bateau."),
    row(C, 3, 7_000, "Je suis ton père, Luke.", "fr"),
    row(C, 3, 8_000, "Roads? Where we’re going, we don't need roads.", "en"),
    row(C, 3, 9_000, "Merci pour l'avancement du dossier.", "fr"),
    row(B, 2, 9_000, "Le livre dont je parle.", "fr"),
    // Une phrase coupée entre deux sous-titres.
    row(D, 4, 40_000, "Maman disait toujours que la vie", "fr"),
    row(D, 4, 42_500, "c'est comme une boîte de chocolats.", "fr"),
    // « the » partout, et « isn't he » : la coupure « t he » ne doit pas passer pour « the ».
    ...Array.from({ length: 6 }, (_, i) => row(E, 5, 100_000 + i * 10_000, `The answer number ${i}.`, "en")),
    row(E, 5, 200_000, "Isn't he coming?", "en"),
    // Le même moment en deux langues, et une réplique écrite en double.
    row(F, 6, 1_000, "Le soleil se lève.", "fr"),
    row(F, 6, 1_200, "Le soleil se lève.", "en"),
    row(F, 6, 60_000, "Encore le soleil.", "fr"),
    row(F, 6, 60_000, "Encore le soleil.", "fr"),
  ]);
});

describe("la recherche", () => {
  it("ignore les accents et la casse, dans les deux sens", () => {
    expect(searchDialogue("JE SUIS TON PERE").films.map((f) => f.itemId)).toContain(A);
    expect(searchDialogue("coeur").films[0]?.lines[0].text).toBe("Le Cœur a ses raisons.");
    expect(searchDialogue("cœur").films[0]?.itemId).toBe(A);
  });

  it("met devant l'expression exacte plutôt que les mêmes mots dans le désordre", () => {
    const films = searchDialogue("je suis ton père").films.map((f) => f.itemId);
    expect(films.indexOf(B)).toBeGreaterThan(films.indexOf(A));
    expect(films.indexOf(B)).toBeGreaterThan(films.indexOf(C));
  });

  it("rattrape une faute de frappe par le vocabulaire", () => {
    expect(editDistance("persone", "personne", 2)).toBe(1);
    expect(editDistance("presonne", "personne", 2)).toBe(1);
    expect(corrections("persone")).toContain("personne");
    const result = searchDialogue("persone ne bouge");
    expect(result.films.map((f) => f.itemId)).toEqual([A]);
    expect(result.terms).toContain("personne");
  });

  // L'apostrophe devient une espace à l'index : « dont », « lavancement » tapés collés (14/10/2026).
  it("retrouve un mot à apostrophe tapé collé, sans perdre le mot français « dont »", () => {
    expect(searchDialogue("we dont need roads").films.map((f) => f.itemId)).toContain(C);
    expect(searchDialogue("we don't need roads").films.map((f) => f.itemId)).toContain(C);
    for (const q of ["l'avancement du dossier", "l avancement du dossier", "lavancement du dossier"]) {
      expect(searchDialogue(q).films.map((f) => f.itemId), q).toContain(C);
    }
    expect(searchDialogue("le livre dont je parle").films[0]?.itemId).toBe(B);
  });

  it("prend le dernier mot comme un début de mot", () => {
    const result = searchDialogue("plus gros bate");
    expect(result.films.map((f) => f.itemId)).toEqual([B]);
    expect(result.prefixes).toEqual(["bate"]);
  });

  it("retire les films cachés au compte, dans la requête", () => {
    expect(searchDialogue("je suis ton pere", { hidden: [A, C] }).films.map((f) => f.itemId)).toEqual([B]);
  });

  it("rend toutes les répliques d'un film pour « voir plus »", () => {
    const result = searchDialogue("je suis", { itemId: A, perFilm: 30 });
    expect(result.films.map((f) => f.itemId)).toEqual([A]);
  });

  // Mesuré sur l'index réel (14/10/2026) : « the » ramenait d'abord « ain't he », « isn't he ».
  it("ne coupe pas un mot courant en deux morceaux qui le singent", () => {
    expect(splits("the")).toEqual([]);
    expect(splits("dont")).toContainEqual({ left: "don", right: "t" });
    expect(searchDialogue("the answer").films.map((f) => f.itemId)).toEqual([E]);
    const isnt = searchDialogue("isnt he").films;
    expect(isnt.map((f) => f.itemId)).toEqual([E]);
    expect(isnt[0].lines.map((l) => l.text)).toEqual(["Isn't he coming?"]);
  });

  it("retrouve une phrase coupée entre deux sous-titres", () => {
    const result = searchDialogue("toujours que la vie c'est comme une boite");
    expect(result.films.map((f) => f.itemId)).toEqual([D]);
    expect(result.films[0].lines[0]).toMatchObject({ startMs: 40_000, endMs: 44_500, text: "Maman disait toujours que la vie\nc'est comme une boîte de chocolats." });
    expect(result.approximate).toBeUndefined();
  });

  it("rend les plus proches, marquées, quand aucune réplique n'a tous les mots", () => {
    const result = searchDialogue("le coeur a toujours ses raisons");
    expect(result.approximate).toBe(true);
    expect(result.films[0].lines[0].text).toBe("Le Cœur a ses raisons.");
    // Une seule réplique répond : rien d'approchant n'est ajouté à une recherche qui trouve.
    expect(searchDialogue("le coeur a ses raisons").approximate).toBeUndefined();
  });

  it("cherche les mots entre guillemets tels quels et à la suite", () => {
    expect(searchDialogue('"ses raisons"').films.map((f) => f.itemId)).toEqual([A]);
    expect(searchDialogue('"raisons ses"').films).toEqual([]);
    // Sans guillemets, la faute est rattrapée ; entre guillemets, non.
    expect(searchDialogue("persone ne bouge").films).toHaveLength(1);
    expect(searchDialogue('"persone ne bouge"').films).toEqual([]);
  });

  it("compte un moment une fois : deux langues du même instant, ou une réplique écrite deux fois", () => {
    const film = searchDialogue("soleil").films.find((f) => f.itemId === F)!;
    expect(film.lines.map((l) => l.text)).toEqual(expect.arrayContaining(["Le soleil se lève.", "Encore le soleil."]));
    expect(film.lines).toHaveLength(2);
    expect(film.more).toBe(0);
  });

  it("ne cherche pas une question faite des mots les plus courants", () => {
    repliquesDb().prepare("INSERT INTO terms (term, n) VALUES ('courantissime', ?)").run(TOO_COMMON + 1);
    expect(searchDialogue("courantissime")).toMatchObject({ films: [], tooCommon: true });
    // Avec un mot plus rare, la question a un sens : elle est cherchée.
    expect(searchDialogue("courantissime soleil").tooCommon).toBeUndefined();
  });

  // `for (let k = 1; …)` masquait le facteur d'échelle `k` : à la deuxième coupure, le seuil valait
  // deux fois `TOO_COMMON`, et une moitié faite d'un seul mot très courant était cherchée (14/10/2026).
  it("garde le même seuil de mot courant à chaque coupure d'une phrase entre deux sous-titres", async () => {
    const G = "9".repeat(32);
    await writeLines([row(G, 7, 300_000, "Zorglub brandouille"), row(G, 7, 301_000, "frimousse")]);
    // Plus courant que le seuil, moins que deux fois le seuil.
    repliquesDb().prepare("UPDATE terms SET n = ? WHERE term = 'frimousse'").run(Math.round(TOO_COMMON * 1.5));
    const result = searchDialogue("zorglub brandouille frimousse");
    // La coupure qui isolerait « frimousse » n'est pas tentée : la réponse est approchée, pas la phrase.
    expect(result.approximate).toBe(true);
    expect(result.films[0].lines[0].text).toBe("Zorglub brandouille");
  });

  it("ne lève pas sur une requête faite de ponctuation, ni sur des guillemets", () => {
    expect(searchDialogue("!!! ???").films).toEqual([]);
    expect(() => searchDialogue('je "suis" ton')).not.toThrow();
  });
});

describe("les écritures", () => {
  it("écrivent par tranches et rendent la main à la boucle entre deux", async () => {
    const rows = Array.from({ length: 3000 }, (_, i) => row("d".repeat(32), 4, i * 1000, `Ligne numéro ${i} du film`));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    const slicesBefore = writeStats.slices;
    await writeLines(rows);
    clearInterval(timer);
    expect(writeStats.slices - slicesBefore).toBeGreaterThan(1);
    // La boucle a tourné pendant l'écriture : d'autres tâches ont eu leur tour.
    expect(ticks).toBeGreaterThan(0);
    const term = (word: string) => (repliquesDb().prepare("SELECT n FROM terms WHERE term = ?").get(word) as { n: number } | undefined)?.n;
    const duBefore = term("du")!;
    await deleteFilmLines("d".repeat(32));
    expect(repliquesDb().prepare("SELECT COUNT(*) AS n FROM lines WHERE item_id = ?").get("d".repeat(32))).toEqual({ n: 0 });
    // Le vocabulaire suit (14/10/2026 : il ne décomptait rien, et chaque film relu gonflait ses mots) :
    // un mot qui n'est plus dans aucune réplique en sort, un mot partagé perd ce qui est parti.
    expect(term("numero")).toBeUndefined();
    expect(term("du")).toBe(duBefore - 3000);
    // L'index plein texte suit : plus rien ne répond.
    expect(searchDialogue("ligne numero").films).toEqual([]);
  });
});
