import { describe, it } from "vitest";
import Database from "better-sqlite3";

/**
 * Le banc de la **recherche** de répliques (DECISIONS.md §88) — sauté sans base.
 *
 *   REPLIQUES_SEARCH_DIR=<dossier tenant une COPIE de repliques.db> [REPLIQUES_SEARCH_RUNS=5]
 *   [REPLIQUES_SEARCH_QUERIES=<une requête par ligne>]
 *
 * Jamais la base de la production : `repliquesDb()` l'ouvre en écriture (WAL, migrations). Copiez-la
 * d'abord (une sauvegarde SQLite d'une connexion en lecture seule, l'indexation peut tourner).
 *
 * Pour chaque requête : les cinq premiers films (titre, meilleure réplique), le nombre de films, et
 * le temps de `searchDialogue` — p50/p95 sur toutes les requêtes répétées. C'est ce banc qui a mesuré
 * les défauts corrigés le 14/10/2026 (réplique coupée entre deux sous-titres, « voir plus » compté en
 * double, bonus d'expression perdu sur une faute).
 */
const DEFAULT_QUERIES = [
  "hasta la vista baby",
  "hasta la vista bayby",
  "i'll be back",
  "ill be back",
  "why so serious",
  "life is like a box of chocolates",
  "life was like a box of chocolates you never know what you're gonna get",
  "la vie c'est comme une boîte de chocolats",
  "la vie cest comme une boite de chocolat",
  "the first rule of fight club",
  "what's in the box",
  "WHAT'S IN THE BOX?!",
  "whats in the box",
  "yippee ki yay",
  "yippeekiyay",
  "open the pod bay doors",
  "where we're going we don't need roads",
  "roads where going need",
  '"box of chocolates"',
  "je suis",
  "je",
  "the",
  "i love you",
  "je t'aime",
  "persone ne bouge",
  "personne ne bouge",
  "2001",
  "deux mille",
  "week end",
  "weekend",
  "any where",
  "NEAR(a b) OR * - ^ : \" ' (",
  "",
  "a",
  "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five",
];

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

describe.skipIf(!process.env.REPLIQUES_SEARCH_DIR)("répliques — recherche sur l'index réel", () => {
  it("cherche et mesure", async () => {
    process.env.DATA_DIR = process.env.REPLIQUES_SEARCH_DIR;
    const { searchDialogue } = await import("@/lib/repliques/search");
    const { repliquesDb } = await import("@/lib/repliques/store");
    const fs = await import("node:fs");
    const queries = process.env.REPLIQUES_SEARCH_QUERIES
      ? fs.readFileSync(process.env.REPLIQUES_SEARCH_QUERIES, "utf8").split("\n").filter((l) => l.trim())
      : DEFAULT_QUERIES;
    const db: Database.Database = repliquesDb();
    const titles = new Map((db.prepare("SELECT item_id, title FROM films").all() as { item_id: string; title: string }[]).map((r) => [r.item_id, r.title]));
    const total = (db.prepare("SELECT count(*) AS n FROM lines").get() as { n: number }).n;
    console.log(`index : ${total} répliques, ${titles.size} films`);
    const runs = Number(process.env.REPLIQUES_SEARCH_RUNS ?? 5);
    const all: number[] = [];
    for (const q of queries) {
      const times: number[] = [];
      let result = searchDialogue(q);
      for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        result = searchDialogue(q);
        times.push(performance.now() - t0);
      }
      all.push(...times);
      const top = result.films
        .slice(0, 5)
        .map((f) => `    ${titles.get(f.itemId) ?? f.itemId} (+${f.more}) — [${f.lines[0]?.lang}] ${f.lines[0]?.text.replace(/\n/g, " / ")}`)
        .join("\n");
      console.log(`« ${q.slice(0, 80)} » : ${result.films.length} films, ${percentile(times, 50).toFixed(1)} ms (max ${Math.max(...times).toFixed(1)}) — termes ${result.terms.slice(0, 12).join(",")}\n${top}`);
    }
    console.log(`TOUTES : p50 ${percentile(all, 50).toFixed(1)} ms, p95 ${percentile(all, 95).toFixed(1)} ms, max ${Math.max(...all).toFixed(1)} ms`);
  }, 600_000);
});
