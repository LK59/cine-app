import { describe, it, expect } from "vitest";
import { detectCodecSupport } from "@/lib/codecSupport";

// This runs under vitest's "node" environment (see vitest.config.ts) — no `window`/
// `MediaSource` global exists, which is exactly the SSR case this module has to guard
// against (it's imported from PlayerHost, a client component that can still be evaluated
// during a server render). The real browser-API-driven detection path (MediaSource /
// SourceBuffer probing) needs an actual browser and isn't covered here.
describe("detectCodecSupport", () => {
  it("returns empty support without touching any browser API when window is unavailable (SSR)", async () => {
    const result = await detectCodecSupport();
    expect(result).toEqual({ video: {}, audio: {} });
  });
});
