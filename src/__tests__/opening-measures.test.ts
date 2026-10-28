import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Les deux mesures ajoutées le 28/10/2026 à l'ouverture, qui ne décident de rien : ce que le service
 * worker a coûté à la première requête du flux (`swMs`), et ce que le navigateur prédit de la
 * lecture (« capacités : … » dans la trace).
 */

const traced: string[] = [];
vi.mock("@/lib/webcodecs/trace", () => ({ trace: (line: string) => traced.push(line) }));

import { watchFirstStreamRequest } from "@/lib/streamRequestTiming";
import { probeDecodingInfo } from "@/lib/webcodecs/decodingInfo";
import type { MatroskaTrack } from "@/lib/webcodecs/matroska";

/** Un observateur qui livre d'un coup les entrées qu'on lui donne. */
function fakeObserver(entries: Partial<PerformanceResourceTiming>[]) {
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      constructor(private readonly cb: (list: { getEntries: () => unknown[] }) => void) {}
      observe() {
        this.cb({ getEntries: () => entries });
      }
      disconnect() {}
    }
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  traced.length = 0;
});

describe("le coût du service worker à la première requête du flux", () => {
  it("l'écart entre le worker et le départ de la requête, pour la première requête du flux après le montage", () => {
    fakeObserver([
      { name: "https://app.laterna.fr/api/jellyfin/stream/x/stream.mkv", startTime: 5, workerStart: 6, fetchStart: 400 },
      { name: "https://app.laterna.fr/api/cinema/movies", startTime: 120, workerStart: 121, fetchStart: 125 },
      { name: "https://app.laterna.fr/api/jellyfin/stream/x/stream.mkv", startTime: 130, workerStart: 131.4, fetchStart: 212 },
      { name: "https://app.laterna.fr/api/jellyfin/stream/x/stream.mkv", startTime: 300, workerStart: 301, fetchStart: 303 },
    ]);
    expect(watchFirstStreamRequest(100).fields()).toEqual({ swMs: 81 });
  });

  it("une requête qui n'a touché aucun worker le dit ; rien tant qu'aucune n'est finie", () => {
    fakeObserver([{ name: "https://app.laterna.fr/api/jellyfin/stream/x/stream.mkv", startTime: 10, workerStart: 0, fetchStart: 10 }]);
    expect(watchFirstStreamRequest(0).fields()).toEqual({ sw: "hors" });
    fakeObserver([]);
    expect(watchFirstStreamRequest(0).fields()).toEqual({});
  });
});

describe("ce que le navigateur prédit de la lecture", () => {
  const track = { video: { width: 3840, height: 1632, colour: { transferCharacteristics: 16, primaries: 9 } }, defaultDurationNs: 41_708_333 } as unknown as MatroskaTrack;

  it("pose la question avec la taille, le débit et le HDR du fichier, et trace la réponse", async () => {
    const decodingInfo = vi.fn(async () => ({ supported: true, smooth: false, powerEfficient: true }));
    vi.stubGlobal("navigator", { mediaCapabilities: { decodingInfo } });
    probeDecodingInfo('video/mp4; codecs="hvc1.2.4.L153.B0"', track, 10_000_000_000, 8000);
    await Promise.resolve();
    await Promise.resolve();
    expect(decodingInfo).toHaveBeenCalledWith({
      type: "media-source",
      video: expect.objectContaining({ width: 3840, height: 1632, bitrate: 10_000_000, transferFunction: "pq", colorGamut: "rec2020" }),
    });
    expect(traced[0]).toMatch(/^capacités : lisible, pas fluide, économe/);
  });

  it("sans l'API, ou sur un refus : rien", async () => {
    vi.stubGlobal("navigator", {});
    probeDecodingInfo("video/mp4", track, 1, 1);
    vi.stubGlobal("navigator", { mediaCapabilities: { decodingInfo: () => Promise.reject(new TypeError("x")) } });
    probeDecodingInfo("video/mp4", track, 1, 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(traced).toEqual([]);
  });
});
