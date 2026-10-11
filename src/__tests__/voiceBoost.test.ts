// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { mixGains, layoutFromLevels, useVoiceBoost } from "@/lib/voiceBoost";

// « Voix claires » (sonde 11/10/2026). Ce qui doit tenir : un compte qui n'y touche pas garde le
// chemin audio d'avant — aucun AudioContext, aucune MediaElementSource — et l'attache n'a lieu
// qu'une fois par élément (un second createMediaElementSource lève une erreur).

const created = { contexts: 0, sources: 0 };

function param() {
  return { value: 0, setTargetAtTime: vi.fn() };
}
function node(extra: Record<string, unknown> = {}) {
  const n: Record<string, unknown> = { connect: vi.fn((x: unknown) => x), ...extra };
  return n;
}
class FakeAudioContext {
  state = "running";
  sampleRate = 48000;
  currentTime = 0;
  baseLatency = 0.01;
  destination = node();
  constructor() {
    created.contexts++;
  }
  createMediaElementSource() {
    created.sources++;
    return node();
  }
  createChannelSplitter() {
    return node();
  }
  createChannelMerger() {
    return node();
  }
  createGain() {
    return node({ gain: param() });
  }
  createBiquadFilter() {
    return node({ frequency: param(), Q: param(), gain: param(), type: "" });
  }
  createDynamicsCompressor() {
    return node({ threshold: param(), ratio: param(), knee: param(), attack: param(), release: param() });
  }
  createAnalyser() {
    return node({ fftSize: 0, getFloatTimeDomainData: (b: Float32Array) => b.fill(0) });
  }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
}

beforeEach(() => {
  created.contexts = 0;
  created.sources = 0;
  vi.stubGlobal("AudioContext", FakeAudioContext);
});

describe("mixGains / layoutFromLevels", () => {
  it("éteint : la stéréo passe telle quelle", () => {
    expect(mixGains("stereo", "off")).toEqual({ front: 1, cross: 0, center: 0.707, surround: 0.707 });
  });
  it("un 5.1 en voix claires remonte le centre au-dessus des faces", () => {
    const g = mixGains("surround", "voices");
    expect(g.center).toBeGreaterThan(g.front);
    expect(g.surround).toBeLessThan(g.front);
  });
  it("le mono va aux deux oreilles", () => {
    expect(mixGains("mono", "voices")).toMatchObject({ front: 1, cross: 1 });
  });
  it("déduit la disposition des niveaux mesurés", () => {
    expect(layoutFromLevels([0.1, 0.1, 0, 0, 0, 0])).toBe("stereo");
    expect(layoutFromLevels([0.1, 0.1, 0.2, 0.05, 0.03, 0.03])).toBe("surround");
    expect(layoutFromLevels([0.1, 0, 0, 0, 0, 0])).toBe("mono");
    expect(layoutFromLevels([0, 0, 0, 0, 0, 0])).toBe("unknown");
  });
});

describe("useVoiceBoost", () => {
  it("pour un compte non administrateur : aucune commande, rien de créé", () => {
    const video = document.createElement("video");
    const { result } = renderHook(() => useVoiceBoost({ current: video }, false));
    expect(result.current).toBeUndefined();
    expect(created.contexts).toBe(0);
  });

  it("sans appui, ou sur « Désactivé » jamais attaché : le chemin d'origine reste intact", () => {
    const video = document.createElement("video");
    const { result } = renderHook(() => useVoiceBoost({ current: video }, true));
    expect(created.contexts).toBe(0);
    act(() => result.current?.setMode("off"));
    expect(created.contexts).toBe(0);
    expect(result.current?.mode).toBe("off");
  });

  it("s'attache au premier appui, une seule fois par élément", () => {
    const video = document.createElement("video");
    // Une référence neuve à chaque rendu, exprès : le graphe ne doit pas dépendre de l'identité
    // de l'objet ref, seulement de l'élément.
    const { result, unmount } = renderHook(() => useVoiceBoost({ current: video }, true));
    act(() => result.current?.setMode("voices"));
    act(() => result.current?.setMode("night"));
    act(() => result.current?.setMode("off"));
    expect(created.contexts).toBe(1);
    expect(created.sources).toBe(1);
    expect(result.current?.error).toBeNull();
    expect(result.current?.mode).toBe("off");
    unmount();
  });
});
