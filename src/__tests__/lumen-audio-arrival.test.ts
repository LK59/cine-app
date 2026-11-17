import { describe, expect, it } from "vitest";
import { audioSegmentArrivalMs } from "@/components/player/lumen/lumenLog";

// Le premier segment de la nouvelle piste reçu, mesuré depuis le geste (17/11/2026) : la ligne `audio` d'un
// changement par `audioTracks` disait toujours ~2 000 ms, le délai de sa vérification.
const base = "https://app.example/api/lumen/item/6-abc/sess1234";
const entry = (path: string, startTime: number, responseEnd: number) => ({ name: `${base}/${path}`, startTime, responseEnd });

describe("audioSegmentArrivalMs", () => {
  it("le premier segment de la piste demandée commencé après le geste, en ms depuis le geste", () => {
    const seen = [
      entry("a2/40.m4s", 900, 950), // l'ancienne piste, avant le geste
      entry("a3/40.m4s", 990, 1100), // la nouvelle, mais demandée avant le geste : pas la nôtre
      entry("v/41.m4s", 1010, 1300),
      entry("a3/41.m4s", 1020, 1450),
      entry("a3/42.m4s", 1030, 1400),
    ];
    expect(audioSegmentArrivalMs("sess1234", 3, 1000, seen)).toBe(400);
  });

  it("le rendu « dialogues » de la piste compte (§193) ; une autre lecture, une liste ou un init non", () => {
    const seen = [
      { name: "https://app.example/api/lumen/item/6-abc/autre999/a3/41.m4s", startTime: 1010, responseEnd: 1050 },
      entry("a3.m3u8", 1005, 1060),
      entry("init-a3.mp4", 1006, 1070),
      entry("a3d1xdeadbeef/41.m4s", 1020, 1600),
    ];
    expect(audioSegmentArrivalMs("sess1234", 3, 1000, seen)).toBe(600);
  });

  it("rien de reçu : undefined", () => {
    expect(audioSegmentArrivalMs("sess1234", 3, 1000, [entry("a2/41.m4s", 1010, 1200)])).toBeUndefined();
    expect(audioSegmentArrivalMs("sess1234", 3, 1000, [entry("a33/41.m4s", 1010, 1200)])).toBeUndefined();
  });
});
