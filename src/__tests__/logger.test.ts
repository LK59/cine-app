import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Le journal des erreurs du serveur. Ce qu'il doit garantir n'est pas son format mais sa
// survie : le conteneur est recréé à chaque déploiement, plusieurs fois par jour, et une erreur
// rencontrée le soir avait disparu avant qu'on la cherche.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cine-server-log-"));
  vi.resetModules();
  vi.doMock("@/lib/dataDir", () => ({ DATA_DIR: dir }));
});

afterEach(() => {
  vi.doUnmock("@/lib/dataDir");
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function lines(): Record<string, unknown>[] {
  const file = path.join(dir, "logs", "server.log");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("logError", () => {
  it("writes a single JSON line to console.error with the expected fields", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { logError } = await import("@/lib/logger");
    logError("watchlist", new Error("boom"), { status: 502 });

    expect(spy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.level).toBe("error");
    expect(parsed.scope).toBe("watchlist");
    expect(parsed.message).toBe("boom");
    expect(parsed.status).toBe(502);
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("stringifies non-Error values", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { logError } = await import("@/lib/logger");
    logError("scope", "plain string error");
    const parsed = JSON.parse(spy.mock.calls[0][0] as string);
    expect(parsed.message).toBe("plain string error");
  });

  it("garde la même erreur sur disque, où un redéploiement ne l'efface pas", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { logError } = await import("@/lib/logger");
    logError("jellyfin", new Error("502 depuis l'amont"), { itemId: "abc" });

    const [entry] = lines();
    expect(entry.scope).toBe("jellyfin");
    expect(entry.message).toBe("502 depuis l'amont");
    expect(entry.itemId).toBe("abc");
  });

  it("porte la pile sur disque, et elle seule", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { logError } = await import("@/lib/logger");
    logError("radarr", new Error("boom"));

    // Ce qui distingue « l'amont a refusé » de « on l'a appelé depuis un endroit qu'on ne
    // soupçonnait pas » — et ce qui encombrerait la console qu'on lit en direct.
    expect(JSON.parse(spy.mock.calls[0][0] as string).stack).toBeUndefined();
    expect(String(lines()[0].stack)).toContain("Error: boom");
  });

  it("ne fait pas échouer l'appelant quand le disque refuse", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      throw new Error("disque plein");
    });
    const { logError } = await import("@/lib/logger");
    // Signaler qu'on n'a pas pu écrire une erreur ne peut se faire qu'en écrivant une erreur.
    expect(() => logError("scope", new Error("boom"))).not.toThrow();
  });
});
