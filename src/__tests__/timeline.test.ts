import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { groupByDay, dateLabel, type ImportEvent } from "@/lib/timeline";
import { createT } from "@/lib/i18n";
import fr from "@/locales/fr.json";

const t = createT(fr as Record<string, unknown>, fr as Record<string, unknown>);
const FR = "fr-FR";

const BASE_DATE = new Date("2026-07-08T12:00:00Z");

function makeEvent(overrides: Partial<ImportEvent> & { date: string }): ImportEvent {
  return {
    id: Math.random().toString(36).slice(2),
    type: "movie",
    title: "Test Movie",
    detail: null,
    posterPath: null,
    href: null,
    source: "radarr",
    eventKind: "import",
    ...overrides,
  };
}

function daysAgo(n: number): string {
  const d = new Date(BASE_DATE);
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

describe("dateLabel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_DATE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("labels today as Aujourd'hui", () => {
    expect(dateLabel(daysAgo(0), t, FR)).toBe("Aujourd'hui");
  });

  it("labels yesterday as Hier", () => {
    expect(dateLabel(daysAgo(1), t, FR)).toBe("Hier");
  });

  it("labels 3 days ago correctly", () => {
    expect(dateLabel(daysAgo(3), t, FR)).toBe("Il y a 3 jours");
  });

  it("labels 6 days ago correctly", () => {
    expect(dateLabel(daysAgo(6), t, FR)).toBe("Il y a 6 jours");
  });

  it("formats 8 days ago as full date (beyond 7 days threshold)", () => {
    const label = dateLabel(daysAgo(8), t, FR);
    // Should be a localized date string, not a relative label
    expect(label).not.toContain("Il y a");
    expect(label).not.toBe("Hier");
    expect(label).not.toBe("Aujourd'hui");
    expect(label.length).toBeGreaterThan(5);
  });
});

describe("groupByDay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE_DATE);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty array for empty input", () => {
    expect(groupByDay([], t, FR)).toEqual([]);
  });

  it("groups today's events under Aujourd'hui", () => {
    const events = [
      makeEvent({ date: daysAgo(0), title: "Film A" }),
      makeEvent({ date: daysAgo(0), title: "Film B" }),
    ];
    const groups = groupByDay(events, t, FR);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("Aujourd'hui");
    expect(groups[0].items).toHaveLength(2);
  });

  it("groups yesterday's events under Hier", () => {
    const events = [makeEvent({ date: daysAgo(1) })];
    const groups = groupByDay(events, t, FR);
    expect(groups[0].label).toBe("Hier");
  });

  it("groups events from 3 days ago correctly", () => {
    const events = [makeEvent({ date: daysAgo(3) })];
    const groups = groupByDay(events, t, FR);
    expect(groups[0].label).toBe("Il y a 3 jours");
  });

  it("creates separate groups for different days", () => {
    const events = [
      makeEvent({ date: daysAgo(0), title: "Today" }),
      makeEvent({ date: daysAgo(1), title: "Yesterday" }),
      makeEvent({ date: daysAgo(3), title: "3 days ago" }),
    ];
    const groups = groupByDay(events, t, FR);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.label)).toEqual(["Aujourd'hui", "Hier", "Il y a 3 jours"]);
  });

  it("preserves insertion order within a group", () => {
    const events = [
      makeEvent({ date: daysAgo(0), title: "First" }),
      makeEvent({ date: daysAgo(0), title: "Second" }),
      makeEvent({ date: daysAgo(0), title: "Third" }),
    ];
    const groups = groupByDay(events, t, FR);
    expect(groups[0].items.map((e) => e.title)).toEqual(["First", "Second", "Third"]);
  });

  it("handles a single event", () => {
    const events = [makeEvent({ date: daysAgo(2), title: "Solo" })];
    const groups = groupByDay(events, t, FR);
    expect(groups).toHaveLength(1);
    expect(groups[0].items[0].title).toBe("Solo");
  });

  it("handles mix of movies and series", () => {
    const events = [
      makeEvent({ date: daysAgo(0), type: "movie", title: "Film" }),
      makeEvent({ date: daysAgo(0), type: "series", title: "Série" }),
    ];
    const groups = groupByDay(events, t, FR);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[0].items[0].type).toBe("movie");
    expect(groups[0].items[1].type).toBe("series");
  });

  it("handles events from 8+ days ago with full date label", () => {
    const events = [makeEvent({ date: daysAgo(10) })];
    const groups = groupByDay(events, t, FR);
    expect(groups[0].label).not.toContain("Il y a");
    expect(groups[0].label.length).toBeGreaterThan(5);
  });
});
