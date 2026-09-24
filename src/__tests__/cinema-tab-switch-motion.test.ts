import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const lire = (f: string) => fs.readFileSync(path.resolve(__dirname, "../..", f), "utf8");

/**
 * Une animation à la fois sur l'accueil du bureau (23/09/2026). Le panneau des rangées fondait en
 * entier pendant que chaque rangée jouait son entrée échelonnée : opacités multipliées, près d'une
 * demi-seconde avant que l'écran se pose, au premier affichage comme à chaque changement d'onglet.
 */
describe("changement d'onglet sur le bureau", () => {
  it("le panneau ne fond qu'après un changement d'onglet", () => {
    const src = lire("src/components/cinema/CinemaClient.tsx");
    expect(src).not.toContain('<div key={mediaType} className="animate-fade-in">');
    expect(src).toContain('className={tabSwitched ? "animate-fade-in rows-switched" : undefined}');
  });

  it("et les rangées n'y rejouent pas leur propre entrée", () => {
    const css = lire("src/app/globals.css");
    expect(css).toMatch(/\.rows-switched \[data-tv-rowroot\] \{\s*animation: none;/);
    for (const f of ["CinemaRow", "CinemaTop10Row", "CinemaSeriesRow", "CinemaSpotlight", "CinemaDiscoveryRow"]) {
      // La règle ne vise que ce qui porte le repère de rangée.
      expect([f, lire(`src/components/cinema/${f}.tsx`)]).toEqual([f, expect.stringContaining("data-tv-rowroot")]);
    }
  });
});

describe("changement d'onglet sur le téléphone", () => {
  // De la recherche à « Ma liste », l'accueil passait brièvement (23/09/2026) : fondu croisé au
  // même niveau, ou panneau pas encore chargé. Voir PlayerPanelFrame (`replaced`).
  it("la coquille dit à l'onglet qui part qu'un autre le remplace, et à celui qui arrive d'où il vient", () => {
    const src = lire("src/components/player/PlayerShell.tsx");
    for (const panel of ["PlayerSearchPanel", "PlayerListPanel", "PlayerAccountPanel"]) {
      expect([panel, new RegExp(`<${panel}\\s+leaving=\\{\\w+\\.leaving\\}\\s+replaced=\\{[^}]+\\}\\s+fromTab=\\{`).test(src)]).toEqual([panel, true]);
    }
  });

  it("un onglet pas encore chargé montre son fond, pas l'accueil", () => {
    const src = lire("src/components/player/PlayerShell.tsx");
    // Recherche, Ma liste, Compte — et l'activité des comptes et les signalements (24/09/2026), qui
    // s'ouvrent depuis Compte.
    expect(src.match(/loading: PanelPlaceholder/g)?.length).toBe(5);
  });
});

describe("du squelette au contenu, sur téléphone", () => {
  // Le bureau avait une entrée pour ses rangées ; le téléphone passait du squelette au contenu
  // d'un coup (23/09/2026). Le contenu fond, pas le titre de la rangée — identique des deux côtés.
  it("le contenu d'une rangée et la bannière fondent à leur arrivée", () => {
    const rows = lire("src/components/cinema/mobile/CinemaMobileClient.tsx");
    expect(rows).toMatch(/className="scrollbar-thin flex animate-fade-in gap-3 overflow-x-auto/);
    expect(lire("src/components/cinema/mobile/CinemaMobileHero.tsx")).toContain('<section className="animate-fade-in px-4 pt-2">');
  });
});
