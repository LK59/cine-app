import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Un démarrage refusé doit arrêter le processus (audit du 29/09/2026, A16).
 *
 * Le refus vivait seulement dans `instrumentation.ts` : Next le rattrapait en « Failed to prepare
 * server » et une promesse rejetée, le processus ne sortait pas, et un conteneur lancé avec
 * `SESSION_SECRET=change-me-in-production` restait « Up » en répondant 500 à tout — alors que la
 * documentation promet une sortie immédiate. `boot.mjs` contrôle désormais avant d'importer le
 * serveur. On l'exécute pour de vrai, dans une copie où `server.js` n'est qu'un témoin.
 */
const BOOT_DIR = path.resolve(__dirname, "../../server-boot");
const WITNESS = "SERVEUR-IMPORTÉ";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cine-boot-"));
  fs.cpSync(BOOT_DIR, path.join(root, "server-boot"), { recursive: true });
  fs.writeFileSync(path.join(root, "server.js"), `console.log(${JSON.stringify(WITNESS)});\n`);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function boot(env: Record<string, string>) {
  const result = spawnSync(process.execPath, [path.join(root, "server-boot", "boot.mjs")], {
    env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", DATA_DIR: path.join(root, "data"), ...env },
    encoding: "utf8",
    timeout: 20_000,
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("boot.mjs refuse avant d'importer le serveur", () => {
  it("secret d'exemple : code 1, message clair, serveur jamais importé", () => {
    const r = boot({ SESSION_SECRET: "change-me-in-production" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/SESSION_SECRET est la valeur d'exemple publiée/);
    expect(r.stdout).not.toContain(WITNESS);
  });

  it("secret absent ou trop court : code 1", () => {
    expect(boot({}).code).toBe(1);
    const court = boot({ SESSION_SECRET: "a".repeat(15) });
    expect(court.code).toBe(1);
    expect(court.stderr).toMatch(/16 au moins/);
    expect(court.stdout).not.toContain(WITNESS);
  });

  it("mot de passe administrateur d'exemple : code 1", () => {
    const r = boot({ SESSION_SECRET: "x".repeat(32), APP_ADMIN_PASSWORD: "change-me" });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/APP_ADMIN_PASSWORD/);
    expect(r.stdout).not.toContain(WITNESS);
  });

  it("dossier de données impossible à écrire : code 1", () => {
    // Sous un fichier : refusé même en root, là où un chmod ne l'est pas.
    fs.writeFileSync(path.join(root, "fichier"), "");
    const r = boot({ SESSION_SECRET: "x".repeat(32), DATA_DIR: path.join(root, "fichier", "data") });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/DATA_DIR/);
    expect(r.stdout).not.toContain(WITNESS);
  });

  it("une configuration saine importe le serveur", () => {
    const r = boot({ SESSION_SECRET: "x".repeat(20), APP_ADMIN_PASSWORD: "" });
    expect(r.stdout).toContain(WITNESS);
    expect(r.code).toBe(0);
  });
});
