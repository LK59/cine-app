import { describe, it, expect } from "vitest";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { preparedJson, respondPrepared } from "@/lib/cachedJson";

const req = (acceptEncoding: string | null, etag?: string) =>
  new Request("http://x/api/cinema/movies", {
    headers: { ...(acceptEncoding !== null ? { "accept-encoding": acceptEncoding } : {}), ...(etag ? { "if-none-match": etag } : {}) },
  });

/** Assez de texte pour que brotli s'y mette, et assez varié pour que l'écart se voie. */
function catalogue(seed: string) {
  return { items: Array.from({ length: 400 }, (_, i) => ({ id: i, title: `${seed} ${i}`, overview: `Un résumé ${i * 7919} de ${seed}, qui ne se répète pas tout à fait.` })) };
}

async function brotliReady(p: ReturnType<typeof preparedJson>) {
  for (let i = 0; i < 200 && !p.br; i++) await new Promise((r) => setTimeout(r, 10));
}

/**
 * Le catalogue en brotli (15/10/2026) : −22 % sur le plus gros envoi de l'ouverture, calculé hors du
 * fil principal ; jusque-là, gzip comme avant.
 */
describe("respondPrepared — brotli", () => {
  it("part en gzip tant que brotli n'est pas prêt, puis en brotli, le même JSON", async () => {
    const p = preparedJson("t:brotli:1", catalogue("a"));
    const res1 = respondPrepared(req("gzip, deflate, br"), p);
    expect(res1.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(Buffer.from(await res1.arrayBuffer())).toString()).toBe(p.json);
    await brotliReady(p);
    const res2 = respondPrepared(req("gzip, deflate, br"), p);
    expect(res2.headers.get("content-encoding")).toBe("br");
    const body = Buffer.from(await res2.arrayBuffer());
    expect(Number(res2.headers.get("content-length"))).toBe(body.byteLength);
    expect(body.byteLength).toBeLessThan(p.gzip.byteLength);
    expect(brotliDecompressSync(body).toString()).toBe(p.json);
    expect(res2.headers.get("etag")).toBe(p.etag);
    expect(res2.headers.get("vary")).toBe("Accept-Encoding");
  });

  it("ne sert brotli qu'à qui l'accepte, et ne le calcule pas pour les autres", async () => {
    const p = preparedJson("t:brotli:2", catalogue("b"));
    expect(respondPrepared(req("gzip"), p).headers.get("content-encoding")).toBe("gzip");
    expect(respondPrepared(req("gzip, br;q=0"), p).headers.get("content-encoding")).toBe("gzip");
    expect(respondPrepared(req(null), p).headers.get("content-encoding")).toBeNull();
    expect(p.brStarted).toBeFalsy();
  });

  it("garde le 304 d'une étiquette connue, quel que soit l'encodage", async () => {
    const p = preparedJson("t:brotli:3", catalogue("c"));
    const res = respondPrepared(req("br", p.etag), p);
    expect(res.status).toBe(304);
    expect(p.brStarted).toBeFalsy();
  });

  it("une nouvelle version du catalogue recalcule son brotli, sans servir l'ancien", async () => {
    const old = preparedJson("t:brotli:4", catalogue("d"));
    respondPrepared(req("br"), old);
    await brotliReady(old);
    const fresh = preparedJson("t:brotli:4", catalogue("e"));
    expect(fresh).not.toBe(old);
    const res = respondPrepared(req("br, gzip"), fresh);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(Buffer.from(await res.arrayBuffer())).toString()).toBe(fresh.json);
  });

  it("une petite réponse reste en gzip : brotli n'en vaut pas la peine", () => {
    const p = preparedJson("t:brotli:5", { items: [] });
    respondPrepared(req("br, gzip"), p);
    expect(p.brStarted).toBeFalsy();
  });
});
