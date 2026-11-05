import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { ENCODING_MARKER, LENGTH_MARKER, framingHeaderFor, installResponseFraming } from "../../server-boot/responseFraming.mjs";
import { encodedBodyHeaders, framingAvailable, lengthHeader, upstreamLengthHeader } from "@/lib/responseFraming";
import { preparedJson, respondPrepared } from "@/lib/cachedJson";
import { encodePlaylist } from "@/lib/playlistEncoding";

/**
 * Le cadrage des réponses hors des routes (06/11/2026, DECISIONS.md §131).
 *
 * Le 05/11/2026, Next 16.4.5 a retiré le `Content-Encoding` des réponses de route : le catalogue brotli
 * arrivait sans son étiquette et le navigateur le lisait comme du JSON. Le gate était vert, aucun test
 * ne passant par le code de Next qui envoie la réponse. Ceux-ci y passent : `sendResponse` et le module
 * `compression` sont ceux de Next, branchés dans l'ordre de `router-server.js` — le cadrage d'abord
 * (boot.mjs, à l'événement `request`), puis `compression(req, res)`, puis la réponse de la route.
 * Le test de bout en bout, sur un vrai `next build`, est `tools/compression-reelle/`.
 */

const require = createRequire(import.meta.url);
const compression = require("next/dist/compiled/compression") as () => (req: unknown, res: unknown, next: () => void) => void;
const { sendResponse } = require("next/dist/server/send-response") as {
  sendResponse: (req: { method?: string }, res: unknown, response: Response) => Promise<void>;
};
const { NodeNextResponse } = require("next/dist/server/base-http/node") as { NodeNextResponse: new (res: http.ServerResponse) => unknown };

type Handler = (req: http.IncomingMessage) => Response | Promise<Response>;

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** Un serveur monté comme celui de l'image : `framing` faux, c'est Next 16.4.5 seul. */
async function serve(handler: Handler, { framing = true } = {}): Promise<number> {
  const compress = compression();
  const server = http.createServer(async (req, res) => {
    compress(req, res, () => {});
    try {
      await sendResponse({ method: req.method }, new NodeNextResponse(res), await handler(req));
    } catch {
      res.destroy();
    }
  });
  if (framing) server.prependListener("request", (req, res) => installResponseFraming(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

interface Raw {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  error?: string;
}

/** Une requête brute : les octets tels qu'ils arrivent, sans le décodage automatique de `fetch`. */
function get(port: number, urlPath: string, headers: Record<string, string> = {}, method = "GET"): Promise<Raw> {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method, headers, agent: false }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts) }));
      res.on("error", (e) => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts), error: e.message }));
      res.on("aborted", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts), error: "aborted" }));
    });
    req.on("error", (e) => resolve({ status: 0, headers: {}, body: Buffer.alloc(0), error: e.message }));
    req.end();
  });
}

function decode(raw: Raw): string {
  const enc = raw.headers["content-encoding"];
  if (enc === "br") return brotliDecompressSync(raw.body).toString("utf8");
  if (enc === "gzip") return gunzipSync(raw.body).toString("utf8");
  return raw.body.toString("utf8");
}

const PAYLOAD = { titles: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `Titre numéro ${i}`, overview: "Un résumé qui se répète. ".repeat(4) })) };
const JSON_TEXT = JSON.stringify(PAYLOAD);

