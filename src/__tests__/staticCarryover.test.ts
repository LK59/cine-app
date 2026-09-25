import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KEEP_BUILDS, KEEP_HOURS, carryOverStatic } from "../../server-boot/staticCarryover.mjs";

/**
 * Les morceaux de code du build d'avant, gardés quelques heures (25/09/2026) : un onglet resté sur
 * l'ancien build pendant un film ne doit pas recevoir de 404 en chargeant un décodeur.
 */
let root: string;
let data: string;
const HOUR = 3600_000;

/** Une « image » : son BUILD_ID et ses fichiers statiques, comme les copie le Dockerfile. */
function image(buildId: string, files: Record<string, string>): string {
  const app = path.join(root, `app-${buildId}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(path.join(app, ".next", "static"), { recursive: true });
  fs.writeFileSync(path.join(app, ".next", "BUILD_ID"), buildId);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(app, ".next", "static", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  return app;
}
const read = (app: string, name: string) => fs.readFileSync(path.join(app, ".next", "static", name), "utf8");
const has = (app: string, name: string) => fs.existsSync(path.join(app, ".next", "static", name));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cine-static-"));
  data = path.join(root, "data");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("les fichiers statiques des builds précédents", () => {
  it("le premier démarrage n'a rien à reprendre, et s'archive pour le suivant", () => {
    const a = image("A", { "chunks/a1.js": "a1", "A/_buildManifest.js": "mA" });
    expect(carryOverStatic({ appDir: a, dataDir: data, now: 0 })).toEqual({ buildId: "A", carried: [], removed: [] });
    expect(fs.existsSync(path.join(data, "static-previous", "A", "chunks", "a1.js"))).toBe(true);
  });

  it("le build suivant sert aussi les morceaux du précédent, sans jamais écraser les siens", () => {
    carryOverStatic({ appDir: image("A", { "chunks/a1.js": "a1", "chunks/commun.js": "ancien", "A/_buildManifest.js": "mA" }), dataDir: data, now: 0 });
    const b = image("B", { "chunks/b1.js": "b1", "chunks/commun.js": "nouveau", "B/_buildManifest.js": "mB" });

    expect(carryOverStatic({ appDir: b, dataDir: data, now: HOUR }).carried).toEqual(["A"]);
    expect(read(b, "chunks/a1.js")).toBe("a1");
    expect(read(b, "A/_buildManifest.js")).toBe("mA");
    expect(read(b, "chunks/commun.js")).toBe("nouveau");
    // La marque de retrait reste dans l'archive, jamais servie.
    expect(has(b, ".retired-at")).toBe(false);
  });

  it(`efface un build retiré depuis plus de ${KEEP_HOURS} h — l'âge compte depuis son retrait`, () => {
    carryOverStatic({ appDir: image("A", { "chunks/a1.js": "a1" }), dataDir: data, now: 0 });
    // B démarre dix heures après la construction de A : A n'est retiré qu'à cet instant.
    carryOverStatic({ appDir: image("B", { "chunks/b1.js": "b1" }), dataDir: data, now: 10 * HOUR });
    const c = image("C", { "chunks/c1.js": "c1" });
    const result = carryOverStatic({ appDir: c, dataDir: data, now: 10 * HOUR + (KEEP_HOURS + 1) * HOUR });

    expect(result.removed).toContain("A");
    expect(has(c, "chunks/a1.js")).toBe(false);
    expect(fs.existsSync(path.join(data, "static-previous", "A"))).toBe(false);
  });

  it(`n'en garde que ${KEEP_BUILDS}, les plus récemment retirés`, () => {
    const ids = ["A", "B", "C", "D", "E", "F"];
    ids.forEach((id, i) => carryOverStatic({ appDir: image(id, { [`chunks/${id}.js`]: id }), dataDir: data, now: i * 60_000 }));
    const g = image("G", { "chunks/G.js": "G" });
    const { carried } = carryOverStatic({ appDir: g, dataDir: data, now: 7 * 60_000 });

    expect(carried).toEqual(["F", "E", "D"]);
    expect(has(g, "chunks/D.js")).toBe(true);
    expect(has(g, "chunks/C.js")).toBe(false);
  });

  it("une archive interrompue ne passe jamais pour un build", () => {
    fs.mkdirSync(path.join(data, "static-previous", "Z.partiel", "chunks"), { recursive: true });
    fs.writeFileSync(path.join(data, "static-previous", "Z.partiel", "chunks", "z.js"), "tronqué");
    const a = image("A", { "chunks/a1.js": "a1" });
    expect(carryOverStatic({ appDir: a, dataDir: data, now: 0 }).carried).toEqual([]);
    expect(has(a, "chunks/z.js")).toBe(false);
    expect(fs.existsSync(path.join(data, "static-previous", "Z.partiel"))).toBe(false);
  });

  it("refuse un BUILD_ID qui sortirait du dossier", () => {
    expect(() => carryOverStatic({ appDir: image("../x", {}), dataDir: data })).toThrow(/BUILD_ID/);
  });
});
