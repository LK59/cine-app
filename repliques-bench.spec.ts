import { describe, it } from "vitest";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

/**
 * Le banc de la recherche de répliques (DECISIONS.md §88) — sauté sans liste de films.
 *
 *   REPLIQUES_BENCH_LIST=<fichier : un chemin de film par ligne> [REPLIQUES_BENCH_LIMIT=20]
 *   [REPLIQUES_BENCH_LANGS=fr,en] [REPLIQUES_BENCH_OUT=<json>]
 *
 * Pour chaque film : d'où viennent ses répliques (fichier à côté, index, lecture complète), combien
 * d'octets et de lectures elles ont coûté. Puis la taille de la base telle que l'application l'écrit
 * (FTS5 `unicode61 remove_diacritics 2` sur le texte normalisé, vocabulaire), **et** la même avec une
 * table trigramme en plus — la mesure qui a décidé de ne pas la garder —, et le temps de quelques
 * recherches. Les fichiers sont seulement lus : la base est écrite dans un dossier temporaire.
 */
describe.skipIf(!process.env.REPLIQUES_BENCH_LIST)("répliques — coût et taille", () => {
  it("indexe un échantillon et mesure", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "repliques-bench-"));
    process.env.DATA_DIR = dataDir;
    const { listSidecars } = await import("@/lib/repliques/sidecar");
    const { indexFilm } = await import("@/lib/repliques/indexFilm");
    const store = await import("@/lib/repliques/store");
    const langs = (process.env.REPLIQUES_BENCH_LANGS ?? "fr,en").split(",");
    const files = readFileSync(process.env.REPLIQUES_BENCH_LIST!, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .slice(0, Number(process.env.REPLIQUES_BENCH_LIMIT ?? 20));
    const report: unknown[] = [];
    let totalRows = 0;
    // Le retard de la boucle d'événements pendant toute l'indexation : ce que la page verrait.
    let lag = 0;
    let last = performance.now();
    const lagTimer = setInterval(() => {
      const now = performance.now();
      lag = Math.max(lag, now - last - 10);
      last = now;
    }, 10);
    let n = 0;
    for (const file of files) {
      const t0 = performance.now();
      try {
        const sidecars = await listSidecars(file);
        const result = await indexFilm({ itemId: `bench${n}`, radarrId: n, title: file, file, languages: langs, sidecars });
        await store.writeLines(result.rows);
        totalRows += result.rows.length;
        const line = { file: file.split("/").pop(), rows: result.rows.length, sources: result.sources.map((s) => `${s.lang}:${s.kind}${s.codec ? ":" + s.codec : ""}:${s.lines}`), bytes: result.bytesRead, reads: result.reads, ms: Math.round(performance.now() - t0) };
        report.push(line);
        if (process.env.REPLIQUES_BENCH_VERIFY && /\.mkv$/i.test(file)) {
          // Par l'index contre lecture complète, sur les mêmes pistes : mêmes instants, mêmes textes.
          const { FileByteSource, SCAN_CHUNK } = await import("@/lib/repliques/fileSource");
          const { openMatroskaText, readTextTracks } = await import("@/lib/repliques/mkvText");
          const src = await FileByteSource.open(file);
          const text = await openMatroskaText(src);
          const numbers = result.sources.filter((x) => x.kind === "cues").map((x) => x.track!);
          const viaCues = await readTextTracks(src, text, numbers, async () => src);
          const scanned = await readTextTracks(src, { ...text, tracks: text.tracks.map((t) => ({ ...t, indexed: 0 })) }, numbers, () => FileByteSource.open(file, { chunkBytes: SCAN_CHUNK, maxChunks: 4 }));
          for (const n of numbers) {
            const a = (viaCues.lines.get(n) ?? []).map((l) => `${l.startMs}|${l.endMs}|${l.text}`);
            const b = (scanned.lines.get(n) ?? []).map((l) => `${l.startMs}|${l.endMs}|${l.text}`);
            const same = a.length === b.length && a.every((x, i) => x === b[i]);
            console.log(JSON.stringify({ verify: file.split("/").pop(), track: n, cues: a.length, scan: b.length, identical: same, firstDiff: same ? null : [a.find((x, i) => x !== b[i]), b.find((x, i) => x !== a[i])] }));
          }
          src.close();
        }
        console.log(JSON.stringify(line));
      } catch (error) {
        console.log(JSON.stringify({ file, error: String(error) }));
      }
      n++;
    }
    clearInterval(lagTimer);
    const conn = store.repliquesDb();
    conn.pragma("wal_checkpoint(TRUNCATE)");
    conn.exec("VACUUM");
    const size = (c: Database.Database) => (c.pragma("page_count", { simple: true }) as number) * (c.pragma("page_size", { simple: true }) as number);
    const base = size(conn);
    const textBytes = (conn.prepare("SELECT SUM(LENGTH(text)) AS t, SUM(LENGTH(norm)) AS n FROM lines").get() as { t: number; n: number });
    const timings: Record<string, number> = {};
    const { searchDialogue } = await import("@/lib/repliques/search");
    for (const q of ["je suis ton pere", "on va avoir besoin d'un plus gros bateau", "i'll be back", "bonjour", "je t'aime", "persone ne bouge", "what are you doing here"]) {
      const t1 = performance.now();
      const res = searchDialogue(q, {});
      timings[q] = Math.round((performance.now() - t1) * 10) / 10;
      console.log(q, "→", res.films.length, "films", res.films.slice(0, 2).map((f) => f.lines[0]?.text));
    }
    // La même base avec une table trigramme sur les lignes, pour comparer.
    conn.exec(`CREATE VIRTUAL TABLE lines_tri USING fts5(norm, content='lines', content_rowid='id', tokenize='trigram remove_diacritics 1');
               INSERT INTO lines_tri(lines_tri) VALUES('rebuild');`);
    conn.exec("VACUUM");
    const withTrigram = size(conn);
    const summary = { films: files.length, rows: totalRows, textBytes, base, withTrigram, perFilmBase: Math.round(base / Math.max(1, files.length)), perFilmTrigram: Math.round((withTrigram - base) / Math.max(1, files.length)), timings, writeStats: store.writeStats, maxLoopLagMs: Math.round(lag) };
    console.log(JSON.stringify(summary));
    if (process.env.REPLIQUES_BENCH_OUT) writeFileSync(process.env.REPLIQUES_BENCH_OUT, JSON.stringify({ report, summary }, null, 1));
  }, 3_600_000);
});