describe("framingHeaderFor — les règles du marqueur", () => {
  it("traduit br et gzip, et rien d'autre", () => {
    expect(framingHeaderFor("x-cine-encoding", "br")).toEqual({ name: "Content-Encoding", value: "br" });
    expect(framingHeaderFor("X-Cine-Encoding", ["gzip"])).toEqual({ name: "Content-Encoding", value: "gzip" });
    for (const bad of ["deflate", "identity", "br, gzip", "", "zstd", ["br", "gzip"], undefined]) {
      expect(framingHeaderFor("x-cine-encoding", bad)).toBeNull();
    }
  });

  it("ne croit qu'une longueur faite de chiffres, entière et sûre", () => {
    expect(framingHeaderFor("x-cine-length", "0")).toEqual({ name: "Content-Length", value: "0" });
    expect(framingHeaderFor("x-cine-length", ["1234"])).toEqual({ name: "Content-Length", value: "1234" });
    expect(framingHeaderFor("x-cine-length", 42)).toEqual({ name: "Content-Length", value: "42" });
    for (const bad of ["-1", "1e3", "12.5", "0x10", "12, 13", "9999999999999999", "", ["1", "2"]]) {
      expect(framingHeaderFor("x-cine-length", bad)).toBeNull();
    }
  });

  it("laisse tout autre en-tête tel quel", () => {
    expect(framingHeaderFor("content-type", "application/json")).toBeUndefined();
    expect(framingHeaderFor("content-encoding", "br")).toBeUndefined();
  });
});

