import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fmtSize, fmtEta, formatResumeTicks, relativeTime, relativeTimeAbs, relDate, selectBio } from "@/lib/format";
import { createT } from "@/lib/i18n";
import fr from "@/locales/fr.json";

const t = createT(fr as Record<string, unknown>, fr as Record<string, unknown>);

describe("fmtSize", () => {
  it("returns — for 0 bytes", () => {
    expect(fmtSize(0)).toBe("—");
  });

  it("returns — for negative values", () => {
    expect(fmtSize(-100)).toBe("—");
  });

  it("formats bytes", () => {
    expect(fmtSize(1)).toBe("1.0 B");
    expect(fmtSize(500)).toBe("500.0 B");
  });

  it("formats kilobytes", () => {
    expect(fmtSize(1024)).toBe("1.0 KB");
    expect(fmtSize(1536)).toBe("1.5 KB");
  });

  it("formats megabytes", () => {
    expect(fmtSize(1024 * 1024)).toBe("1.0 MB");
    expect(fmtSize(1.4 * 1024 * 1024)).toMatch(/1\.[34] MB/);
  });

  it("formats gigabytes", () => {
    expect(fmtSize(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(fmtSize(4.2 * 1024 * 1024 * 1024)).toMatch(/4\.[12] GB/);
  });

  it("formats terabytes", () => {
    expect(fmtSize(1024 ** 4)).toBe("1.0 TB");
  });

  it("caps at TB for very large values", () => {
    expect(fmtSize(1024 ** 5)).toMatch(/TB$/);
  });
});

describe("formatResumeTicks", () => {
  it("formats seconds-only durations without an hour segment", () => {
    expect(formatResumeTicks(0)).toBe("0min00");
    expect(formatResumeTicks(65 * 10_000_000)).toBe("1min05");
  });

  it("adds an hour segment past 60 minutes", () => {
    expect(formatResumeTicks(3661 * 10_000_000)).toBe("1h01min01");
  });
});

describe("fmtEta", () => {
  it("returns — for zero, negative, or missing values", () => {
    expect(fmtEta(0)).toBe("—");
    expect(fmtEta(-10)).toBe("—");
  });

  it("returns — for qBittorrent's 8640000 'no estimate' sentinel and beyond", () => {
    expect(fmtEta(8_640_000)).toBe("—");
    expect(fmtEta(9_000_000)).toBe("—");
  });

  it("formats seconds-only durations under a minute", () => {
    expect(fmtEta(45)).toBe("45s");
  });

  it("formats minutes, dropping the seconds", () => {
    expect(fmtEta(125)).toBe("2min");
  });

  it("formats hours+minutes, dropping the seconds", () => {
    expect(fmtEta(3725)).toBe("1h02");
  });
});

describe("relativeTimeAbs", () => {
  it("delegates to relativeTime using a Unix ms timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T12:00:00Z"));
    const ts = Date.now() - 5 * 60_000;
    expect(relativeTimeAbs(ts, t)).toBe("il y a 5 min");
    vi.useRealTimers();
  });
});

describe("relativeTime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns 'à l'instant' for < 1 minute ago", () => {
    const date = new Date(Date.now() - 30_000).toISOString();
    expect(relativeTime(date, t)).toBe("à l'instant");
  });

  it("returns minutes for < 60 minutes", () => {
    const date = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(relativeTime(date, t)).toBe("il y a 5 min");
  });

  it("returns hours for < 24 hours", () => {
    const date = new Date(Date.now() - 3 * 3600_000).toISOString();
    expect(relativeTime(date, t)).toBe("il y a 3 h");
  });

  it("returns days for < 30 days", () => {
    const date = new Date(Date.now() - 10 * 86_400_000).toISOString();
    expect(relativeTime(date, t)).toBe("il y a 10 j");
  });

  it("returns months for < 365 days", () => {
    const date = new Date(Date.now() - 60 * 86_400_000).toISOString();
    expect(relativeTime(date, t)).toBe("il y a 2 mois");
  });

  it("returns years for >= 365 days", () => {
    const date = new Date(Date.now() - 2 * 365 * 86_400_000).toISOString();
    expect(relativeTime(date, t)).toBe("il y a 2 ans");
  });

  it("returns singular year", () => {
    const date = new Date(Date.now() - 400 * 86_400_000).toISOString();
    expect(relativeTime(date, t)).toBe("il y a 1 an");
  });
});

describe("relDate", () => {
  it("returns — for null", () => {
    expect(relDate(null, t)).toBe("—");
  });

  it("returns — for undefined", () => {
    expect(relDate(undefined, t)).toBe("—");
  });

  it("returns — for empty string", () => {
    expect(relDate("", t)).toBe("—");
  });

  it("returns a relative time string for valid date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-08T12:00:00Z"));
    const date = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(relDate(date, t)).toBe("il y a 5 min");
    vi.useRealTimers();
  });
});

describe("selectBio", () => {
  it("returns null when both are empty", () => {
    expect(selectBio(null, null)).toBeNull();
    expect(selectBio("", "")).toBeNull();
    expect(selectBio(undefined, undefined)).toBeNull();
  });

  it("returns tmdb when wiki is empty", () => {
    const result = selectBio("tmdb bio text", null);
    expect(result?.source).toBe("tmdb");
    expect(result?.text).toBe("tmdb bio text");
  });

  it("returns wikipedia when tmdb is empty", () => {
    const result = selectBio(null, "wiki bio text");
    expect(result?.source).toBe("wikipedia");
    expect(result?.text).toBe("wiki bio text");
  });

  it("prefers French bio over non-French regardless of length", () => {
    // A short French bio vs a long English bio
    const frBio = "Il est né dans les Alpes et a été un acteur qui a joué dans les films les plus populaires avec son équipe.";
    const enBio = "A very long English biography that goes on and on about many achievements and milestones over the years spanning decades of a long career.";
    const result = selectBio(enBio, frBio);
    expect(result?.source).toBe("wikipedia"); // wiki is French
    expect(result?.text).toBe(frBio);
  });

  it("prefers longer bio when both are same language", () => {
    const short = "Short English bio text here.";
    const long = "Longer English bio text here with more detail about the subject.";
    const result = selectBio(short, long);
    expect(result?.source).toBe("wikipedia"); // wiki is longer
  });

  it("prefers tmdb on tie (same length, same language)", () => {
    const bio = "Same length bio."; // same string
    const result = selectBio(bio, bio);
    expect(result?.source).toBe("tmdb");
  });
});
