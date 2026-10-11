import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NextRequest } from "next/server";
import { SETTINGS_BY_KEY } from "@/lib/settings/schema";

// DECISIONS.md §64 — l'identifiant du récepteur et l'ouverture du bouton : deux réglages de
// l'installation, lus comme les autres (réglage de l'application → .env → défaut, §48).

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...args: unknown[]) => mockVerifySessionFull(...args) }));

function req(): NextRequest {
  return { cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}

const saved = { ...process.env };
beforeEach(() => {
  delete process.env.CAST_RECEIVER_APP_ID;
  delete process.env.CHROMECAST_FOR_EVERYONE;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("les réglages", () => {
  it("figurent dans la liste unique, réglables dans l'application", () => {
    expect(SETTINGS_BY_KEY.get("CAST_RECEIVER_APP_ID")).toMatchObject({ group: "playback", kind: "text", inApp: true, fallback: "" });
    expect(SETTINGS_BY_KEY.get("CHROMECAST_FOR_EVERYONE")).toMatchObject({ group: "playback", kind: "boolean", inApp: true, fallback: "true" });
  });

  it("par défaut : le récepteur public de Google, ouvert à tous (11/10/2026)", async () => {
    const { config } = await import("@/lib/config");
    expect(config.player.castReceiverAppId).toBe("CC1AD845");
    expect(config.player.chromecastForEveryone).toBe(true);
  });

  it("relus à chaque accès : un récepteur enregistré par l'installation, le bouton ouvert à tous", async () => {
    const { config } = await import("@/lib/config");
    process.env.CAST_RECEIVER_APP_ID = "1a2b3c4d";
    process.env.CHROMECAST_FOR_EVERYONE = "true";
    expect(config.player.castReceiverAppId).toBe("1A2B3C4D");
    expect(config.player.chromecastForEveryone).toBe(true);
    // Mal recopié : le récepteur de Google, pas une diffusion cassée.
    process.env.CAST_RECEIVER_APP_ID = "pas-un-id";
    expect(config.player.castReceiverAppId).toBe("CC1AD845");
  });
});

describe("GET /api/player/cast", () => {
  it("ouvert à tous par défaut (11/10/2026) : administrateur et compte ordinaire voient le bouton", async () => {
    const { GET } = await import("@/app/api/player/cast/route");
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin" });
    expect(await (await GET(req())).json()).toEqual({ allowed: true, receiverAppId: "CC1AD845" });
    mockVerifySessionFull.mockResolvedValue({ u: "ami", role: "user" });
    expect(await (await GET(req())).json()).toEqual({ allowed: true, receiverAppId: "CC1AD845" });
  });

  it("refermé aux administrateurs par le réglage", async () => {
    process.env.CHROMECAST_FOR_EVERYONE = "false";
    const { GET } = await import("@/app/api/player/cast/route");
    mockVerifySessionFull.mockResolvedValue({ u: "louis", role: "admin" });
    expect((await (await GET(req())).json()).allowed).toBe(true);
    mockVerifySessionFull.mockResolvedValue({ u: "ami", role: "user" });
    expect((await (await GET(req())).json()).allowed).toBe(false);
  });

  it("ouvert à tous par le réglage", async () => {
    process.env.CHROMECAST_FOR_EVERYONE = "true";
    const { GET } = await import("@/app/api/player/cast/route");
    mockVerifySessionFull.mockResolvedValue({ u: "ami", role: "user" });
    expect((await (await GET(req())).json()).allowed).toBe(true);
  });

  it("sans session : 401", async () => {
    const { GET } = await import("@/app/api/player/cast/route");
    mockVerifySessionFull.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });
});
