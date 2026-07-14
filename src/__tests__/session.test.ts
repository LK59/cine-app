import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// session.ts pulls in @/lib/db, which reads process.env.DATA_DIR at
// module-evaluation time — set it before first import to avoid touching the
// real project ./data directory, and use dynamic import so the env var is
// applied first.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cine-session-test-"));

let auth: typeof import("@/lib/auth");
let session: typeof import("@/lib/session");
let db: typeof import("@/lib/db");

beforeAll(async () => {
  process.env.DATA_DIR = TMP_DIR;
  auth = await import("@/lib/auth");
  session = await import("@/lib/session");
  db = await import("@/lib/db");
  db.getDb();
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("verifySessionFull", () => {
  it("returns null for garbage input", async () => {
    expect(await session.verifySessionFull("garbage")).toBeNull();
  });

  it("returns null when token is missing", async () => {
    expect(await session.verifySessionFull(undefined)).toBeNull();
    expect(await session.verifySessionFull(null)).toBeNull();
  });

  it("accepts a token whose jti is registered in the session store", async () => {
    const { token, jti } = await auth.createSessionToken("louis", "admin");
    db.sessionDb.create(jti, "louis");
    const payload = await session.verifySessionFull(token);
    expect(payload?.u).toBe("louis");
    expect(payload?.role).toBe("admin");
  });

  it("rejects a token whose jti has been revoked server-side", async () => {
    const { token, jti } = await auth.createSessionToken("louis", "admin");
    db.sessionDb.create(jti, "louis");
    db.sessionDb.delete(jti);
    expect(await session.verifySessionFull(token)).toBeNull();
  });

  it("still rejects a signature-invalid token even if never registered", async () => {
    const { token } = await auth.createSessionToken("mallory", "admin");
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    expect(await session.verifySessionFull(tampered)).toBeNull();
  });
});

describe("resolveSession", () => {
  it("extracts and verifies the session cookie from a request", async () => {
    const { token, jti } = await auth.createSessionToken("louis", "admin");
    db.sessionDb.create(jti, "louis");
    const fakeReq = {
      cookies: { get: (name: string) => (name === session.SESSION_COOKIE ? { value: token } : undefined) },
    } as unknown as import("next/server").NextRequest;

    const payload = await session.resolveSession(fakeReq);
    expect(payload?.u).toBe("louis");
  });

  it("returns null when the cookie is absent", async () => {
    const fakeReq = {
      cookies: { get: () => undefined },
    } as unknown as import("next/server").NextRequest;

    expect(await session.resolveSession(fakeReq)).toBeNull();
  });
});
