import { describe, it, expect, vi } from "vitest";
import { withCappedLightLevels } from "@/lib/webcodecs/codecConfig";
import { cappedColour } from "@/lib/webcodecs/remuxer";
import { hdrCapRelevant, hdrLightCap, isChromiumOnWindows, readHdrCapChoice, resolveHdrCap, writeHdrCapChoice } from "@/lib/webcodecs/hdrDisplay";

/**
 * 22/09/2026 : Chrome sous Windows ramène un film HDR sous la lumière maximale annoncée — *2012*
 * (MaxCLL 4451) très sombre sur un écran SDR, *Dirty Dancing* (657) juste, Firefox juste partout.
 */
const nal = (bytes: number[]) => [(bytes.length >> 24) & 255, (bytes.length >> 16) & 255, (bytes.length >> 8) & 255, bytes.length & 255, ...bytes];
const SLICE = nal([19 << 1, 1, 0xaf, 0x11]);
// SEI préfixe : content light level (144) MaxCLL 4451 = 0x1163, MaxFALL 700 = 0x02bc.
const CLL = nal([39 << 1, 1, 144, 4, 0x11, 0x63, 0x02, 0xbc, 0x80]);
// Mastering display (137) : 16 octets de primaires/point blanc, max 4000 nits, min 0x01020304.
const MDCV = nal([39 << 1, 1, 137, 24, ...new Array(16).fill(0x11), ...[0x02, 0x62, 0x5a, 0x11], ...[1, 2, 3, 4], 0x80]);
const WINDOWS_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

