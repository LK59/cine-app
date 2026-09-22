import { describe, it, expect } from "vitest";
import { withoutHdr10Plus } from "@/lib/webcodecs/codecConfig";
import { isChromiumOnWindows } from "@/lib/webkitEngine";

/**
 * 22/09/2026 : un épisode Dolby Vision + HDR10+ trop sombre dans Chrome sous Windows, juste
 * partout ailleurs ; un film Dolby Vision + HDR10 sans HDR10+, en 4K aussi, juste dans ce Chrome.
 */
const unit = (bytes: number[]) => [(bytes.length >> 24) & 255, (bytes.length >> 16) & 255, (bytes.length >> 8) & 255, bytes.length & 255, ...bytes];
// En-têtes NAL HEVC : type << 1. SEI préfixe = 39, tranche IDR = 19.
const SLICE = unit([19 << 1, 1, 0xaf, 0x11, 0x22]);
const HDR10_PLUS = unit([39 << 1, 1, 4, 12, 0xb5, 0x00, 0x3c, 0x00, 0x01, 0x04, 1, 2, 3, 4, 5, 6, 0x80]);
const OTHER_SEI = unit([39 << 1, 1, 137, 3, 1, 2, 3, 0x80]); // mastering display, par exemple
const T35_OTHER = unit([39 << 1, 1, 4, 8, 0xb5, 0x00, 0x31, 0x47, 0x41, 0x39, 1, 2, 0x80]); // T.35 d'un autre fournisseur

describe("withoutHdr10Plus", () => {
  it("retire l'unité HDR10+ et garde tout le reste, dans l'ordre", () => {
    const out = withoutHdr10Plus(new Uint8Array([...OTHER_SEI, ...HDR10_PLUS, ...SLICE]), 4);
    expect(Array.from(out)).toEqual([...OTHER_SEI, ...SLICE]);
  });

  it("rend l'image telle quelle, sans copie, quand il n'y a rien à retirer", () => {
    const data = new Uint8Array([...OTHER_SEI, ...T35_OTHER, ...SLICE]);
    expect(withoutHdr10Plus(data, 4)).toBe(data);
  });

  it("laisse une image illisible intacte plutôt que d'en couper une partie", () => {
    const broken = new Uint8Array([0, 0, 0, 99, 39 << 1, 1]);
    expect(withoutHdr10Plus(broken, 4)).toBe(broken);
  });
});

describe("isChromiumOnWindows", () => {
  it("vise Chrome et Edge sous Windows, et eux seuls", () => {
    expect(isChromiumOnWindows("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36")).toBe(true);
    expect(isChromiumOnWindows("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0")).toBe(true);
    expect(isChromiumOnWindows("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0")).toBe(false);
    expect(isChromiumOnWindows("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36")).toBe(false);
    expect(isChromiumOnWindows("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36")).toBe(false);
  });
});
