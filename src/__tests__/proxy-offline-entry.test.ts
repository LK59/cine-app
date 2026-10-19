import { describe, it, expect, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * `/hors-ligne` passe le proxy sans session (DECISIONS.md §109) : le service worker la demande sans
 * cookie pour la garder. Une redirection vers `/login` ne serait pas une panne visible — juste une
 * réserve qui ne se remplit jamais (voir `ACTIFS_PUBLICS` et l'histoire de `/splash`).
 */
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 604800,
  shouldRefresh: () => false,
  refreshSessionToken: async () => "renouvelé",
}));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn() } }));
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => null }));

function anonymous(pathname: string): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method: "GET", headers: new Headers(), cookies: { get: () => undefined } } as unknown as NextRequest;
}

describe("proxy — l'entrée hors ligne", () => {
  it("laisse passer /hors-ligne sans session, et pas l'accueil", async () => {
    const { proxy } = await import("@/proxy");
    const entry = await proxy(anonymous("/hors-ligne"));
    expect(entry.headers.get("location")).toBeNull();
    const home = await proxy(anonymous("/"));
    expect(home.headers.get("location") ?? "").toContain("/login");
  });
});
