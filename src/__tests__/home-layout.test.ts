import { describe, expect, it } from "vitest";
import { continueHeroTitles, continueTargets, heroSource } from "@/lib/homeLayout";
import { continueOrder } from "@/lib/continueOrder";
import { resolveHomeLayout } from "@/lib/useHomeLayout";

// La disposition de l'accueil (DECISIONS.md §52) : une décision, pour le bureau et le téléphone.
const movies = new Map([1, 2, 3].map((id) => [id, { radarrId: id }]));
const series = new Map([7, 8].map((id) => [id, { sonarrId: id }]));
const resume = (id: string, href: string | null, at: string) => ({ id, cinemaHref: href, lastPlayedAt: at });
const next = (id: string, sonarrId: number | null, at: string) => ({ jellyfinItemId: id, sonarrId, lastPlayedAt: at });

describe("continueHeroTitles", () => {
  it("retrouve chaque titre dans le catalogue, dans l'ordre de la rangée, une série une fois", () => {
    const entries = continueOrder(
      [resume("a", "/radarr/2", "2026-10-07T10:00:00Z"), resume("b", "/radarr/1", "2026-10-07T12:00:00Z")],
      [next("e1", 7, "2026-10-07T11:00:00Z"), next("e2", 7, "2026-10-06T11:00:00Z"), next("e3", 8, "2026-10-05T11:00:00Z")]
    );
    const out = continueHeroTitles(entries, (id) => movies.get(id), (id) => series.get(id));
    expect(out.movies.map((m) => m.radarrId)).toEqual([1, 2]);
    expect(out.series.map((s) => s.sonarrId)).toEqual([7, 8]);
  });

  it("laisse de côté ce qui n'a pas de fiche : pas d'adresse, ou absent du catalogue", () => {
    const entries = continueOrder([resume("a", null, "2026-10-07T10:00:00Z"), resume("b", "/radarr/99", "2026-10-07T10:00:00Z")], [next("e", null, "2026-10-07T10:00:00Z")]);
    const out = continueHeroTitles(entries, (id) => movies.get(id), (id) => series.get(id));
    expect(out).toEqual({ movies: [], series: [] });
  });

  it("s'arrête à huit, comme la bannière d'origine", () => {
    const many = new Map(Array.from({ length: 12 }, (_, i) => [i + 1, { radarrId: i + 1 }]));
    const entries = continueOrder(Array.from({ length: 12 }, (_, i) => resume(`m${i}`, `/radarr/${i + 1}`, "2026-10-07T10:00:00Z")), []);
    expect(continueHeroTitles(entries, (id) => many.get(id), () => undefined).movies).toHaveLength(8);
  });
});

describe("heroSource", () => {
  it("garde « À la une » quand l'installation ne le demande pas", () => {
    expect(heroSource(false, ["officiel"], ["en cours"])).toEqual({ items: ["officiel"], continuing: false });
  });
  it("montre Reprendre / À suivre quand elle le demande et qu'il y a de quoi", () => {
    expect(heroSource(true, ["officiel"], ["en cours"])).toEqual({ items: ["en cours"], continuing: true });
  });
  it("garde « À la une » plutôt qu'une bannière vide : compte neuf, rien en cours", () => {
    expect(heroSource(true, ["officiel"], [])).toEqual({ items: ["officiel"], continuing: false });
  });
});

describe("resolveHomeLayout — le compte d'abord, le serveur à défaut", () => {
  const server = { browseButton: true, continueHero: false };
  it("suit le serveur tant que le compte n'a rien choisi", () => {
    expect(resolveHomeLayout({ browseButton: null, continueHero: null }, server)).toEqual(server);
    expect(resolveHomeLayout(undefined, server)).toEqual(server);
  });
  it("prend le choix du compte, variante par variante", () => {
    expect(resolveHomeLayout({ browseButton: false, continueHero: null }, server)).toEqual({ browseButton: false, continueHero: false });
    expect(resolveHomeLayout({ browseButton: null, continueHero: true }, server)).toEqual({ browseButton: true, continueHero: true });
  });
});

describe("continueTargets — ce que le bouton de la bannière lance", () => {
  it("la reprise de chaque film, l'épisode le plus récent de chaque série", () => {
    const entries = continueOrder(
      [resume("a", "/radarr/2", "2026-10-07T10:00:00Z"), resume("b", null, "2026-10-07T11:00:00Z")],
      [next("e-old", 7, "2026-10-06T11:00:00Z"), next("e-new", 7, "2026-10-07T12:00:00Z")]
    );
    const out = continueTargets(entries);
    expect([...out.movies.keys()]).toEqual([2]);
    expect(out.movies.get(2)?.id).toBe("a");
    expect(out.series.get(7)?.jellyfinItemId).toBe("e-new");
  });
});
