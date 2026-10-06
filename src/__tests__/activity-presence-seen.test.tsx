// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${Object.values(v).join(",")}` : k),
}));

import { PresenceBadge, latest } from "@/components/activity/parts";

afterEach(cleanup);
const NOW = 1_800_000_000_000;
const away = { state: "away", lastSeen: null, devices: [] } as never;

describe("« Vu il y a » pour tous les comptes (06/10/2026)", () => {
  it("prend la dernière trace connue quand les signaux de présence se sont perdus", () => {
    render(<PresenceBadge presence={away} now={NOW} seenAt={NOW - 3 * 3600_000} />);
    expect(screen.getByText(/activity\.presence\.awaySince/)).toBeTruthy();
  });

  it("dit seulement « Absent » quand rien n'est connu", () => {
    render(<PresenceBadge presence={away} now={NOW} seenAt={null} />);
    expect(screen.getByText("activity.presence.away")).toBeTruthy();
  });

  it("latest garde la plus récente des dates connues", () => {
    expect(latest(null, 5, undefined, 9, 0)).toBe(9);
    expect(latest(null, undefined)).toBeNull();
  });
});
