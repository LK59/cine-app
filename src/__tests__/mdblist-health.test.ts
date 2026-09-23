import { describe, it, expect, vi } from "vitest";

// MDBList n'est plus appelé par le contrôle d'état : 1 440 requêtes par jour pour un quota de
// 1 000. Seule la présence de la clé est vérifiée.
describe("le contrôle de MDBList", () => {
  it("ne fait aucune requête", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    process.env.MDBLIST_API_KEY = "k";
    const { pingMdblist } = await import("@/lib/healthChecks");
    expect((await pingMdblist()).status).toBe("ok");
    delete process.env.MDBLIST_API_KEY;
    expect((await pingMdblist()).status).toBe("down");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