/** Ce qu'un décodeur lit : les octets d'échappement retirés. */
const rbsp = (bytes: Uint8Array) => {
  const out: number[] = [];
  let zeros = 0;
  for (const b of bytes) {
    if (zeros >= 2 && b === 3) { zeros = 0; continue; }
    out.push(b);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
};

const units = (data: Uint8Array) => {
  const out: Uint8Array[] = [];
  for (let at = 0; at + 4 < data.length; ) {
    const n = (data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3];
    out.push(data.subarray(at + 4, at + 4 + n));
    at += 4 + n;
  }
  return out;
};

describe("withCappedLightLevels", () => {
  it("plafonne MaxCLL, MaxFALL et la luminance de mastering, sans toucher à l'image", () => {
    const out = units(withCappedLightLevels(new Uint8Array([...CLL, ...MDCV, ...SLICE]), 4, 650));
    const cll = new DataView(rbsp(out[0]).buffer);
    expect([cll.getUint16(4), cll.getUint16(6)]).toEqual([650, 650]);
    const mdcv = new DataView(rbsp(out[1]).buffer);
    expect(mdcv.getUint32(4 + 16)).toBe(6_500_000);
    expect(mdcv.getUint32(4 + 20)).toBe(0x01020304); // le minimum ne bouge pas
    expect(Array.from(out[2])).toEqual(Array.from(units(new Uint8Array(SLICE))[0]));
  });

  it("rend l'image telle quelle, sans copie, quand rien ne dépasse", () => {
    // MaxCLL 657, MaxFALL 127 : sous un plafond de 700, rien ne change.
    const low = new Uint8Array(nal([39 << 1, 1, 144, 4, 0x02, 0x91, 0x00, 0x7f, 0x80]));
    expect(withCappedLightLevels(low, 4, 700)).toBe(low);
    const slice = new Uint8Array(SLICE);
    expect(withCappedLightLevels(slice, 4, 650)).toBe(slice);
  });

  it("remet les octets d'échappement que la valeur réécrite exige", () => {
    // MaxFALL plafonné à 3 derrière un MaxCLL nul : 00 00 00 03 doit s'écrire 00 00 03 00 03.
    const out = units(withCappedLightLevels(new Uint8Array(nal([39 << 1, 1, 144, 4, 0x00, 0x00, 0x11, 0x63, 0x80])), 4, 3))[0];
    expect(Array.from(out.subarray(2))).toEqual([144, 4, 0x00, 0x00, 0x03, 0x00, 0x03, 0x80]);
    expect(Array.from(rbsp(out.subarray(2)))).toEqual([144, 4, 0, 0, 0, 3, 0x80]);
  });
});

describe("le plafond de lumière HDR", () => {
  const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1";
  const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0";

  it("vaut 203 d'office sur Chrome Windows avec un écran SDR, et rien ailleurs", () => {
    // 22/09/2026 : toute la gamme comparée à l'œil, 203 — le blanc de référence de Chrome sur
    // écran SDR — est le plus fidèle, mieux que Firefox.
    expect(resolveHdrCap("auto", WINDOWS_CHROME, false)).toBe(203);
    expect(resolveHdrCap("auto", WINDOWS_CHROME + " Edg/153.0", false)).toBe(203);
    expect(resolveHdrCap("auto", WINDOWS_CHROME, true)).toBeNull();
    expect(resolveHdrCap("auto", WINDOWS_CHROME, null)).toBeNull();
    expect(resolveHdrCap("auto", FIREFOX, false)).toBeNull();
    expect(resolveHdrCap("auto", IPHONE, false)).toBeNull();
  });

  it("vaut 203 aussi sur Chrome Linux, mais pas sur Android ni Firefox Linux", () => {
    const linux = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
    expect(resolveHdrCap("auto", linux, false)).toBe(203);
    expect(resolveHdrCap("auto", linux, true)).toBeNull();
    expect(resolveHdrCap("auto", "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36", false)).toBeNull();
    expect(resolveHdrCap("auto", "Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0", false)).toBeNull();
  });

  it("suit un choix fait à la main, là où le réglage a un sens", () => {
    expect(resolveHdrCap("native", WINDOWS_CHROME, false)).toBeNull();
    expect(resolveHdrCap(150, WINDOWS_CHROME, false)).toBe(150);
    expect(resolveHdrCap(150, FIREFOX, false)).toBe(150);
    // Sur un écran HDR ou sous WebKit, un choix resté en mémoire ne s'applique pas.
    expect(resolveHdrCap(150, WINDOWS_CHROME, true)).toBeNull();
    expect(resolveHdrCap(150, IPHONE, false)).toBeNull();
  });

  it("n'est proposé ni sous WebKit, ni sur un écran HDR", () => {
    expect(hdrCapRelevant(WINDOWS_CHROME, false)).toBe(true);
    expect(hdrCapRelevant(FIREFOX, false)).toBe(true);
    expect(hdrCapRelevant(IPHONE, false)).toBe(false);
    expect(hdrCapRelevant(WINDOWS_CHROME, true)).toBe(false);
    expect(hdrCapRelevant(WINDOWS_CHROME, null)).toBe(false);
  });

  it("garde le choix sur l'appareil, « auto » par défaut", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    expect(readHdrCapChoice()).toBe("auto");
    writeHdrCapChoice(150);
    expect(readHdrCapChoice()).toBe(150);
    writeHdrCapChoice("native");
    expect(readHdrCapChoice()).toBe("native");
    writeHdrCapChoice("auto");
    expect(store.has("cine.hdrLightCap")).toBe(false);
    // Une valeur qui n'est pas proposée ne s'applique pas.
    store.set("cine.hdrLightCap", "7");
    expect(readHdrCapChoice()).toBe("auto");
    vi.unstubAllGlobals();
    expect(isChromiumOnWindows(WINDOWS_CHROME + " Edg/153.0")).toBe(true);
  });

  it("garde le choix pour la séance quand le stockage est refusé", () => {
    // Navigation privée ou stockage bloqué : l'écriture échouait en silence, le menu montrait
    // 400 et la reconstruction qui suivait relisait le stockage — « auto ».
    const refused = () => {
      throw new DOMException("refusé", "SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: refused, setItem: refused, removeItem: refused });
    vi.stubGlobal("navigator", { userAgent: WINDOWS_CHROME });
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q !== "(dynamic-range: high)" }));
    writeHdrCapChoice(400);
    expect(readHdrCapChoice()).toBe(400);
    expect(hdrLightCap()).toBe(400);
    writeHdrCapChoice("native");
    expect(readHdrCapChoice()).toBe("native");

    // Le stockage revenu, c'est lui qui fait foi de nouveau.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    writeHdrCapChoice("auto");
    expect(readHdrCapChoice()).toBe("auto");
    store.set("cine.hdrLightCap", "650");
    expect(readHdrCapChoice()).toBe(650);
    vi.unstubAllGlobals();
  });
});

describe("cappedColour", () => {
  it("annonce le plafond pour un PQ qui n'annonce rien, et ne touche pas un SDR", () => {
    // Sans MaxCLL, Chrome suppose 1 000 nits : le plafond ne ferait rien sur ces fichiers-là.
    expect(cappedColour({ transferCharacteristics: 16 }, 150)).toMatchObject({ maxContentLightNits: 150, maxFrameAverageNits: 150 });
    expect(cappedColour({ transferCharacteristics: 16, maxContentLightNits: 4451, maxFrameAverageNits: 90 }, 150))
      .toMatchObject({ maxContentLightNits: 150, maxFrameAverageNits: 90 });
    expect(cappedColour({ transferCharacteristics: 1 }, 150)).toEqual({ transferCharacteristics: 1 });
    expect(cappedColour({ transferCharacteristics: 16 }, null)).toEqual({ transferCharacteristics: 16 });
  });
});
