import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Une erreur née dans le navigateur, écrite au journal du serveur. Tout vient du client : c'est
// lui qui déciderait de la place prise sur disque si rien n'était coupé.

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cine-client-log-"));
  vi.resetModules();
  vi.doMock("@/lib/dataDir", () => ({ DATA_DIR: dir }));
  vi.spyOn(console, "error").mockImplementation(() => {});
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

describe("logClientError", () => {
  it("écrit une ligne `client` au nom du compte, avec sa pile sur une ligne", async () => {
    const { logClientError } = await import("@/lib/logger");
    logClientError("mathis", {
      source: "component:lecteur",
      name: "TypeError",
      message: "Cannot read properties of null",
      url: "/#film=12",
      stack: "TypeError: Cannot read\n    at a (x.js:1)\n    at b (y.js:2)",
    });

    const [entry] = lines();
    expect(entry).toMatchObject({
      level: "error",
      scope: "client",
      user: "mathis",
      source: "component:lecteur",
      message: "Cannot read properties of null",
      url: "/#film=12",
    });
    expect(entry.stack).toBe("TypeError: Cannot read | at a (x.js:1) | at b (y.js:2)");
  });

  it("ne laisse passer que les champs connus, et les coupe", async () => {
    const { logClientError } = await import("@/lib/logger");
    logClientError("mathis", { message: "m".repeat(5000), user: "louis", level: "info", scope: "faux", nested: { a: 1 } });

    const [entry] = lines();
    expect(entry.user).toBe("mathis");
    expect(entry.scope).toBe("client");
    expect(entry.level).toBe("error");
    expect((entry.message as string).length).toBe(500);
    expect(entry.nested).toBeUndefined();
  });

  it("n'écrit pas une ligne vide quand il n'y a pas de message", async () => {
    const { logClientError } = await import("@/lib/logger");
    logClientError("mathis", {});
    expect(lines()[0].message).toBe("(sans message)");
  });
});
