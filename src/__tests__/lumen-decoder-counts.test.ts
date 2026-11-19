import { describe, it, expect } from "vitest";
import { decodedFrom, type DemuxedAudioPacket, type RawFrame } from "@/lib/webcodecs/audioDemux";
import { LUMEN_DEC_VALUE, noteLumenWorker, takeLumenDecoderField } from "@/lib/webcodecs/lumenFacts";

// Les décodeurs « Son par Lumen » comptés pour la ligne `stop` (§197, 19/11/2026) : une fuite — un
// décodeur jamais refermé après un saut — doit se lire au journal dès le premier soir.
const packets = async function* (n: number) {
  for (let i = 0; i < n; i++) yield { data: new Uint8Array(1), timestamp: i * 0.25, duration: 0.25 } as DemuxedAudioPacket;
};
const opener = async (onFrame: (f: RawFrame) => void) => ({
  decode: async (p: DemuxedAudioPacket) => onFrame({ planes: [new Float32Array(12_000)], sampleRate: 48000, timestamp: p.timestamp }),
  flush: async () => {},
  close: () => {},
});

describe("lumenDec — décodeurs ouverts et fermés par séance", () => {
  it("rien d'ouvert : pas de champ, la ligne d'une séance sans son décodé ne change pas", () => {
    takeLumenDecoderField();
    expect(takeLumenDecoderField()).toEqual({});
  });

  it("une lecture finie, une abandonnée par un saut : deux ouverts, deux fermés, plus rien d'ouvert", async () => {
    takeLumenDecoderField();
    for await (const frame of decodedFrom(packets(4), opener, 0, 48000)) void frame;
    const seek = decodedFrom(packets(40), opener, 0, 48000);
    await seek.next();
    await seek.return(undefined);
    noteLumenWorker("created");
    const { lumenDec } = takeLumenDecoderField();
    expect(lumenDec).toBe("o2 c2 n0 m1 w1 l0 p0");
    expect(LUMEN_DEC_VALUE.test(lumenDec!)).toBe(true);
  });

  it("un décodeur resté ouvert se lit dans `n`, et `m` dit combien l'étaient en même temps", async () => {
    takeLumenDecoderField();
    const a = decodedFrom(packets(40), opener, 0, 48000);
    const b = decodedFrom(packets(40), opener, 0, 48000);
    await a.next();
    await b.next();
    expect(takeLumenDecoderField().lumenDec).toBe("o2 c0 n2 m2 w0 l0 p0");
    await a.return(undefined);
    await b.return(undefined);
    expect(takeLumenDecoderField().lumenDec).toBe("o0 c2 n0 m2 w0 l0 p0");
  });
});
