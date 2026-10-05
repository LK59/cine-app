import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyFirstRunSecrets, secretsFile } from "../../server-boot/firstRunSecrets.mjs";

/** Les secrets du premier lancement (DECISIONS.md §48) : générés une fois, `.env` d'abord. */
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cine-secrets-"));

describe("les secrets du premier lancement", () => {
  it("génère ce qui manque, le garde, et le relit à l'identique au démarrage suivant", async () => {
    const dir = tmp();
    const env1: Record<string, string | undefined> = {};
    const generated = await applyFirstRunSecrets(dir, env1);
    expect(generated).toContain("SESSION_SECRET");
    expect(env1.SESSION_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(secretsFile(dir))).toBe(true);
    const env2: Record<string, string | undefined> = {};
    await applyFirstRunSecrets(dir, env2);
    expect(env2.SESSION_SECRET).toBe(env1.SESSION_SECRET);
    expect(env2.VAPID_PUBLIC_KEY).toBe(env1.VAPID_PUBLIC_KEY);
  });

  it("ne touche jamais à ce que l'environnement donne, et n'écrit rien s'il donne tout", async () => {
    const dir = tmp();
    const env: Record<string, string | undefined> = {
      SESSION_SECRET: "un-secret-du-env-assez-long",
      VAPID_PUBLIC_KEY: "pub",
      VAPID_PRIVATE_KEY: "priv",
    };
    expect(await applyFirstRunSecrets(dir, env)).toEqual([]);
    expect(env.SESSION_SECRET).toBe("un-secret-du-env-assez-long");
    expect(fs.existsSync(secretsFile(dir))).toBe(false);
  });
});
