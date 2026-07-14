import { describe, it, expect } from "vitest";
import {
  normalize,
  correctPersonName,
  titleMatchScore,
  parseNaturalQuery,
  parseNaturalQueryEN,
  parseNaturalQueryES,
  parseNaturalQueryDE,
} from "@/lib/search-natural-query";

describe("normalize", () => {
  it("lowercases and strips accents", () => {
    expect(normalize("Christopher NOLAN")).toBe("christopher nolan");
    expect(normalize("comédie française")).toBe("comedie francaise");
  });

  it("strips punctuation and collapses whitespace", () => {
    expect(normalize("l'homme, qui  courait")).toBe("l homme qui courait");
  });
});

describe("titleMatchScore", () => {
  it("scores exact match highest", () => {
    expect(titleMatchScore("Inception", "inception")).toBe(100);
  });

  it("scores prefix match", () => {
    expect(titleMatchScore("Inception 2", "inception")).toBe(90);
  });

  it("scores substring match", () => {
    expect(titleMatchScore("The Great Inception Story", "inception")).toBe(75);
  });

  it("scores multi-word partial match when words are present out of order", () => {
    expect(titleMatchScore("Wars and Star", "star wars")).toBe(60);
  });

  it("returns 0 for no match", () => {
    expect(titleMatchScore("Inception", "totally unrelated")).toBe(0);
  });

  it("returns 0 for empty strings", () => {
    expect(titleMatchScore("", "inception")).toBe(0);
    expect(titleMatchScore("Inception", "")).toBe(0);
  });
});

describe("correctPersonName", () => {
  it("returns the input normalized when no close hint exists", () => {
    expect(correctPersonName("someone totally unrelated")).toBe("someone totally unrelated");
  });

  it("corrects a close typo to a known name", () => {
    expect(correctPersonName("christofer nolan")).toBe("christopher nolan");
  });

  it("passes through an exact known name", () => {
    expect(correctPersonName("Ryan Gosling")).toBe("ryan gosling");
  });
});

describe("parseNaturalQuery (FR)", () => {
  it("detects movie type from 'film'", () => {
    const result = parseNaturalQuery("film de guerre de Christopher Nolan", "all");
    expect(result.mediaType).toBe("movie");
    expect(result.enabled).toBe(true);
  });

  it("detects series type from 'serie'", () => {
    const result = parseNaturalQuery("serie avec Clara Galle", "all");
    expect(result.mediaType).toBe("series");
    expect(result.enabled).toBe(true);
  });

  it("extracts genre", () => {
    const result = parseNaturalQuery("film comedie avec Ryan Gosling", "all");
    expect(result.genreName).toBe("comedy");
  });

  it("extracts cast names", () => {
    const result = parseNaturalQuery("film comedie avec Ryan Gosling", "all");
    expect(result.castNames).toContain("ryan gosling");
  });

  it("extracts director via 'realise par'", () => {
    const result = parseNaturalQuery("film realise par Christopher Nolan", "all");
    expect(result.directorNames).toContain("christopher nolan");
  });

  it("extracts director via trailing 'de'", () => {
    const result = parseNaturalQuery("film de guerre de Christopher Nolan", "all");
    expect(result.directorNames).toContain("christopher nolan");
  });

  it("falls back to forcedType when nothing is detected", () => {
    const result = parseNaturalQuery("inception", "movie");
    expect(result.mediaType).toBe("movie");
    expect(result.enabled).toBe(false);
  });

  it("is not enabled for a plain title search", () => {
    const result = parseNaturalQuery("inception", "all");
    expect(result.enabled).toBe(false);
    expect(result.genreName).toBeNull();
    expect(result.castNames).toEqual([]);
    expect(result.directorNames).toEqual([]);
  });
});

describe("parseNaturalQueryEN", () => {
  it("detects movie type", () => {
    const result = parseNaturalQueryEN("war movie by Christopher Nolan", "all");
    expect(result.mediaType).toBe("movie");
  });

  it("detects series type", () => {
    const result = parseNaturalQueryEN("series with Clara Galle", "all");
    expect(result.mediaType).toBe("series");
  });

  it("extracts cast via 'with'", () => {
    const result = parseNaturalQueryEN("comedy movie with Ryan Gosling", "all");
    expect(result.genreName).toBe("comedy");
    expect(result.castNames).toContain("ryan gosling");
  });

  it("extracts director via 'directed by'", () => {
    const result = parseNaturalQueryEN("movie directed by Christopher Nolan", "all");
    expect(result.directorNames).toContain("christopher nolan");
  });
});

describe("parseNaturalQueryES", () => {
  it("detects movie type", () => {
    const result = parseNaturalQueryES("pelicula de guerra de Christopher Nolan", "all");
    expect(result.mediaType).toBe("movie");
  });

  it("detects series type", () => {
    const result = parseNaturalQueryES("serie con Clara Galle", "all");
    expect(result.mediaType).toBe("series");
  });

  it("extracts cast via 'con'", () => {
    const result = parseNaturalQueryES("pelicula de comedia con Ryan Gosling", "all");
    expect(result.genreName).toBe("comedy");
    expect(result.castNames).toContain("ryan gosling");
  });

  it("extracts director via 'dirigida por'", () => {
    const result = parseNaturalQueryES("pelicula dirigida por Christopher Nolan", "all");
    expect(result.directorNames).toContain("christopher nolan");
  });
});

describe("parseNaturalQueryDE", () => {
  it("detects movie type", () => {
    const result = parseNaturalQueryDE("film von Christopher Nolan", "all");
    expect(result.mediaType).toBe("movie");
  });

  it("detects series type", () => {
    const result = parseNaturalQueryDE("serie mit Clara Galle", "all");
    expect(result.mediaType).toBe("series");
  });

  it("extracts cast via 'mit'", () => {
    const result = parseNaturalQueryDE("film mit Ryan Gosling", "all");
    expect(result.castNames).toContain("ryan gosling");
  });

  it("extracts director via 'regie von'", () => {
    const result = parseNaturalQueryDE("film regie von Christopher Nolan", "all");
    expect(result.directorNames).toContain("christopher nolan");
  });
});
