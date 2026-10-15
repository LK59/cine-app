import { describe, it, expect } from "vitest";
import { timedRoute } from "@/lib/serverTiming";
import { serverTimingApp } from "@/lib/webcodecs/byteSource";

/**
 * L'ouverture attendait le catalogue sans savoir si c'était le serveur ou la route jusqu'à lui
 * (15/10/2026) : chaque route de l'ouverture dit son propre temps, au format que le lecteur lit déjà.
 */
describe("timedRoute", () => {
  it("ajoute le temps de la route, lisible comme celui du relais vidéo", async () => {
    const GET = timedRoute(async (n: number) => {
      await new Promise((r) => setTimeout(r, 20));
      return Response.json({ n });
    });
    const res = await GET(3);
    expect(await res.json()).toEqual({ n: 3 });
    const app = serverTimingApp(res.headers.get("Server-Timing"));
    expect(app).not.toBeNull();
    expect(app!).toBeGreaterThanOrEqual(15);
  });

  it("laisse passer une réponse aux en-têtes figés, sans la mesure", async () => {
    const frozen = await fetch("data:text/plain,ok");
    const res = await timedRoute(async () => frozen)();
    expect(res).toBe(frozen);
    expect(await res.text()).toBe("ok");
  });

  it("ne retient pas l'erreur de la route : elle reste celle de la route", async () => {
    const boom = new Error("amont");
    await expect(timedRoute(async () => { throw boom; })()).rejects.toBe(boom);
  });
});
