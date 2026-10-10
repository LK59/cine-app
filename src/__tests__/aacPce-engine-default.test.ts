// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import { PROBE_ASC, effectivePceAnswer, notePceDecision, notePceCopyWorked, pceCopyAccepted, pceDecisionFacts, takePceCopyRefusal, __testing } from "@/lib/webcodecs/aacPceProbe";
import { aacPlan } from "@/lib/webcodecs/aacConfig";
import { trackAacPlan } from "@/lib/webcodecs/remuxer";
import type { MatroskaTrack } from "@/lib/webcodecs/matroska";

// « Elle s'appelle Ruby » et la piste anglaise 7.1 de « Forrest Gump » sur l'iPhone de Louis
// (10/10/2026, 22:22–22:24, 8.34.1) : la sonde de 8.34.0 avait gardé `ok:false` pour tout le
// navigateur — Ruby se décodait (échec CoreAudio, lecteur serveur), Forrest Gump sortait en L R C
// au lieu d'être copié avec tous ses canaux comme avant le 10/10. Hors Chromium, la réponse globale
// de la sonde n'est plus jamais lue : copie d'abord, et seul un refus constaté pour CETTE forme de
// PCE, à ce build, fait décoder (DECISIONS.md §62).

const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
const SILK = "Mozilla/5.0 (Linux; Android 11; AFTT) AppleWebKit/537.36 (KHTML, like Gecko) Silk/152.4.7 like Chrome/152.0.7977.140 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0";

/** L'AudioSpecificConfig 7.1 à PCE de FFmpeg (pistes anglaises de Forrest Gump, Deadpool…), tête. */
const SEVEN_ONE = Uint8Array.from([0x11, 0x80, 0x04, 0xc8, 0x09, 0x00, 0x20, 0x00, 0xc4, 0x0d, 0x4c, 0x61, 0x76, 0x63]);

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
  it("Safari sans refus gardé : copié tel quel, comme avant le 10/10", () => {
    ua(SAFARI_IOS);
    expect(effectivePceAnswer(PROBE_ASC)).toBe(true);
    expect(trackAacPlan(ruby).action).toBe("copy");
  });

  it("Firefox sans refus gardé : copié tel quel, comme avant", () => {
    ua(FIREFOX);
    expect(trackAacPlan(ruby).action).toBe("copy");
  });

  it("Chromium (Silk sur Fire TV) sans réponse : décodé — son refus est prouvé", () => {
    ua(SILK);
    expect(effectivePceAnswer(PROBE_ASC)).toBeNull();
    expect(trackAacPlan(ruby).action).toBe("decode");
  });

  it("WebKit ignore la réponse globale de la sonde, même à `false`", () => {
    ua(SAFARI_IOS);
    localStorage.setItem(__testing.STORAGE_KEY, JSON.stringify({ ua: SAFARI_IOS, ok: false }));
    expect(trackAacPlan(ruby).action).toBe("copy");
  });

  it("l'ancienne clé (v1, réponse par navigateur) n'est plus lue, et elle est effacée", () => {
    ua(SAFARI_IOS);
    localStorage.setItem(__testing.LEGACY_KEYS[0], JSON.stringify({ ua: SAFARI_IOS, ok: false }));
    expect(trackAacPlan(ruby).action).toBe("copy");
    expect(localStorage.getItem(__testing.LEGACY_KEYS[0])).toBeNull();
    // Chromium non plus ne la lit pas : sa réponse est reposée par la sonde.
    __testing.reset();
    ua(SILK);
    localStorage.setItem(__testing.LEGACY_KEYS[0], JSON.stringify({ ua: SILK, ok: true }));
    expect(effectivePceAnswer(PROBE_ASC)).toBeNull();
  });

  it("Chromium garde son comportement : une réponse de sonde acceptée copie", () => {
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

describe("AAC à PCE — un refus à l'envoi vaut pour cette forme seulement", () => {
  it("refus retenu une seule fois, pour ce PCE : la reconstruction décode, un autre PCE se copie encore", () => {
    ua(SAFARI_IOS);
    notePceDecision("copy", true, PROBE_ASC);
    expect(takePceCopyRefusal()).toBe(true);
    expect(takePceCopyRefusal()).toBe(false);
    expect(trackAacPlan(ruby).action).toBe("decode");
    // Le 7.1 de Forrest Gump n'est pas concerné par le refus du 5.1 de Ruby.
    expect(effectivePceAnswer(SEVEN_ONE)).toBe(true);
    // Et rien n'est écrit dans la réponse globale.
    expect(pceCopyAccepted()).toBeNull();
  });

  it("un refus gardé à un autre build ne compte plus", () => {
    ua(SAFARI_IOS);
    localStorage.setItem(__testing.REFUSALS_KEY, JSON.stringify({ build: "un-ancien-build", shapes: [Array.from(PROBE_ASC, (b) => b.toString(16).padStart(2, "0")).join("")] }));
    expect(trackAacPlan(ruby).action).toBe("copy");
  });

  it("rien à reprendre quand la piste n'a pas été copiée telle quelle", () => {
    notePceDecision("decode", false, PROBE_ASC);
    expect(takePceCopyRefusal()).toBe(false);
  });

  it("hors Chromium, une copie qui donne une image ne grave rien : c'est le comportement par défaut", () => {
    ua(SAFARI_IOS);
    notePceDecision("copy", true, PROBE_ASC);
    notePceCopyWorked();
    expect(pceCopyAccepted()).toBeNull();
  });

  it("la ligne start porte le plan, la réponse suivie et le repli après un refus", () => {
    ua(SAFARI_IOS);
    notePceDecision("copy", true, PROBE_ASC);
    expect(pceDecisionFacts()).toEqual({ aacPcePlan: "copy", aacPceAnswer: true });
    takePceCopyRefusal();
    notePceDecision("decode", false, PROBE_ASC);
    expect(pceDecisionFacts()).toEqual({ aacPcePlan: "decode", aacPceAnswer: false, aacPceFallback: "copie refusée → décodage" });
  });
});
