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
import { corrections, editDistance, searchDialogue, dialogueIndexHasLines } from "@/lib/repliques/search";
import { normalizedText } from "@/lib/repliques/text";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

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
    await deleteFilmLines("d".repeat(32));
    expect(repliquesDb().prepare("SELECT COUNT(*) AS n FROM lines WHERE item_id = ?").get("d".repeat(32))).toEqual({ n: 0 });
    // L'index plein texte suit : plus rien ne répond.
    expect(searchDialogue("ligne numero").films).toEqual([]);
  });
});
