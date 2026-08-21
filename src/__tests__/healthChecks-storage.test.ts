import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, afterAll, vi } from "vitest";

const { TMP_DIR, MOVIES, MISSING } = vi.hoisted(() => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cine-health-storage-test-"));
  const movies = path.join(tmpDir, "movies");
  const missing = path.join(tmpDir, "does-not-exist");
  fs.mkdirSync(movies);
  fs.writeFileSync(path.join(movies, "a.mkv"), "");
  fs.writeFileSync(path.join(movies, "b.mkv"), "");
  return { TMP_DIR: tmpDir, MOVIES: movies, MISSING: missing };
});

vi.mock("@/lib/media-paths", () => ({
  MEDIA_ROOT: TMP_DIR,
  MOVIES_PATH: MOVIES,
  TV_PATH: MISSING,
  SEEDS_PATH: MISSING,
  SEED_MOVIES_PATH: MISSING,
  SEED_TV_PATH: MISSING,
  CROSS_SEED_PATH: MISSING,
}));

import { checkAllStoragePaths, type StoragePathHealth } from "@/lib/healthChecks";

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("checkAllStoragePaths", () => {
  it("reports ok with an entry count for a readable directory", async () => {
    const results = await checkAllStoragePaths();
    const movies = results.find((r: StoragePathHealth) => r.name === "movies");
    expect(movies).toMatchObject({ status: "ok", entries: 2, error: null });
  });

  it("reports down with notFound for a required path that doesn't exist", async () => {
    const results = await checkAllStoragePaths();
    const tv = results.find((r: StoragePathHealth) => r.name === "tv");
    expect(tv).toMatchObject({ status: "down", entries: null, error: "notFound" });
  });

  it("reports ok (not down) when the optional cross-seed path is missing", async () => {
    const results = await checkAllStoragePaths();
    const crossSeed = results.find((r: StoragePathHealth) => r.name === "crossSeed");
    expect(crossSeed).toMatchObject({ status: "ok", entries: null, error: null });
  });
});