describe("le serveur de démarrage branche bien le cadrage", () => {
  it("boot.mjs installe le cadrage sur chaque requête et le signale aux routes", () => {
    const boot = fs.readFileSync(path.join(process.cwd(), "server-boot", "boot.mjs"), "utf8");
    expect(boot).toMatch(/prependListener\("request", \(req, res\) => \{[\s\S]*installResponseFraming\(req, res\)/);
    expect(boot).toMatch(/process\.env\[FRAMING_ENV\] = "1"/);
  });
});

describe("le vrai envoi de Next (send-response + compression)", () => {
  beforeEach(() => {
    vi.stubEnv("CINE_FRAMING_HEADERS", "1");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  const br = brotliCompressSync(JSON_TEXT);
  const gz = gzipSync(JSON_TEXT);

  it("Next 16.4.5 seul retire le Content-Encoding d'une route : la panne du 05/11/2026", async () => {
    // Ce que la route faisait avant : l'en-tête écrit directement.
    const port = await serve(
      () => new Response(new Uint8Array(br), { headers: { "Content-Type": "application/json", "Content-Encoding": "br", "Content-Length": String(br.length) } }),
      { framing: false }
    );
    const raw = await get(port, "/", { "Accept-Encoding": "br, gzip" });
    // Le corps brotli part étiqueté autrement (gzip par-dessus, ou rien) : illisible comme JSON.
    expect(raw.headers["content-encoding"]).not.toBe("br");
    expect(() => JSON.parse(decode(raw))).toThrow();
  });

  it("brotli précompressé : Content-Encoding br, la longueur exacte, et compression n'y touche pas", async () => {
    const port = await serve(() => new Response(new Uint8Array(br), { headers: { "Content-Type": "application/json", ...encodedBodyHeaders("br", br.length) } }));
    const raw = await get(port, "/", { "Accept-Encoding": "gzip, deflate, br" });
    expect(raw.status).toBe(200);
    expect(raw.headers["content-encoding"]).toBe("br");
    expect(raw.headers["content-length"]).toBe(String(br.length));
    expect(raw.headers["transfer-encoding"]).toBeUndefined();
    expect(raw.headers[ENCODING_MARKER]).toBeUndefined();
    expect(raw.headers[LENGTH_MARKER]).toBeUndefined();
    expect(raw.body.equals(br)).toBe(true);
    expect(JSON.parse(decode(raw))).toEqual(PAYLOAD);
  });

  it("gzip précompressé : jamais regzippé", async () => {
    const port = await serve(() => new Response(new Uint8Array(gz), { headers: { "Content-Type": "application/json", ...encodedBodyHeaders("gzip", gz.length) } }));
    const raw = await get(port, "/", { "Accept-Encoding": "gzip" });
    expect(raw.headers["content-encoding"]).toBe("gzip");
    expect(raw.headers["content-length"]).toBe(String(gz.length));
    expect(raw.body.equals(gz)).toBe(true);
  });

  it("HEAD : les mêmes en-têtes, aucun corps, la connexion intacte", async () => {
    const port = await serve(() => new Response(new Uint8Array(br), { headers: { "Content-Type": "application/json", ...encodedBodyHeaders("br", br.length) } }));
    const raw = await get(port, "/", { "Accept-Encoding": "br" }, "HEAD");
    expect(raw.error).toBeUndefined();
    expect(raw.headers["content-encoding"]).toBe("br");
    expect(raw.headers["content-length"]).toBe(String(br.length));
    expect(raw.body.length).toBe(0);
  });

  it("304 : ni corps ni cadrage, et rien de coupé", async () => {
    const port = await serve(() => new Response(null, { status: 304, headers: { ETag: 'W/"x"' } }));
    const raw = await get(port, "/", { "If-None-Match": 'W/"x"' });
    expect(raw.status).toBe(304);
    expect(raw.error).toBeUndefined();
    expect(raw.headers["content-encoding"]).toBeUndefined();
  });

  it("206 relayé : Content-Length et Content-Range de l'amont, octet pour octet", async () => {
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 251));
    const port = await serve(() => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(bytes.subarray(0, 2000)));
          c.enqueue(new Uint8Array(bytes.subarray(2000)));
          c.close();
        },
      });
      return new Response(body, {
        status: 206,
        headers: { "Content-Type": "video/x-matroska", "Content-Range": `bytes 100-5099/90000`, ...lengthHeader(bytes.length) },
      });
    });
    const raw = await get(port, "/", { Range: "bytes=100-5099", "Accept-Encoding": "gzip" });
    expect(raw.status).toBe(206);
    expect(raw.headers["content-length"]).toBe("5000");
    expect(raw.headers["content-range"]).toBe("bytes 100-5099/90000");
    expect(raw.headers["transfer-encoding"]).toBeUndefined();
    expect(raw.body.equals(bytes)).toBe(true);
  });

  it("Next ne compresse jamais une réponse de route : son module compression la croit incompressible", async () => {
    // Relevé le 06/11/2026, et pareil en 16.4.3 : `sendResponse` pose les en-têtes par
    // `NodeNextResponse.appendHeader`, qui écrit des tableaux (`["application/json"]`), et `compressible`
    // n'accepte qu'une chaîne — « not compressible ». Ce que les routes ne compressent pas elles-mêmes
    // part donc en clair, avant comme après ce changement ; seules les pages passent par `compression`.
    const port = await serve(() => new Response(JSON_TEXT, { headers: { "Content-Type": "application/json" } }));
    const raw = await get(port, "/", { "Accept-Encoding": "gzip" });
    expect(raw.headers["content-encoding"]).toBeUndefined();
    expect(JSON.parse(decode(raw))).toEqual(PAYLOAD);
  });

  it("quand compression prend la main (en-tête posé en chaîne), la longueur s'efface et rien n'est coupé", async () => {
    const text = "WEBVTT\n\n" + "00:00:01.000 --> 00:00:02.000\nUne réplique.\n\n".repeat(200);
    const compress = compression();
    const server = http.createServer((req, res) => {
      compress(req, res, () => {});
      res.setHeader("Content-Type", "text/vtt");
      res.setHeader(LENGTH_MARKER, String(Buffer.byteLength(text)));
      res.end(text);
    });
    server.prependListener("request", (req, res) => installResponseFraming(req, res));
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const raw = await get(port, "/", { "Accept-Encoding": "gzip" });
    expect(raw.error).toBeUndefined();
    expect(raw.headers["content-encoding"]).toBe("gzip");
    expect(raw.headers["content-length"]).toBeUndefined();
    expect(decode(raw)).toBe(text);
  });

  it("un marqueur illisible n'est jamais envoyé, ni traduit", async () => {
    const port = await serve(
      () => new Response("x".repeat(10), { headers: { "Content-Type": "application/octet-stream", [ENCODING_MARKER]: "deflate", [LENGTH_MARKER]: "1e1" } })
    );
    const raw = await get(port, "/");
    expect(raw.headers["content-encoding"]).toBeUndefined();
    expect(raw.headers[ENCODING_MARKER]).toBeUndefined();
    expect(raw.headers[LENGTH_MARKER]).toBeUndefined();
    expect(raw.body.toString()).toBe("x".repeat(10));
  });

  it("un corps plus long que la longueur déclarée coupe la connexion : aucun octet de trop ne part", async () => {
    const port = await serve(() => new Response("0123456789ABCDEF", { headers: { "Content-Type": "application/octet-stream", ...lengthHeader(10) } }));
    const raw = await get(port, "/");
    expect(raw.body.length).toBeLessThanOrEqual(10);
    expect(raw.body.toString()).not.toContain("ABCDEF");
  });

  it("un corps plus court que la longueur déclarée coupe la connexion au lieu de la laisser pendre", async () => {
    const port = await serve(() => {
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("abc"));
          c.close();
        },
      });
      return new Response(body, { headers: { "Content-Type": "application/octet-stream", ...lengthHeader(10) } });
    });
    const raw = await get(port, "/");
    expect(raw.error).toBeDefined();
    expect(raw.body.length).toBeLessThan(10);
  });
});

