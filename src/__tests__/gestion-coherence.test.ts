import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";

/**
 * La passe du 21/09/2026 sur la gestion, tenue par des lectures de source.
 *
 * Chacune de ces fautes était invisible à l'usage le plus courant — en français, en administrateur,
 * quand le serveur répond — et c'est pour ça qu'elles avaient tenu. Un test par faute, pour qu'elle
 * ne revienne pas par un copier-coller.
 */
const lire = (f: string) => readFileSync(f, "utf8");

describe("la gestion, après la passe du 21/09", () => {
  it("les pages retirées ne reviennent pas, ni dans le menu", () => {
    for (const page of ["watchlist", "discover", "recommendations", "notifications"]) {
      expect([page, existsSync(`src/app/(dashboard)/${page}/page.tsx`)]).toEqual([page, false]);
    }
    const nav = lire("src/components/navItems.ts");
    expect(nav).not.toMatch(/"\/(watchlist|discover|recommendations|notifications)"/);
  });

  it("les fenêtres d'ajout disent un refus de Radarr ou de Sonarr au lieu d'annoncer un succès", () => {
    // `fetch` ne lève pas sur un 4xx : la fenêtre disait « ajouté » pour un titre refusé.
    expect(lire("src/app/(dashboard)/radarr/page.tsx")).toContain('await apiAction("/api/radarr/movies"');
    expect(lire("src/app/(dashboard)/sonarr/page.tsx")).toContain('await apiAction("/api/sonarr/series"');
  });

  it("le raccourci « f » ne dépend pas de la langue", () => {
    for (const f of ["src/app/(dashboard)/radarr/[id]/page.tsx", "src/app/(dashboard)/sonarr/[id]/page.tsx"]) {
      expect([f, lire(f).includes('title="Ajouter à la liste"')]).toEqual([f, false]);
      expect([f, lire(f).includes("data-watchlist-toggle")]).toEqual([f, true]);
    }
    expect(lire("src/components/WatchlistButton.tsx")).toContain("data-watchlist-toggle");
  });

  it("la liste des films est traduite, comme celle des séries", () => {
    const src = lire("src/app/(dashboard)/radarr/page.tsx");
    for (const phrase of ["films restants", "Ce film est déjà dans Radarr", "Ajouter un film", "Titre du film", "Déjà ajouté"]) {
      expect([phrase, src.includes(phrase)]).toEqual([phrase, false]);
    }
    expect(lire("src/app/(dashboard)/loading.tsx")).not.toContain("Chargement");
  });

  it("un échec de chargement ne se lit plus comme une page vide", () => {
    for (const f of [
      "src/app/(dashboard)/DashboardClient.tsx",
      "src/app/(dashboard)/timeline/page.tsx",
      "src/app/(dashboard)/calendar/page.tsx",
    ]) {
      expect([f, lire(f)]).toEqual([f, expect.stringContaining("t('errors.loadFailed')")]);
    }
  });
});
