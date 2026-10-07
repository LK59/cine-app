import { describe, expect, it } from "vitest";
import { continueHeroTitles, continueTargets, heroSource } from "@/lib/homeLayout";
import { continueOrder } from "@/lib/continueOrder";
import { heroContinueFacts } from "@/lib/cinemaContinueLabel";
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

describe("heroSource — les reprises d'abord, « À la une » complète jusqu'à cinq", () => {
  const id = (x: string) => x;
  const official = ["n1", "n2", "n3", "n4", "n5", "n6"];
  it("garde « À la une » quand l'option est coupée", () => {
    expect(heroSource(false, official, ["r1"], id)).toMatchObject({ items: official, continuing: false, mixed: false });
  });
  it("garde « À la une » quand rien n'est en cours : compte neuf, bannière jamais vide", () => {
    expect(heroSource(true, official, [], id)).toMatchObject({ items: official, continuing: false });
  });
  it("une seule reprise : elle en tête, puis « À la une » jusqu'à cinq — la bannière tourne encore", () => {
    const out = heroSource(true, official, ["r1"], id);
    expect(out.items).toEqual(["r1", "n1", "n2", "n3", "n4"]);
    expect(out.mixed).toBe(true);
    expect([...out.shown]).toEqual(["r1", "n1", "n2", "n3", "n4"]);
  });
  it("ne répète pas un titre à la fois repris et à la une", () => {
    expect(heroSource(true, official, ["n2", "r1"], id).items).toEqual(["n2", "r1", "n1", "n3", "n4"]);
  });
  it("cinq reprises ou plus : rien qu'elles, sans complément", () => {
    const many = ["r1", "r2", "r3", "r4", "r5", "r6"];
    expect(heroSource(true, official, many, id)).toMatchObject({ items: many, continuing: true, mixed: false });
  });
});

describe("heroContinueFacts — le bouton court et ce qu'il reste au-dessus", () => {
  const t = (k: string, v?: Record<string, string | number>) => (v ? `${k}(${Object.values(v).join(",")})` : k);
  it("un épisode commencé : « Reprendre », l'épisode et le temps restant, la progression", () => {
    const f = heroContinueFacts(t, 3_000_000_000, 12_000_000_000, 1, 3);
    expect(f.label).toBe("common.resume");
    expect(f.caption).toBe("cinema.episodeShort(3,1) · cinema.timeRemaining(15 min)");
    expect(f.progress).toBe(0.25);
  });
  it("un épisode jamais ouvert : « À suivre » et l'épisode, sans barre", () => {
    expect(heroContinueFacts(t, null, 12_000_000_000, 2, 1)).toEqual({ label: "cinema.upNext", caption: "cinema.episodeShort(1,2)", progress: null });
  });
  it("un film commencé : « Reprendre » et le temps restant", () => {
    expect(heroContinueFacts(t, 6_000_000_000, 72_000_000_000).caption).toBe("cinema.timeRemaining(1h50)");
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
