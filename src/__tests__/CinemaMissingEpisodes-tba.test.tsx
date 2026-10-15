// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
  useLocale: () => ({ locale: "fr" }),
}));

import { CinemaMissingEpisodes } from "@/components/cinema/CinemaMissingEpisodes";
import type { MissingSeason } from "@/app/api/player/series/[sonarrId]/missing/route";

afterEach(cleanup);

// 15/10/2026 (passe de nuit, MOBILE-8) : « 8 épisodes à venir » puis huit lignes « S3 · É1 — TBA ».
describe("épisodes à venir", () => {
  it("n'affiche pas « TBA » comme un titre, mais garde la date", () => {
    const season = {
      seasonNumber: 3,
      requestable: false,
      episodes: [
        { id: 1, seasonNumber: 3, episodeNumber: 1, title: "TBA", airDate: "2026-11-11T00:00:00Z", released: false, downloading: null },
        { id: 2, seasonNumber: 3, episodeNumber: 2, title: "Le retour", airDate: "2026-11-18T00:00:00Z", released: false, downloading: null },
      ],
    } as unknown as MissingSeason;
    const { container } = render(<CinemaMissingEpisodes season={season} />);
    expect(container.textContent).not.toContain("TBA");
    expect(container.textContent).toContain("Le retour");
    expect(container.querySelectorAll("li")[0].textContent).toContain("cinema.missing.airsOn");
  });
});
