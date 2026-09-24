import { describe, it, expect } from "vitest";
import { castRouteActive } from "@/lib/castRoute";

// Un lecteur remonté pendant une diffusion arrive après l'événement qui l'annonçait : il doit lire
// l'état de la route, pas seulement l'écouter (24/09/2026, 27 minutes sur une télé écrites « sans
// diffusion »).
const video = (over: Record<string, unknown>) => over as unknown as HTMLVideoElement;

describe("castRouteActive", () => {
  it("voit une route AirPlay déjà prise, sous WebKit", () => {
    expect(castRouteActive(video({ webkitCurrentPlaybackTargetIsWireless: true }))).toBe(true);
  });

  it("voit un appareil distant connecté, par l'API standard", () => {
    expect(castRouteActive(video({ remote: { state: "connected" } }))).toBe(true);
    expect(castRouteActive(video({ remote: { state: "connecting" } }))).toBe(false);
  });

  it("dit non sans route, et ne lève jamais", () => {
    expect(castRouteActive(video({ webkitCurrentPlaybackTargetIsWireless: false }))).toBe(false);
    const hostile = {};
    Object.defineProperty(hostile, "remote", { get: () => { throw new Error("refusé"); } });
    expect(castRouteActive(hostile as HTMLVideoElement)).toBe(false);
  });
});
