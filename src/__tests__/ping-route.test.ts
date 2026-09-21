import { describe, it, expect, vi, beforeEach } from "vitest";

// La sonde de santé de Docker : elle ne dépend que de ce processus et de sa base, jamais des
// services en amont — un Jellyfin en redémarrage ne rend pas cette application malade.

const prepare = vi.fn();
vi.mock("@/lib/db", () => ({ getDb: () => ({ prepare }) }));

beforeEach(() => {
  vi.clearAllMocks();
  prepare.mockReturnValue({ get: () => ({ 1: 1 }) });
});

describe("GET /api/ping", () => {
  it("répond oui quand la base répond", async () => {
    const { GET } = await import("@/app/api/ping/route");
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("répond non, sans lever, quand la base ne s'ouvre pas", async () => {
    prepare.mockImplementation(() => {
      throw new Error("SQLITE_CANTOPEN");
    });
    const { GET } = await import("@/app/api/ping/route");
    expect(GET().status).toBe(503);
  });

  it("s'ouvre sans session : la sonde n'a pas de cookie", async () => {
    const { isPublicPath } = await import("@/lib/publicPaths");
    expect(isPublicPath("/api/ping")).toBe(true);
  });
});
