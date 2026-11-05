// Le cadrage des réponses, sur un vrai serveur Next — sauté sans build (`NEXT_REEL_DIR`).
//
// Ce qui a manqué le 05/11/2026 : Next 16.4.5 retirait le `Content-Encoding` des routes, le catalogue
// brotli arrivait illisible, et le gate était vert — aucun test ne passait par le serveur que l'image
// lance. Celui-ci démarre `server-boot/boot.mjs` sur la sortie `standalone` d'un `next build`, avec un
// DATA_DIR jetable (jamais data/ de la production), un faux Jellyfin pour le relais du flux, une
// session créée par le code de l'application, puis lit les réponses octet par octet :
//
//   tools/compression-reelle/run.sh            # le dépôt tel qu'il est
//   tools/compression-reelle/run.sh <dossier>  # un autre arbre, construit avec les dépendances du dépôt
//
// Il doit échouer sur un arbre qui écrit encore `Content-Encoding` dans ses routes (avant le 06/11/2026)
// construit avec Next ≥ 16.4.5, et passer avec `server-boot/responseFraming.mjs` (DECISIONS.md §131).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

const REEL = process.env.NEXT_REEL_DIR;
const ITEM = "0123456789abcdef0123456789abcdef";
const FILE_SIZE = 3_000_000;
const fileByte = (i: number) => (i * 7 + 13) % 256;

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  error?: string;
}

function request(port: number, urlPath: string, headers: Record<string, string> = {}, method = "GET"): Promise<Raw> {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers, agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
      res.on("aborted", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts), error: "aborted" }));
      res.on("error", (e) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts), error: e.message }));
    });
    req.setTimeout(30_000, () => req.destroy(new Error("délai")));
    req.on("error", (e) => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), error: e.message }));
    req.end();
  });
}

/** Ce que le navigateur ferait du corps : décodé selon `Content-Encoding`, et rien d'autre. */
function browserText(raw: Raw): string {
  const enc = raw.headers["content-encoding"];
  if (enc === "br") return brotliDecompressSync(raw.body).toString("utf8");
  if (enc === "gzip") return gunzipSync(raw.body).toString("utf8");
  if (enc) throw new Error(`codage inattendu : ${enc}`);
  return raw.body.toString("utf8");
}

/** Les règles communes à toute réponse : jamais de marqueur dehors, et une longueur qui dit vrai. */
function framingIsHonest(raw: Raw, method = "GET") {
  expect(raw.error).toBeUndefined();
  expect(raw.headers["x-cine-encoding"]).toBeUndefined();
  expect(raw.headers["x-cine-length"]).toBeUndefined();
  if (method !== "HEAD" && raw.status !== 304 && raw.headers["content-length"] !== undefined) {
    expect(raw.body.length).toBe(Number(raw.headers["content-length"]));
  }
}

/** Un faux Jellyfin : une longue liste HLS et un fichier qui répond aux plages comme le vrai. */
const MASTER = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:3", "#EXT-X-MEDIA-SEQUENCE:0"]
  .concat(
    Array.from({ length: 900 }, (_, i) => [
      "#EXTINF:3.000000, nodesc",
      `/videos/${ITEM}/hls1/main/${i}.ts?DeviceId=abc&MediaSourceId=${ITEM}&VideoCodec=h264&AudioCodec=aac&PlaySessionId=s1&TranscodeReasons=ContainerNotSupported&runtimeTicks=${i * 30_000_000}&actualSegmentLengthTicks=30000000`,
    ]).flat()
  )
  .concat(["#EXT-X-ENDLIST", ""])
  .join("\n");

