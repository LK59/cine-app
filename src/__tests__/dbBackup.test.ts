import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cine-db-backup-test-"));

vi.mock("@/lib/db", async () => {
  const actualPath = await import("path");
  const Database = (await import("better-sqlite3")).default;
  const dbPath = actualPath.join(TMP_DIR, "cine.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE t (id INTEGER)");
  return { getDb: () => db, DATA_DIR: TMP_DIR };
});

const mockLogError = vi.fn();
vi.mock("@/lib/logger", () => ({ logError: (...args: unknown[]) => mockLogError(...args) }));

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

const BACKUP_DIR = path.join(TMP_DIR, "backups");

beforeEach(() => {
  vi.clearAllMocks();
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
});

describe("runDbBackup", () => {
  it("writes a dated backup file", async () => {
    const { runDbBackup } = await import("@/lib/dbBackup");
    await runDbBackup();
    const files = fs.readdirSync(BACKUP_DIR);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^cine-\d{4}-\d{2}-\d{2}\.db$/);
  });

  it("keeps only the 7 most recent backups", async () => {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    for (let i = 1; i <= 9; i++) {
      fs.writeFileSync(path.join(BACKUP_DIR, `cine-2026-01-0${i}.db`), "x");
    }
    const { runDbBackup } = await import("@/lib/dbBackup");
    await runDbBackup();
    const files = fs.readdirSync(BACKUP_DIR).sort();
    expect(files).toHaveLength(7);
    // The 2 oldest (01, 02) plus today's own slot get pruned down to the 7 most recent.
    expect(files).not.toContain("cine-2026-01-01.db");
    expect(files).not.toContain("cine-2026-01-02.db");
  });

  it("logs instead of throwing when the backup destination isn't writable", async () => {
    // A plain file sitting where a directory is expected makes mkdirSync (and thus the
    // whole backup) fail — verifies runDbBackup swallows the error instead of throwing.
    fs.writeFileSync(BACKUP_DIR, "not a directory");
    const { runDbBackup } = await import("@/lib/dbBackup");
    await expect(runDbBackup()).resolves.toBeUndefined();
    expect(mockLogError).toHaveBeenCalledWith("db.backup", expect.anything());
    fs.rmSync(BACKUP_DIR, { force: true });
  });
});
