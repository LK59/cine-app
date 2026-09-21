import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const mockLog = vi.fn();
vi.mock("@/lib/logger", () => ({ logClientError: (...a: unknown[]) => mockLog(...a) }));

function fakeReq(body: unknown, cookie = "t"): NextRequest {
  return {
    cookies: { get: (n: string) => (n === "cine_session" && cookie ? { value: cookie } : undefined) },
    headers: new Headers({ "user-agent": "iPhone Safari" }),
    json: async () => {
      if (body instanceof Error) throw body;
      return body;
    },
  } as unknown as NextRequest;
}

const post = async (body: unknown, cookie?: string) => {
  const { POST } = await import("@/app/api/client-error/route");
  return POST(fakeReq(body, cookie));
};

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySessionFull.mockResolvedValue({ u: "mathis", role: "user" });
});

describe("POST /api/client-error", () => {
  it("écrit l'erreur au nom du compte de la session, avec le navigateur", async () => {
    const res = await post({ source: "window", message: "x is undefined", user: "louis" });
    expect(res.status).toBe(200);
    expect(mockLog).toHaveBeenCalledWith(
      "mathis",
      expect.objectContaining({ source: "window", message: "x is undefined", agent: "iPhone Safari" })
    );
  });

  it("n'écoute pas un visiteur sans session — une adresse publique remplirait le journal", async () => {
    mockVerifySessionFull.mockResolvedValue(null);
    expect((await post({ message: "boom" }, "")).status).toBe(403);
    expect(mockLog).not.toHaveBeenCalled();
  });

  it("refuse un corps illisible sans rien écrire", async () => {
    expect((await post(new Error("pas du JSON"))).status).toBe(400);
    expect((await post([1, 2])).status).toBe(400);
    expect((await post("texte")).status).toBe(400);
    expect(mockLog).not.toHaveBeenCalled();
  });
});
