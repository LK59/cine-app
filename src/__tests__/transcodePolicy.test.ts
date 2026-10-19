import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// La version allégée suppose le transcodage vidéo permis au compte par Jellyfin (DECISIONS.md §78).

vi.mock("@/lib/config", () => ({ config: { jellyfin: { url: "http://jf", apiKey: "k" } } }));
import { forgetTranscodePolicy, videoTranscodingAllowed } from "@/lib/transcodePolicy";

let policy: Record<string, unknown> | null = null;
beforeEach(() => {
  forgetTranscodePolicy();
  vi.stubGlobal("fetch", vi.fn(async () => (policy ? { ok: true, json: async () => ({ Policy: policy }) } : { ok: false, status: 502 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("le droit de transcoder la vidéo", () => {
  it("lu dans la politique Jellyfin du compte", async () => {
    policy = { EnableVideoPlaybackTranscoding: false };
    expect(await videoTranscodingAllowed("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    policy = { EnableVideoPlaybackTranscoding: true };
    expect(await videoTranscodingAllowed("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")).toBe(true);
  });

  it("Jellyfin muet : la dernière réponse connue, sinon oui (le défaut de Jellyfin)", async () => {
    policy = { EnableVideoPlaybackTranscoding: false };
    expect(await videoTranscodingAllowed("cccccccccccccccccccccccccccccccc", 0)).toBe(false);
    policy = null;
    expect(await videoTranscodingAllowed("cccccccccccccccccccccccccccccccc", 10 * 60_000)).toBe(false);
    expect(await videoTranscodingAllowed("dddddddddddddddddddddddddddddddd")).toBe(true);
  });

  it("un Jellyfin qui traîne ne retarde pas l'ouverture : 300 ms au plus, puis la dernière réponse connue (sinon oui) ; une seule lecture pour des appels simultanés", async () => {
    vi.useFakeTimers();
    try {
      let answer: (value: unknown) => void = () => {};
      const slow = vi.fn(() => new Promise((resolve) => (answer = resolve)));
      vi.stubGlobal("fetch", slow);
      const id = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      let settled: boolean[] = [];
      void Promise.all([videoTranscodingAllowed(id), videoTranscodingAllowed(id)]).then((v) => (settled = v));
      await vi.advanceTimersByTimeAsync(299);
      expect(settled).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toEqual([true, true]);
      expect(slow).toHaveBeenCalledTimes(1);
      // La réponse finit par arriver : elle remplit le cache pour la suivante.
      answer({ ok: true, json: async () => ({ Policy: { EnableVideoPlaybackTranscoding: false } }) });
      await vi.advanceTimersByTimeAsync(0);
      expect(await videoTranscodingAllowed(id)).toBe(false);
      expect(slow).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("le droit de télécharger (19/10/2026)", () => {
  it("lu dans la même politique : oui seulement sur un oui explicite", async () => {
    const { contentDownloadingAllowed } = await import("@/lib/transcodePolicy");
    policy = { EnableContentDownloading: true };
    expect(await contentDownloadingAllowed("ffffffffffffffffffffffffffffffff")).toBe(true);
    policy = { EnableContentDownloading: false };
    expect(await contentDownloadingAllowed("11111111111111111111111111111111")).toBe(false);
    policy = {};
    expect(await contentDownloadingAllowed("22222222222222222222222222222222")).toBe(false);
  });

  it("Jellyfin muet : non — ni la réponse périmée, ni le défaut", async () => {
    const { contentDownloadingAllowed } = await import("@/lib/transcodePolicy");
    policy = { EnableContentDownloading: true };
    expect(await contentDownloadingAllowed("33333333333333333333333333333333", 0)).toBe(true);
    policy = null;
    expect(await contentDownloadingAllowed("33333333333333333333333333333333", 10 * 60_000)).toBe(false);
    expect(await contentDownloadingAllowed("44444444444444444444444444444444")).toBe(false);
    expect(await contentDownloadingAllowed(null)).toBe(false);
  });
});
