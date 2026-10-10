// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { PROBE_ASC, effectivePceAnswer, notePceDecision, notePceCopyWorked, pceCopyAccepted, pceDecisionFacts, takePceCopyRefusal, __testing } from "@/lib/webcodecs/aacPceProbe";
import { aacPlan } from "@/lib/webcodecs/aacConfig";
import { trackAacPlan } from "@/lib/webcodecs/remuxer";
import type { MatroskaTrack } from "@/lib/webcodecs/matroska";

// « Elle s'appelle Ruby » sur l'iPhone de Louis (10/10/2026, 21:52) : sans réponse gardée, le PCE
// était décodé « par sûreté » — et le décodeur de Safari (CoreAudio) échoue sur ce PCE
// (« InternalAudioDecoderCocoa decoding failed »), d'où le lecteur serveur. Hors Chromium, la
// réponse par défaut est désormais celle d'avant le 10/10 : copier ; un refus à l'envoi est retenu
// et la reconstruction décode (DECISIONS.md §62).

const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
const SILK = "Mozilla/5.0 (Linux; Android 11; AFTT) AppleWebKit/537.36 (KHTML, like Gecko) Silk/152.4.7 like Chrome/152.0.7977.140 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

function ua(agent: string) {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(agent);
}

const ruby = { number: 2, type: "audio", codecId: "A_AAC", codecPrivate: PROBE_ASC, audio: { channels: 6, sampleRate: 48000 } } as unknown as MatroskaTrack;

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  __testing.reset();
});

describe("AAC à PCE — la réponse par défaut suit le moteur", () => {
  it("Safari sans réponse gardée : copié tel quel, comme avant le 10/10", () => {
    ua(SAFARI_IOS);
    expect(effectivePceAnswer()).toBe(true);
    expect(trackAacPlan(ruby).action).toBe("copy");
  });

  it("Firefox sans réponse gardée : copié tel quel, comme avant", () => {
    ua(FIREFOX);
    expect(trackAacPlan(ruby).action).toBe("copy");
  });

  it("Chromium (Silk sur Fire TV) sans réponse gardée : décodé — son refus est prouvé", () => {
    ua(SILK);
    expect(effectivePceAnswer()).toBeNull();
    expect(trackAacPlan(ruby).action).toBe("decode");
  });

  it("une réponse gardée l'emporte sur le moteur, dans les deux sens", () => {
    ua(SAFARI_IOS);
    localStorage.setItem(__testing.STORAGE_KEY, JSON.stringify({ ua: SAFARI_IOS, ok: false }));
    expect(trackAacPlan(ruby).action).toBe("decode");
    ua(SILK);
    localStorage.setItem(__testing.STORAGE_KEY, JSON.stringify({ ua: SILK, ok: true }));
    expect(trackAacPlan(ruby).action).toBe("copy");
  });

  it("une acceptation copie tel quel, avant toute réécriture", () => {
    // Un PCE équivalent au 5.1 standard serait réécrit si le navigateur le refuse ; accepté, il part
    // tel qu'il était — l'ancien comportement, octet pour octet.
    const standardLike = Uint8Array.from([0x11, 0x80, 0x04, 0xc8, 0x44, 0x00, 0x20, 0x00, 0xc4, 0x0d, 0x56, 0xe5, 0x00]);
    expect(aacPlan(standardLike, { pceAccepted: true }).action).toBe("copy");
  });
});

describe("AAC à PCE — la copie refusée à l'envoi n'est retentée qu'en décodant", () => {
  it("refus retenu une seule fois, la reconstruction décode", () => {
    ua(SAFARI_IOS);
    notePceDecision("copy", true);
    expect(takePceCopyRefusal()).toBe(true);
    expect(pceCopyAccepted()).toBe(false);
    expect(takePceCopyRefusal()).toBe(false);
    expect(trackAacPlan(ruby).action).toBe("decode");
  });

  it("rien à reprendre quand la piste n'a pas été copiée telle quelle", () => {
    notePceDecision("decode", false);
    expect(takePceCopyRefusal()).toBe(false);
  });

  it("une copie qui donne une image est gardée comme acceptée", () => {
    ua(SAFARI_IOS);
    notePceDecision("copy", true);
    notePceCopyWorked();
    expect(pceCopyAccepted()).toBe(true);
  });

  it("le plan et la réponse vont sur la ligne start", () => {
    ua(SAFARI_IOS);
    notePceDecision("copy", true);
    expect(pceDecisionFacts()).toEqual({ aacPcePlan: "copy", aacPceAnswer: "inconnue" });
  });
});
