import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { immersionFilePath, serveImmersionFile } from "@/lib/immersionFiles";
import { GET as page } from "@/app/immersion/route";
import { GET as file } from "@/app/api/immersion/[...path]/route";
import { ENCODING_MARKER, FRAMING_ENV, LENGTH_MARKER } from "../../server-boot/responseFraming.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "immersion-dist-"));
const outside = path.join(os.tmpdir(), `immersion-secret-${process.pid}.js`);
const previous = { dist: process.env.IMMERSION_DIST, framing: process.env[FRAMING_ENV] };

beforeAll(() => {
  fs.mkdirSync(path.join(dir, "assets/textures"), { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Immersion</title>");
  fs.writeFileSync(path.join(dir, "assets/index-Dk3fA91b.js"), "console.log('immersion')");
  fs.writeFileSync(path.join(dir, "assets/index-Dk3fA91b.js.br"), "BROTLI");
  fs.writeFileSync(path.join(dir, "assets/textures/color.ktx2"), Buffer.from([1, 2, 3, 4]));
  fs.writeFileSync(path.join(dir, "notes.txt"), "pas un type servi");
  fs.writeFileSync(outside, "secret");
  process.env.IMMERSION_DIST = dir;
});

afterEach(() => {
  process.env.IMMERSION_DIST = dir;
  delete process.env[FRAMING_ENV];
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
  if (previous.dist === undefined) delete process.env.IMMERSION_DIST;
  else process.env.IMMERSION_DIST = previous.dist;
  if (previous.framing === undefined) delete process.env[FRAMING_ENV];
  else process.env[FRAMING_ENV] = previous.framing;
});

const get = (url: string, headers: Record<string, string> = {}) => new Request(`http://localhost${url}`, { headers });
const params = (...segments: string[]) => ({ params: Promise.resolve({ path: segments }) });

describe("les fichiers du mode Immersion", () => {
  it("sert la page sans la laisser en cache", async () => {
    const res = await page(get("/immersion"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("Immersion");
  });

  it("sert un fichier nommé par son contenu pour un an, derrière la session", async () => {
    const res = await file(get("/api/immersion/assets/index-Dk3fA91b.js"), params("assets", "index-Dk3fA91b.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(await res.text()).toBe("console.log('immersion')");
  });

  it("revalide ce qui n'est pas versionné, et répond 304 à la même empreinte", async () => {
    const first = await file(get("/api/immersion/assets/textures/color.ktx2"), params("assets", "textures", "color.ktx2"));
    expect(first.headers.get("cache-control")).toBe("private, max-age=0, must-revalidate");
    expect(first.headers.get("content-type")).toBe("image/ktx2");
    const etag = first.headers.get("etag")!;
    const again = await file(get("/api/immersion/assets/textures/color.ktx2", { "if-none-match": etag }), params("assets", "textures", "color.ktx2"));
    expect(again.status).toBe(304);
    const versioned = await file(get("/api/immersion/assets/textures/color.ktx2?v=abc"), params("assets", "textures", "color.ktx2"));
    expect(versioned.headers.get("cache-control")).toContain("immutable");
  });

  // DECISIONS.md §131 : jamais de `Content-Encoding` écrit par une route, et jamais un corps
  // compressé sans le serveur de démarrage pour l'étiqueter.
  it("ne sert le .br qu'avec le serveur de démarrage, par les marqueurs", async () => {
    const plain = await file(get("/api/immersion/assets/index-Dk3fA91b.js", { "accept-encoding": "gzip, br" }), params("assets", "index-Dk3fA91b.js"));
    expect(await plain.text()).toBe("console.log('immersion')");
    expect(plain.headers.get(ENCODING_MARKER)).toBeNull();
    expect(plain.headers.get("content-encoding")).toBeNull();

    process.env[FRAMING_ENV] = "1";
    const framed = await file(get("/api/immersion/assets/index-Dk3fA91b.js", { "accept-encoding": "gzip, br" }), params("assets", "index-Dk3fA91b.js"));
    expect(framed.headers.get(ENCODING_MARKER)).toBe("br");
    expect(framed.headers.get(LENGTH_MARKER)).toBe("6");
    expect(framed.headers.get("content-encoding")).toBeNull();
    expect(await framed.text()).toBe("BROTLI");

    const refused = await file(get("/api/immersion/assets/index-Dk3fA91b.js", { "accept-encoding": "gzip" }), params("assets", "index-Dk3fA91b.js"));
    expect(refused.headers.get(ENCODING_MARKER)).toBeNull();
    expect(refused.headers.get(LENGTH_MARKER)).toBe(String("console.log('immersion')".length));
  });

  it("ne sort jamais du dossier et ne sert que les types du build", async () => {
    for (const segments of [
      ["..", path.basename(outside)],
      ["assets", "..", "..", path.basename(outside)],
      ["assets/../index.html"],
      ["assets\\index-Dk3fA91b.js"],
      [".env"],
      ["notes.txt"],
      ["assets"],
      [""],
      [],
    ]) {
      expect(immersionFilePath(segments), JSON.stringify(segments)).toBeNull();
      expect((await serveImmersionFile(get("/api/immersion/x"), segments)).status).toBe(404);
    }
    expect((await file(get("/api/immersion/assets/absent.js"), params("assets", "absent.js"))).status).toBe(404);
  });

  it("répond 404 quand le build n'est pas dans l'image", async () => {
    process.env.IMMERSION_DIST = path.join(dir, "nulle-part");
    expect((await page(get("/immersion"))).status).toBe(404);
    expect((await file(get("/api/immersion/assets/index-Dk3fA91b.js"), params("assets", "index-Dk3fA91b.js"))).status).toBe(404);
  });
});
