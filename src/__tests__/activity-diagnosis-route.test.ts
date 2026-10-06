import { describe, it, expect, vi, beforeEach } from "vitest";

const { clearDiagnosis } = vi.hoisted(() => ({ clearDiagnosis: vi.fn() }));
vi.mock("@/lib/activity/adminOnly", () => ({ adminOnly: async () => ({ role: "admin" }) }));
vi.mock("@/lib/activity/diagnosisCleared", () => ({ clearDiagnosis }));
vi.mock("@/lib/activity/accounts", () => ({ failingTitleKeys: () => ["a", "b", "c"] }));

import { POST } from "@/app/api/admin/activity/diagnosis/route";

const req = (body: unknown) => ({ json: async () => body }) as never;

beforeEach(() => clearDiagnosis.mockClear());

describe("POST /api/admin/activity/diagnosis", () => {
  // « Tout effacer » vide la liste : tous les titres de la période, pas seulement ceux affichés.
  it("efface tous les titres en échec de la période", async () => {
    const res = await POST(req({ all: true }));
    expect(res.status).toBe(200);
    expect(clearDiagnosis).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("efface les titres nommés, et refuse une demande vide", async () => {
    await POST(req({ keys: ["x", 3, ""] }));
    expect(clearDiagnosis).toHaveBeenCalledWith(["x"]);
    expect((await POST(req({}))).status).toBe(400);
  });
});
