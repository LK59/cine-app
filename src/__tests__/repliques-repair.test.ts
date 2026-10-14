import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * La réparation en place de la base des répliques (DECISIONS.md §88, 14/10/2026) : le vocabulaire
 * recalculé depuis les répliques stockées — aucun film relu —, une fois par version, idempotente, par
 * tranches qui rendent la main. Et la connexion partagée par les copies du module.
 */

const dataDir = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const dir = mkdtempSync(`${tmpdir()}/repliques-repair-`);
  process.env.DATA_DIR = dir;
  return dir;
});

import {
  REPAIR_KEY,
  REPAIR_VERSION,
  REPLIQUES_DB_FILE,
  closeRepliquesDb,
  deleteFilmLines,
  readMeta,
  repairIndex,
  repliquesDb,
  wipeRepliquesDb,
  writeLines,
  writeMeta,
  type LineRow,
} from "@/lib/repliques/store";
import { normalizedText } from "@/lib/repliques/text";

const A = "a".repeat(32);
const B = "b".repeat(32);

function row(itemId: string, startMs: number, text: string): LineRow {
  return { itemId, radarrId: 1, lang: "fr", startMs, endMs: startMs + 1000, text, norm: normalizedText(text) };
}

/** Le vocabulaire tel qu'il devrait être : les mots des répliques stockées, comptés. */
function exactTerms(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const r of repliquesDb().prepare("SELECT norm FROM lines").all() as { norm: string }[]) {
    for (const w of r.norm.split(" ")) if (w) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return counts;
}

function storedTerms(): Map<string, number> {
  const rows = repliquesDb().prepare("SELECT term, n FROM terms").all() as { term: string; n: number }[];
  return new Map(rows.map((r) => [r.term, r.n]));
}

beforeEach(() => {
  wipeRepliquesDb();
});

describe("la réparation du vocabulaire", () => {
  it("une base neuve naît réparée : rien à refaire", async () => {
    repliquesDb();
    expect(readMeta<{ version: number }>(REPAIR_KEY)?.version).toBe(REPAIR_VERSION);
    expect(await repairIndex()).toBeNull();
  });

  it("recalcule les comptes faux, retire les mots sans réplique, ajoute ceux qui manquent — puis ne refait rien", async () => {
    await writeLines([row(A, 0, "Je suis ton père."), row(A, 1000, "Je suis là."), row(B, 0, "Personne ne bouge.")]);
    const db = repliquesDb();
    // Ce que l'ancien `deleteFilmLines` laissait : des mots comptés deux fois, un mot sans réplique.
    db.prepare("UPDATE terms SET n = n * 2 WHERE term IN ('je', 'suis')").run();
    db.prepare("INSERT INTO terms (term, n) VALUES ('fantome', 7)").run();
    db.prepare("DELETE FROM terms WHERE term = 'bouge'").run();
    // Une base écrite avant la réparation : pas de version.
    db.prepare("DELETE FROM meta WHERE key = ?").run(REPAIR_KEY);

    const report = await repairIndex();
    expect(report).toMatchObject({ version: REPAIR_VERSION, lines: 3, fixed: 2, removed: 1, added: 1 });
    expect(report!.totalBefore - report!.totalAfter).toBe(4 + 7 - 1);
    expect(storedTerms()).toEqual(exactTerms());
    expect(readMeta<{ version: number }>(REPAIR_KEY)?.version).toBe(REPAIR_VERSION);
    // Idempotente : la version est écrite, et la relancer après un arrêt en route refait le même calcul.
    expect(await repairIndex()).toBeNull();
    db.prepare("DELETE FROM meta WHERE key = ?").run(REPAIR_KEY);
    expect(await repairIndex()).toMatchObject({ fixed: 0, removed: 0, added: 0 });
    expect(storedTerms()).toEqual(exactTerms());
  });

  it("travaille par tranches qui rendent la main à la boucle", async () => {
    const rows = Array.from({ length: 30_000 }, (_, i) => row(A, i * 1000, `Ligne ${i} mot${i % 997} encore`));
    await writeLines(rows);
    repliquesDb().prepare("UPDATE terms SET n = n + 1").run();
    repliquesDb().prepare("DELETE FROM meta WHERE key = ?").run(REPAIR_KEY);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    const report = await repairIndex();
    clearInterval(timer);
    expect(report!.slices).toBeGreaterThan(3);
    expect(ticks).toBeGreaterThan(0);
    expect(storedTerms()).toEqual(exactTerms());
  });
});

describe("l'effacement d'un film", () => {
  // Jusqu'au 14/10/2026, les lignes partaient sans leurs mots : un film relu comptait ses mots deux fois.
  it("décompte ses mots, et un film relu ne gonfle plus le vocabulaire", async () => {
    const film = [row(A, 0, "Je suis ton père."), row(A, 1000, "Nooon.")];
    await writeLines([...film, row(B, 0, "Je suis là.")]);
    const before = storedTerms();
    await deleteFilmLines(A);
    expect(storedTerms().get("je")).toBe(1);
    expect(storedTerms().has("nooon")).toBe(false);
    await writeLines(film);
    expect(storedTerms()).toEqual(before);
    expect(storedTerms()).toEqual(exactTerms());
  });
});

// Next charge ce module deux fois (le moteur et les routes) : « Reconstruire » depuis la page fermait
// la connexion des routes et supprimait le fichier, et celle du moteur restait ouverte sur le fichier
// supprimé — la passe suivante écrivait dans un fichier que plus personne ne voyait.
describe("une seule connexion pour tout le serveur", () => {
  it("une copie du module voit la base reconstruite par l'autre, et les mêmes mesures", async () => {
    const first = await import("@/lib/repliques/store");
    first.writeMeta("avant", 1);
    vi.resetModules();
    const second = await import("@/lib/repliques/store");
    expect(second.writeStats).toBe(first.writeStats);
    second.wipeRepliquesDb();
    // La première copie rouvre le nouveau fichier : l'ancien contenu n'y est plus…
    expect(first.readMeta("avant")).toBeNull();
    first.writeMeta("apres", 2);
    // … et ce qu'elle écrit, l'autre le lit, dans le fichier qui existe.
    expect(second.readMeta("apres")).toBe(2);
    expect(fs.existsSync(path.join(dataDir, REPLIQUES_DB_FILE))).toBe(true);
    closeRepliquesDb();
    writeMeta("encore", 3);
    expect(second.readMeta("encore")).toBe(3);
  });
});
