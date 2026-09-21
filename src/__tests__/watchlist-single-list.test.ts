import { describe, it, expect, vi, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Une seule liste depuis le 21/09/2026. Ce que `migrate()` fait des anciens statuts, rejoué à
// chaque démarrage : c'est une écriture sur les données des comptes, elle doit être exacte.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cine-single-list-"));

afterAll(() => {
  vi.doUnmock("@/lib/dataDir");
  fs.rmSync(dir, { recursive: true, force: true });
});

async function freshDb() {
  vi.resetModules();
  vi.doMock("@/lib/dataDir", () => ({ DATA_DIR: dir }));
  return import("@/lib/db");
}

describe("la liste unique « À voir »", () => {
  it("garde les « à demander » et les favoris, et retire ce qui était vu ou abandonné", async () => {
    const first = await freshDb();
    const raw = first.getDb();
    const insert = raw.prepare(
      "INSERT INTO watchlist (user_id, media_type, tmdb_id, title, status, created_at, updated_at) VALUES ('u', 'movie', ?, ?, ?, 0, 0)"
    );
    insert.run(1, "Demandé", "to_request");
    insert.run(2, "Favori", "favorite");
    insert.run(3, "Vu", "watched");
    insert.run(4, "Abandonné", "abandoned");
    insert.run(5, "À voir", "to_watch");
    raw.close();

    // Un redémarrage : nouvelle connexion, donc `migrate()` rejoué.
    const second = await freshDb();
    const rows = second.watchlistDb.getAll("u");
    expect(rows.map((r) => r.title).sort()).toEqual(["Demandé", "Favori", "À voir"].sort());
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["to_watch"]));
  });

  it("supprime les deux tables que plus rien n'écrit", async () => {
    const { getDb } = await freshDb();
    const tables = (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).not.toContain("timeline_events");
    expect(tables).not.toContain("recommendations_hidden");
    getDb().close();
  });
});
