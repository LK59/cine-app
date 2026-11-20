import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

// Un DATA_DIR à lui : le test écrit et efface `branding/`.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/cine-loginbg-`);
});

const admin = vi.hoisted(() => ({ ok: true }));
vi.mock("@/lib/activity/adminOnly", async () => {
  const { NextResponse } = await import("next/server");
  return { adminOnly: async () => (admin.ok ? { u: "admin", role: "admin" } : NextResponse.json({ error: "non" }, { status: 403 })) };
});

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { NextRequest } from "next/server";
import { DATA_DIR } from "@/lib/dataDir";
import { isPublicPath } from "@/lib/publicPaths";
import { clampDim, LOGIN_BACKGROUND_DIM_MAX, LOGIN_BACKGROUND_DIM_MIN, LOGIN_BACKGROUND_MAX_BYTES } from "@/lib/loginBackgroundShared";
import { loginBackground, removeLoginBackground, saveLoginBackground, setLoginBackgroundDim } from "@/lib/loginBackground";
import { GET as publicGet } from "@/app/api/login-background/route";
import { DELETE as adminDelete, GET as adminGet, PATCH as adminPatch, POST as adminPost } from "@/app/api/admin/login-background/route";

afterAll(() => fs.rmSync(DATA_DIR, { recursive: true, force: true }));

const jpeg = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 200, g: 120, b: 40 } } }).jpeg().toBuffer();
const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) => new NextRequest(new URL(url, "http://laterna.test"), init);

beforeEach(() => {
  admin.ok = true;
  removeLoginBackground();
});

describe("l'image des écrans de connexion (DECISIONS §199)", () => {
  it("s'ouvre sans session, et seulement elle", () => {
    expect(isPublicPath("/api/login-background")).toBe(true);
    expect(isPublicPath("/api/admin/login-background")).toBe(false);
  });

  it("sans image : rien, et la route publique répond 204 — jamais 404", async () => {
    expect(loginBackground()).toBeNull();
    const res = await publicGet(req("/api/login-background"));
    expect(res.status).toBe(204);
  });

  it("une image envoyée est réduite à 2 560 px en WebP, avec une version et le voile par défaut", async () => {
    const saved = await saveLoginBackground(await jpeg(4000, 2000), "photo.JPG");
    expect(typeof saved).toBe("object");
    const meta = loginBackground()!;
    expect(meta.v).toMatch(/^[0-9a-f]{12}$/);
    expect(meta.dim).toBe(55);
    const webp = fs.readFileSync(path.join(DATA_DIR, "branding", "login-bg.webp"));
    const info = await sharp(webp).metadata();
    expect(info.format).toBe("webp");
    expect(info.width).toBe(2560);
    expect(fs.existsSync(path.join(DATA_DIR, "branding", "login-bg.orig.jpg"))).toBe(true);
  });

  it("refuse ce qui n'est pas une image et ce qui est trop lourd, sans rien écrire", async () => {
    expect(await saveLoginBackground(Buffer.from("pas une image"), "x.jpg")).toBe("notImage");
    expect(await saveLoginBackground(Buffer.alloc(LOGIN_BACKGROUND_MAX_BYTES + 1), "x.jpg")).toBe("tooLarge");
    expect(loginBackground()).toBeNull();
  });

  it("la route publique sert le WebP : immuable sous sa version, 304 sur l'ETag", async () => {
    await saveLoginBackground(await jpeg(800, 600), "a.png");
    const { v } = loginBackground()!;
    const pinned = await publicGet(req(`/api/login-background?v=${v}`));
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get("content-type")).toBe("image/webp");
    expect(pinned.headers.get("cache-control")).toContain("immutable");
    const bare = await publicGet(req("/api/login-background"));
    expect(bare.headers.get("cache-control")).toContain("must-revalidate");
    const again = await publicGet(req("/api/login-background", { headers: { "if-none-match": `"${v}"` } }));
    expect(again.status).toBe(304);
  });

  it("le voile est borné, et garde sa valeur quand l'image change", async () => {
    expect(clampDim(0)).toBe(LOGIN_BACKGROUND_DIM_MIN);
    expect(clampDim(500)).toBe(LOGIN_BACKGROUND_DIM_MAX);
    expect(clampDim("n'importe")).toBe(55);
    expect(setLoginBackgroundDim(40)).toBeNull();
    await saveLoginBackground(await jpeg(400, 300), "a.jpg");
    expect(setLoginBackgroundDim(40)?.dim).toBe(40);
    const first = loginBackground()!.v;
    await saveLoginBackground(await jpeg(500, 300), "b.webp");
    expect(loginBackground()!.dim).toBe(40);
    expect(loginBackground()!.v).not.toBe(first);
    expect(fs.readdirSync(path.join(DATA_DIR, "branding")).filter((f) => f.startsWith("login-bg.orig.")).length).toBe(1);
  });

  it("la route d'administration : envoi, voile, retrait — et refus sans administrateur", async () => {
    const form = new FormData();
    form.append("image", new File([new Uint8Array(await jpeg(300, 200))], "fond.jpg", { type: "image/jpeg" }));
    const posted = await adminPost(req("/api/admin/login-background", { method: "POST", body: form }));
    expect(posted.status).toBe(200);
    expect((await (await adminGet(req("/api/admin/login-background"))).json()).background.v).toMatch(/^[0-9a-f]{12}$/);
    const patched = await adminPatch(req("/api/admin/login-background", { method: "PATCH", body: JSON.stringify({ dim: 70 }) }));
    expect((await patched.json()).background.dim).toBe(70);
    expect((await adminDelete(req("/api/admin/login-background", { method: "DELETE" }))).status).toBe(200);
    expect(loginBackground()).toBeNull();

    admin.ok = false;
    expect((await adminGet(req("/api/admin/login-background"))).status).toBe(403);
    expect((await adminPost(req("/api/admin/login-background", { method: "POST", body: new FormData() }))).status).toBe(403);
  });

  it("une longueur annoncée trop grande est refusée avant de lire le corps", async () => {
    const res = await adminPost(req("/api/admin/login-background", { method: "POST", headers: { "content-length": String(20 * 1024 * 1024) }, body: "x" }));
    expect(res.status).toBe(413);
  });
});
