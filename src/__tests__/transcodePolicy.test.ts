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
});
