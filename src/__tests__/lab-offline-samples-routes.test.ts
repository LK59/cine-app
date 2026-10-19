import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";

/**
 * Les extraits du test de qualité hors ligne (19/10/2026, `labSamples.ts`) : réservés à
 * l'administrateur, servis par plages comme un film, et rien d'autre que les noms de la liste.
 */

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const verify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => verify(...a) }));

import { DATA_DIR } from "@/lib/dataDir";
import { GET as listGET } from "@/app/api/lab/offline-samples/route";
import { GET as fileGET } from "@/app/api/lab/offline-samples/[file]/route";

const req = (headers: Record<string, string> = {}) =>
  ({ cookies: { get: () => ({ value: "t" }) }, headers: new Headers(headers) }) as unknown as NextRequest;
const params = (file: string) => ({ params: Promise.resolve({ file }) });
const BYTES = Buffer.from("0123456789abcdefghij");

beforeAll(() => {
  const dir = path.join(DATA_DIR, "lab", "offline-samples");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a-1080-2.mp4"), BYTES);
  // Un fichier présent mais hors liste : jamais servi.
  fs.writeFileSync(path.join(dir, "secret.mp4"), BYTES);
});
beforeEach(() => {
  verify.mockReset();
  verify.mockResolvedValue({ u: "louis", role: "admin" });
});

describe("/api/lab/offline-samples", () => {
  it("un compte ordinaire est refusé, la liste comme le fichier", async () => {
    verify.mockResolvedValue({ u: "mathis", role: "user" });
    expect((await listGET(req())).status).toBe(403);
    expect((await fileGET(req(), params("a-1080-2.mp4"))).status).toBe(403);
  });

  it("la liste ne donne que les extraits présents, avec leur taille", async () => {
    const body = await (await listGET(req())).json();
    expect(body.samples).toEqual([{ file: "a-1080-2.mp4", sizeBytes: BYTES.length }]);
  });

  it("une plage : 206 avec Content-Range, et les octets demandés", async () => {
    const res = await fileGET(req({ range: "bytes=5-9" }), params("a-1080-2.mp4"));
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 5-9/${BYTES.length}`);
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("56789");
    const tail = await fileGET(req({ range: "bytes=-4" }), params("a-1080-2.mp4"));
    expect(Buffer.from(await tail.arrayBuffer()).toString()).toBe("ghij");
    expect((await fileGET(req({ range: "bytes=99-" }), params("a-1080-2.mp4"))).status).toBe(416);
  });

  it("sans plage : le fichier entier ; hors liste ou absent : 404", async () => {
    const res = await fileGET(req(), params("a-1080-2.mp4"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(BYTES.length));
    expect((await fileGET(req(), params("secret.mp4"))).status).toBe(404);
    expect((await fileGET(req(), params("../../app.db"))).status).toBe(404);
    expect((await fileGET(req(), params("b-1080-3.mp4"))).status).toBe(404);
  });
});
