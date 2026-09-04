import { describe, it, expect, vi } from "vitest";

// Mock the DB so verifySessionToken doesn't require a real SQLite file in tests
vi.mock("@/lib/db", () => ({
  sessionDb: { exists: () => true, create: () => {}, delete: () => {}, countOthers: () => 0, deleteOthers: () => 0 },
  getDb: () => { throw new Error("getDb not available in test"); },
}));

import { createSessionToken, verifySessionToken, type Role } from "@/lib/auth";

// Creates a token with a custom exp using the same signing algorithm
async function createTokenWithExp(username: string, role: Role, exp: number): Promise<string> {
  const payload = JSON.stringify({ u: username, role, exp });
  const encodedPayload = Buffer.from(payload).toString("base64url");
  const secret = process.env.SESSION_SECRET ?? "change-me-in-production";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload));
  const signature = Buffer.from(sig).toString("base64url");
  return `${encodedPayload}.${signature}`;
}

describe("auth", () => {
  describe("createSessionToken + verifySessionToken round-trip", () => {
    it("verifies a freshly created admin token", async () => {
      const { token } = await createSessionToken("louis", "admin");
      const payload = await verifySessionToken(token);
      expect(payload).not.toBeNull();
      expect(payload?.u).toBe("louis");
      expect(payload?.role).toBe("admin");
    });

    it("verifies a plain user token", async () => {
      const { token } = await createSessionToken("viewer", "user");
      const payload = await verifySessionToken(token);
      expect(payload?.role).toBe("user");
      expect(payload?.u).toBe("viewer");
    });

    // Le rôle non-administrateur s'appelait « guest » avant le chantier du lecteur. Les jetons
    // déjà distribués le portent, et ils durent une semaine : les rejeter aurait déconnecté tout
    // le monde au premier déploiement. Ce test est là pour que le repli ne soit pas retiré par
    // mégarde tant que ces jetons peuvent encore circuler.
    it("accepts a legacy guest token and reports it as a user", async () => {
      const { token } = await createSessionToken("viewer", "guest" as unknown as "user");
      const payload = await verifySessionToken(token);
      expect(payload).not.toBeNull();
      expect(payload?.role).toBe("user");
    });

    it("includes exp in the future", async () => {
      const before = Date.now();
      const { token } = await createSessionToken("louis", "admin");
      const payload = await verifySessionToken(token);
      expect(payload?.exp).toBeGreaterThan(before);
      // Should expire roughly 7 days from now
      expect(payload?.exp).toBeGreaterThan(before + 6 * 24 * 3600_000);
    });

    it("stores jellyfin fields when provided", async () => {
      const { token } = await createSessionToken("louis", "admin", "louis_jf", "jf-uuid-123", "jf-token-abc");
      const payload = await verifySessionToken(token);
      expect(payload?.jfUser).toBe("louis_jf");
      expect(payload?.jfId).toBe("jf-uuid-123");
      expect(payload?.jfToken).toBe("jf-token-abc");
    });
  });

  describe("verifySessionToken rejects invalid inputs", () => {
    it("returns null for undefined", async () => {
      expect(await verifySessionToken(undefined)).toBeNull();
    });

    it("returns null for null", async () => {
      expect(await verifySessionToken(null)).toBeNull();
    });

    it("returns null for empty string", async () => {
      expect(await verifySessionToken("")).toBeNull();
    });

    it("returns null for a token without a dot separator", async () => {
      expect(await verifySessionToken("nodothere")).toBeNull();
    });

    it("returns null for tampered payload", async () => {
      const { token } = await createSessionToken("louis", "admin");
      const [, sig] = token.split(".");
      // Replace payload with a different one but keep original sig
      const fakePayload = Buffer.from(JSON.stringify({ u: "hacker", role: "admin", exp: Date.now() + 999999 })).toString("base64url");
      const tampered = `${fakePayload}.${sig}`;
      expect(await verifySessionToken(tampered)).toBeNull();
    });

    it("returns null for tampered signature", async () => {
      const { token } = await createSessionToken("louis", "admin");
      const [payload] = token.split(".");
      const tampered = `${payload}.aW52YWxpZHNpZ25hdHVyZQ`;
      expect(await verifySessionToken(tampered)).toBeNull();
    });

    it("returns null for expired token (exp in the past)", async () => {
      const token = await createTokenWithExp("louis", "admin", Date.now() - 1000);
      expect(await verifySessionToken(token)).toBeNull();
    });

    it("returns null for token expired exactly at Date.now()", async () => {
      const token = await createTokenWithExp("louis", "admin", Date.now() - 1);
      expect(await verifySessionToken(token)).toBeNull();
    });

    it("returns null for invalid role in payload", async () => {
      const token = await createTokenWithExp("louis", "admin" as Role, Date.now() + 99999);
      // Manually craft a token with invalid role
      const payload = JSON.stringify({ u: "louis", role: "superuser", exp: Date.now() + 99999 });
      const encodedPayload = Buffer.from(payload).toString("base64url");
      const secret = process.env.SESSION_SECRET ?? "change-me-in-production";
      const key = await crypto.subtle.importKey(
        "raw", new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
      );
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload));
      const badRoleToken = `${encodedPayload}.${Buffer.from(sig).toString("base64url")}`;
      expect(await verifySessionToken(badRoleToken)).toBeNull();
      void token; // suppress unused warning
    });
  });
});
