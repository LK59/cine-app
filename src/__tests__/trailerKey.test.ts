import { describe, it, expect } from "vitest";
import { resolveTrailerKey } from "@/lib/trailerKey";

describe("resolveTrailerKey", () => {
  it("prefers an official YouTube trailer", () => {
    const key = resolveTrailerKey({
      results: [
        { type: "Trailer", site: "YouTube", official: false, key: "unofficial" },
        { type: "Trailer", site: "YouTube", official: true, key: "official" },
      ],
    });
    expect(key).toBe("official");
  });

  it("falls back to a non-official YouTube trailer when no official one exists", () => {
    const key = resolveTrailerKey({
      results: [{ type: "Trailer", site: "YouTube", official: false, key: "unofficial" }],
    });
    expect(key).toBe("unofficial");
  });

  it("returns null when there is no YouTube trailer at all", () => {
    const key = resolveTrailerKey({
      results: [
        { type: "Teaser", site: "YouTube", official: true, key: "teaser" },
        { type: "Trailer", site: "Vimeo", official: true, key: "vimeo-trailer" },
      ],
    });
    expect(key).toBeNull();
  });

  it("returns null for an empty results list", () => {
    expect(resolveTrailerKey({ results: [] })).toBeNull();
  });

  it("ignores non-YouTube sites even when type/official match", () => {
    const key = resolveTrailerKey({
      results: [{ type: "Trailer", site: "Vimeo", official: true, key: "vimeo-trailer" }],
    });
    expect(key).toBeNull();
  });
});