describe("les routes : marqueur sous le serveur de démarrage, clair sans lui", () => {
  const req = (enc: string | null) => new Request("https://cine.example/api/x", enc ? { headers: { "accept-encoding": enc } } : {});

  beforeEach(() => vi.unstubAllEnvs());

  it("sans boot.mjs (next dev) : le catalogue part en JSON clair, sans aucun marqueur", async () => {
    expect(framingAvailable()).toBe(false);
    const res = respondPrepared(req("gzip, br"), preparedJson("framing-test-dev", PAYLOAD));
    expect(res.headers.get(ENCODING_MARKER)).toBeNull();
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual(PAYLOAD);
    const list = Buffer.from("#EXTM3U\n" + "#EXTINF:3.0,\nseg.ts?x=1\n".repeat(200));
    const encoded = await encodePlaylist(list, "br");
    expect(encoded.body.equals(list)).toBe(true);
    expect(encoded.headers[ENCODING_MARKER]).toBeUndefined();
    expect(lengthHeader(10)).toEqual({});
  });

  it("sous boot.mjs : le marqueur, jamais l'en-tête que Next retirerait", async () => {
    vi.stubEnv("CINE_FRAMING_HEADERS", "1");
    const res = respondPrepared(req("gzip"), preparedJson("framing-test-boot", PAYLOAD));
    expect(res.headers.get(ENCODING_MARKER)).toBe("gzip");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString())).toEqual(PAYLOAD);
  });

  it("une longueur d'amont n'est reprise que pour un corps que fetch n'a pas décodé", () => {
    vi.stubEnv("CINE_FRAMING_HEADERS", "1");
    const up = (h: Record<string, string>) => new Response(null, { headers: h });
    expect(upstreamLengthHeader(up({ "Content-Length": "123" }))).toEqual({ [LENGTH_MARKER]: "123" });
    expect(upstreamLengthHeader(up({ "Content-Length": "123", "Content-Encoding": "identity" }))).toEqual({ [LENGTH_MARKER]: "123" });
    expect(upstreamLengthHeader(up({ "Content-Length": "123", "Content-Encoding": "gzip" }))).toEqual({});
    expect(upstreamLengthHeader(up({ "Content-Length": "12x" }))).toEqual({});
    expect(upstreamLengthHeader(up({}))).toEqual({});
  });
});

describe("aucune route n'écrit Content-Encoding ni Content-Length elle-même", () => {
  // Next 16.4.5 les retire sans rien dire : un tel en-tête dans une route est la panne du 05/11/2026
  // qui attend la prochaine compression. Passer par `@/lib/responseFraming`.
  it("src/app et src/lib", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "foliate") walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          // Un en-tête de réponse écrit : clé d'objet ou affectation. `headers.get("Content-Length")`
          // (lire celui d'une réponse reçue) reste permis.
          if (/["']Content-(Encoding|Length)["']\s*(:|\]\s*=)/i.test(text)) offenders.push(path.relative(process.cwd(), full));
        }
      }
    };
    walk(path.join(process.cwd(), "src", "app"));
    walk(path.join(process.cwd(), "src", "lib"));
    expect(offenders).toEqual([]);
  });
});
