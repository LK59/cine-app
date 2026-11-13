import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { seasonName } from "@/lib/seasonOrder";

/**
 * Le nom d'une saison, une écriture pour tous les écrans (13/11/2026) : la fiche hors ligne d'une série
 * rangeait des spéciaux téléchargés sous « Saison 0 », quand les autres listes disaient « Épisodes spéciaux ».
 */
const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${vars.n}` : key);

describe("seasonName", () => {
  it("la saison 0 est celle des spéciaux", () => {
    expect(seasonName(0, t)).toBe("cinema.specials");
    expect(seasonName(3, t)).toBe("cinema.season:3");
  });

  it("les écrans qui nomment une saison passent par lui", () => {
    for (const file of [
      "src/components/offline/OfflineTitleSheet.tsx",
      "src/components/offline/OfflineEpisodeDownload.tsx",
      "src/components/cinema/CinemaEpisodeBrowser.tsx",
      "src/components/cinema/mobile/CinemaMobileDetail.tsx",
      "src/components/shareGuest/ShareTitleSheet.tsx",
    ]) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source, file).toMatch(/seasonName\(/);
      expect(source, file).not.toMatch(/t\("player\.downloads\.season", \{ n:/);
      expect(source, file).not.toMatch(/=== 0 \? t\("cinema\.specials"\)/);
    }
  });
});
