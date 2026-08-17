import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionPayload } from "@/lib/auth";

const mockJellyseerr = {
  getRequests: vi.fn(),
  getRequestsByUser: vi.fn(),
  getMe: vi.fn(),
};
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr: mockJellyseerr }));

beforeEach(() => vi.clearAllMocks());

const adminSession = { role: "admin", jsCookie: "s%3Aadmin" } as SessionPayload;
const guestSession = { role: "guest", jsCookie: "s%3Aguest" } as SessionPayload;

describe("getJellyseerrPendingCount", () => {
  it("admin: the instance-wide pending count via the admin's own cookie", async () => {
    mockJellyseerr.getRequests.mockResolvedValue({ results: [{}, {}], pageInfo: { results: 2 } });
    const { getJellyseerrPendingCount } = await import("@/lib/jellyseerr-scope");
    const count = await getJellyseerrPendingCount(adminSession);
    expect(mockJellyseerr.getRequests).toHaveBeenCalledWith("pending", "s%3Aadmin");
    expect(mockJellyseerr.getMe).not.toHaveBeenCalled();
    expect(count).toBe(2);
  });

  it("guest: only their own still-pending requests, resolved via getMe (not the admin-gated user list)", async () => {
    mockJellyseerr.getMe.mockResolvedValue({ id: 42 });
    mockJellyseerr.getRequestsByUser.mockResolvedValue({
      results: [{ status: 1 }, { status: 1 }, { status: 2 }],
    });
    const { getJellyseerrPendingCount } = await import("@/lib/jellyseerr-scope");
    const count = await getJellyseerrPendingCount(guestSession);
    expect(mockJellyseerr.getMe).toHaveBeenCalledWith("s%3Aguest");
    expect(mockJellyseerr.getRequestsByUser).toHaveBeenCalledWith(42, "s%3Aguest");
    expect(mockJellyseerr.getRequests).not.toHaveBeenCalled();
    expect(count).toBe(2); // only the two status:1 (pending approval) entries
  });

  it("guest with no resolvable Jellyseerr identity: 0, no crash", async () => {
    mockJellyseerr.getMe.mockResolvedValue(null);
    const { getJellyseerrPendingCount } = await import("@/lib/jellyseerr-scope");
    const count = await getJellyseerrPendingCount(guestSession);
    expect(count).toBe(0);
  });

  it("null session (no auth at all): 0, no crash", async () => {
    const { getJellyseerrPendingCount } = await import("@/lib/jellyseerr-scope");
    const count = await getJellyseerrPendingCount(null);
    expect(count).toBe(0);
    expect(mockJellyseerr.getRequests).not.toHaveBeenCalled();
  });
});

describe("getJellyseerrActivityItems", () => {
  it("admin: everyone's requests", async () => {
    mockJellyseerr.getRequests.mockResolvedValue({ results: [{ id: 1 }, { id: 2 }] });
    const { getJellyseerrActivityItems } = await import("@/lib/jellyseerr-scope");
    const items = await getJellyseerrActivityItems(adminSession, 15);
    expect(mockJellyseerr.getRequests).toHaveBeenCalledWith("all", "s%3Aadmin");
    expect(items).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("guest: only their own requests", async () => {
    mockJellyseerr.getMe.mockResolvedValue({ id: 7 });
    mockJellyseerr.getRequestsByUser.mockResolvedValue({ results: [{ id: 9 }] });
    const { getJellyseerrActivityItems } = await import("@/lib/jellyseerr-scope");
    const items = await getJellyseerrActivityItems(guestSession, 15);
    expect(mockJellyseerr.getRequestsByUser).toHaveBeenCalledWith(7, "s%3Aguest");
    expect(items).toEqual([{ id: 9 }]);
  });
});
