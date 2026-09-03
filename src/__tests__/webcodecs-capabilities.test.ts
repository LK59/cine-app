import { describe, it, expect, vi, afterEach } from "vitest";

// Every codec decision here has two answers: what the documentation says, and what the machine in
// your hand does. They have disagreed twice in this project already, so the panel asks directly —
// and the asking has to survive a platform that answers oddly, or not at all.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function probe() {
  const mod = await import("@/lib/webcodecs/capabilities");
  return mod.describeCapabilities(await mod.probeCapabilities());
}

describe("probeCapabilities", () => {
  it("reports what the platform accepts, codec by codec", async () => {
    vi.stubGlobal("MediaSource", { isTypeSupported: (t: string) => t.includes("dtsc") });
    vi.stubGlobal("AudioEncoder", {
      isConfigSupported: async (c: { codec: string; numberOfChannels: number }) => ({
        supported: c.codec === "opus" || c.numberOfChannels === 2,
      }),
    });

    const out = await probe();
    expect(out["DTS dans MediaSource"]).toBe("oui");
    expect(out["DTS Express dans MediaSource"]).toBe("non");
    expect(out["Encodage AAC stéréo"]).toBe("oui");
    expect(out["Encodage AAC 6 canaux"]).toBe("non");
    expect(out["Encodage opus 6 canaux"]).toBe("oui");
  });

  it("does not take a refused bitrate for a refused codec", async () => {
    // A browser can decline one bitrate and accept the codec. Reporting "no" for what was really
    // "not at that rate" would send the whole plan down the wrong path for a platform that could
    // have carried it.
    vi.stubGlobal("MediaSource", { isTypeSupported: () => false });
    vi.stubGlobal("AudioEncoder", {
      isConfigSupported: async (c: { bitrate?: number }) => ({ supported: c.bitrate === undefined }),
    });

    const out = await probe();
    expect(out["Encodage AAC stéréo"]).toBe("oui");
  });

  it("says so plainly where WebCodecs has no encoder at all", async () => {
    // Safari before 26 shipped WebCodecs video-only: AudioEncoder was simply undefined. Reporting
    // that as "not supported" would read as a codec answer rather than a missing API.
    vi.stubGlobal("MediaSource", { isTypeSupported: () => false });
    vi.stubGlobal("AudioEncoder", undefined);

    const out = await probe();
    expect(out["Encodage AAC stéréo"]).toBe("AudioEncoder absent");
  });

  it("survives a platform that throws instead of answering", async () => {
    vi.stubGlobal("MediaSource", {
      isTypeSupported: () => {
        throw new Error("nope");
      },
    });
    vi.stubGlobal("AudioEncoder", {
      isConfigSupported: async () => {
        throw new TypeError("bad config");
      },
    });

    const out = await probe();
    expect(out["DTS dans MediaSource"]).toBe("non");
    expect(out["Encodage AAC stéréo"]).toContain("TypeError");
  });

  it("prefers the managed source, which is the only one an iPhone has", async () => {
    vi.stubGlobal("MediaSource", { isTypeSupported: () => false });
    vi.stubGlobal("ManagedMediaSource", { isTypeSupported: () => true });
    vi.stubGlobal("AudioEncoder", undefined);

    const out = await probe();
    expect(out["DTS dans MediaSource"]).toBe("oui");
  });

  it("asks the platform once, however often the panel is opened", async () => {
    const isTypeSupported = vi.fn().mockReturnValue(false);
    vi.stubGlobal("MediaSource", { isTypeSupported });
    vi.stubGlobal("AudioEncoder", undefined);

    const mod = await import("@/lib/webcodecs/capabilities");
    await mod.probeCapabilities();
    await mod.probeCapabilities();
    // Four questions asked, not eight: none of these answers change while a page is open.
    expect(isTypeSupported).toHaveBeenCalledTimes(4);
  });
});