function fakeJellyfin(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === `/videos/${ITEM}/main.m3u8`) {
      res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      res.end(MASTER);
      return;
    }
    if (url.pathname === `/videos/${ITEM}/stream.mkv`) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Math.min(Number(m[2]), FILE_SIZE - 1) : FILE_SIZE - 1;
      const body = Buffer.alloc(end - start + 1);
      for (let i = 0; i < body.length; i++) body[i] = fileByte(start + i);
      res.writeHead(m ? 206 : 200, {
        "Content-Type": "video/x-matroska",
        "Accept-Ranges": "bytes",
        "Content-Length": String(body.length),
        ...(m ? { "Content-Range": `bytes ${start}-${end}/${FILE_SIZE}` } : {}),
      });
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    // Le reste (préchauffages du démarrage) : une liste vide plutôt qu'une erreur.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
  });
}

describe.skipIf(!REEL)("cadrage des réponses sur un vrai serveur Next", () => {
  let server: ChildProcess | null = null;
  let jellyfin: http.Server;
  let port = 0;
  let cookie = "";
  let logs = "";
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cine-reel-data-"));

  beforeAll(async () => {
    jellyfin = fakeJellyfin();
    await new Promise<void>((r) => jellyfin.listen(0, "127.0.0.1", r));
    const jfPort = (jellyfin.address() as AddressInfo).port;

    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    port = (probe.address() as AddressInfo).port;
    await new Promise((r) => probe.close(r));

    const sessionSecret = randomBytes(48).toString("base64url");
    // La session, par le code de l'application, dans le DATA_DIR jetable : ni compte réel, ni mot de passe.
    process.env.DATA_DIR = dataDir;
    process.env.SESSION_SECRET = sessionSecret;
    const { createSessionToken, SESSION_COOKIE } = await import("@/lib/auth");
    const { sessionDb } = await import("@/lib/db");
    const { token, jti } = await createSessionToken("essai-cadrage", "admin", "essai-cadrage", "fedcba9876543210fedcba9876543210");
    sessionDb.create(jti, "essai-cadrage");
    cookie = `${SESSION_COOKIE}=${token}`;

    server = spawn(process.execPath, ["server-boot/boot.mjs"], {
      cwd: REEL,
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        DATA_DIR: dataDir,
        SESSION_SECRET: sessionSecret,
        SETUP_COMPLETE: "true",
        JELLYFIN_URL: `http://127.0.0.1:${jfPort}`,
        JELLYFIN_API_KEY: "cle-de-test-sans-valeur",
        TZ: "Europe/Paris",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout?.on("data", (d) => (logs += d));
    server.stderr?.on("data", (d) => (logs += d));
    const deadline = Date.now() + 60_000;
    for (;;) {
      const raw = await request(port, "/manifest.webmanifest");
      if (raw.status > 0) break;
      if (Date.now() > deadline || server.exitCode !== null) throw new Error(`le serveur ne démarre pas :\n${logs.slice(-3000)}`);
      await new Promise((r) => setTimeout(r, 300));
    }
  }, 90_000);

  afterAll(async () => {
    server?.kill("SIGTERM");
    await new Promise((r) => jellyfin?.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const authed = (h: Record<string, string> = {}) => ({ Cookie: cookie, ...h });

  it("les Nouveautés (respondPrepared) : brotli, gzip, en clair, 304 — toujours du JSON lisible", async () => {
    // Le premier appel lance le brotli 11 hors du fil principal et part en gzip ; on attend qu'il soit prêt.
    let br: Raw | null = null;
    for (let i = 0; i < 50; i++) {
      const raw = await request(port, "/api/release-notes", authed({ "Accept-Encoding": "gzip, deflate, br, zstd" }));
      expect(raw.status, logs.slice(-2000)).toBe(200);
      framingIsHonest(raw);
      const parsed = JSON.parse(browserText(raw));
      expect(parsed).toBeTypeOf("object");
      if (raw.headers["content-encoding"] === "br") {
        br = raw;
        break;
      }
      expect(raw.headers["content-encoding"]).toBe("gzip");
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(br, "jamais de réponse brotli").not.toBeNull();
    expect(br!.headers["content-length"]).toBe(String(br!.body.length));
    const json = JSON.parse(browserText(br!));

    const gz = await request(port, "/api/release-notes", authed({ "Accept-Encoding": "gzip" }));
    framingIsHonest(gz);
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(JSON.parse(browserText(gz))).toEqual(json);

    const plain = await request(port, "/api/release-notes", authed());
    framingIsHonest(plain);
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(browserText(plain))).toEqual(json);

    const etag = String(br!.headers.etag);
    const notModified = await request(port, "/api/release-notes", authed({ "Accept-Encoding": "br", "If-None-Match": etag }));
    framingIsHonest(notModified);
    expect(notModified.status).toBe(304);
    expect(notModified.body.length).toBe(0);

    const head = await request(port, "/api/release-notes", authed({ "Accept-Encoding": "br" }), "HEAD");
    framingIsHonest(head, "HEAD");
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);

    // Les tailles relevées, pour le rapport : JSON, gzip, brotli.
    console.log(`[cadrage] release-notes : clair ${plain.body.length} o, gzip ${gz.body.length} o, br ${br!.body.length} o`);
  });

  it("la liste HLS du relais : brotli, gzip, en clair — le même texte réécrit", async () => {
    const url = `/api/jellyfin/stream/${ITEM}/main.m3u8?PlaySessionId=s1`;
    const texts: string[] = [];
    for (const [accept, expected] of [
      ["gzip, deflate, br", "br"],
      ["gzip", "gzip"],
      ["", undefined],
    ] as const) {
      const raw = await request(port, url, authed(accept ? { "Accept-Encoding": accept } : {}));
      expect(raw.status, logs.slice(-2000)).toBe(200);
      framingIsHonest(raw);
      expect(raw.headers["content-encoding"]).toBe(expected);
      const text = browserText(raw);
      expect(text.startsWith("#EXTM3U")).toBe(true);
      expect(text).toContain(`/api/jellyfin/stream/${ITEM}/hls1/main/899.ts`);
      expect(text.trimEnd().endsWith("#EXT-X-ENDLIST")).toBe(true);
      texts.push(text);
      console.log(`[cadrage] liste HLS (${expected ?? "clair"}) : ${raw.body.length} o`);
    }
    expect(texts[1]).toBe(texts[0]);
    expect(texts[2]).toBe(texts[0]);
  });

  it("le relais du fichier : 206 avec Content-Length et Content-Range, HEAD avec la taille", async () => {
    const url = `/api/jellyfin/stream/${ITEM}/stream.mkv?static=true&mediaSourceId=${ITEM}`;
    const part = await request(port, url, authed({ Range: "bytes=1000-1999999", "Accept-Encoding": "gzip, br" }));
    expect(part.status, logs.slice(-2000)).toBe(206);
    framingIsHonest(part);
    expect(part.headers["content-range"]).toBe(`bytes 1000-1999999/${FILE_SIZE}`);
    expect(part.headers["content-length"]).toBe(String(1_999_000));
    expect(part.headers["transfer-encoding"]).toBeUndefined();
    expect(part.headers["content-encoding"]).toBeUndefined();
    expect(part.body.length).toBe(1_999_000);
    for (const i of [0, 1, 500_000, 1_998_999]) expect(part.body[i]).toBe(fileByte(1000 + i));

    // Ce que `HttpByteSource.open` lit quand la taille n'est pas connue d'avance.
    const head = await request(port, url, authed(), "HEAD");
    framingIsHonest(head, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(FILE_SIZE));
  });

  it("les pages restent compressées par Next, sans marqueur", async () => {
    const raw = await request(port, "/login", { "Accept-Encoding": "gzip" });
    expect([200, 307]).toContain(raw.status);
    framingIsHonest(raw);
    if (raw.status === 200) {
      expect(raw.headers["content-encoding"]).toBe("gzip");
      expect(browserText(raw)).toContain("<html");
      console.log(`[cadrage] /login : gzip ${raw.body.length} o`);
    }
  });
});
