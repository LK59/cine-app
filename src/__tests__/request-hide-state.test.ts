import { describe, it, expect, vi } from "vitest";
import type { NextRequest } from "next/server";

const cfg = vi.hoisted(() => ({ enabled: false, account: "tv" }));
vi.mock("@/lib/config", () => ({ config: { requestHide: cfg } }));
vi.mock("@/lib/activity/adminOnly", () => ({ adminOnly: async () => ({ u: "admin", role: "admin" }) }));
vi.mock("@/lib/requestHide/run", () => ({ decide: vi.fn(), requestHideView: vi.fn(async () => ({ titles: [] })), setAuto: vi.fn(), syncRequestHide: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

import { GET } from "@/app/api/admin/request-hide/route";

const req = (url: string) => ({ nextUrl: new URL(url) }) as unknown as NextRequest;

// 18/11/2026 : la page Jellyseerr demande à chaque ouverture si le masquage existe ; sur une installation
// sans lui, la réponse était un 404 — une erreur en console pour un simple « non ».
describe("GET /api/admin/request-hide?state=1", () => {
  it("répond 200 { enabled: false } quand la fonction est coupée", async () => {
    cfg.enabled = false;
    const res = await GET(req("http://l/api/admin/request-hide?state=1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false });
  });
  it("le reste de la route reste introuvable quand elle est coupée", async () => {
    cfg.enabled = false;
    expect((await GET(req("http://l/api/admin/request-hide"))).status).toBe(404);
  });
  it("dit le compte quand elle est là", async () => {
    cfg.enabled = true;
    expect(await (await GET(req("http://l/api/admin/request-hide?state=1"))).json()).toEqual({ enabled: true, account: "tv" });
  });
});
