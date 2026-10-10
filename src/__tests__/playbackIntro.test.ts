import { describe, it, expect, beforeEach } from "vitest";
import {
  PLAYBACK_INTRO,
  finishIntro,
  formatResumeClock,
  introAllowedFor,
  introBackdropSrc,
  introCaption,
  introFinished,
  introKey,
  introSnapshot,
  introVeil,
  keepIntroSnapshot,
  resetIntroClocks,
  resolveIntroArt,
  startIntroClock,
  type IntroCacheReader,
} from "@/lib/playbackIntro";

const TMDB = "https://image.tmdb.org/t/p/original/fond.jpg";

/** Un cache de SWR réduit à sa forme : `get(clé)` rend `{ data }`. */
function cacheOf(entries: Record<string, unknown>): IntroCacheReader {
  return {
    keys: () => Object.keys(entries),
    get: (key) => (key in entries ? { data: entries[key] } : undefined),
  };
}

const movie = { radarrId: 7, jellyfinItemId: "film", title: "Alien", backdropUrl: TMDB, logoUrl: "https://image.tmdb.org/t/p/w500/logo.png" };
const series = {
  sonarrId: 3,
  jellyfinItemId: "serie",
  title: "Ted Lasso",
  backdropUrl: "https://image.tmdb.org/t/p/original/ted.jpg",
  logoUrl: "https://image.tmdb.org/t/p/w500/ted.png",
  firstEpisode: { itemId: "s1e1" },
};
const catalogue = (items: unknown[]) => ({ genres: [], items, rows: {}, spotlight: [], recentlyAdded: [], top10: [] });

describe("les réglages validés", () => {
  it("sont ceux du banc le 10/10/2026 : fond net, voile d'origine, seuil 300 ms, logo 600 ms, lueur", () => {
    expect(PLAYBACK_INTRO).toEqual({ thresholdMs: 300, zoom: 1.08, logoMs: 600, sweep: true, background: "net", brightness: 0 });
  });

  it("le fond net est en 1 280 px, l'original sur un écran large et dense, jamais les 300 px agrandis", () => {
    expect(introBackdropSrc(TMDB, "net", 1170)).toBe("https://image.tmdb.org/t/p/w1280/fond.jpg");
    expect(introBackdropSrc(TMDB, "net", 2880)).toBe(TMDB);
    expect(introBackdropSrc(TMDB, "old", 2880)).toBe("https://image.tmdb.org/t/p/w300/fond.jpg");
    expect(introBackdropSrc(null)).toBe("");
  });

  it("le voile d'origine ne bouge pas à luminosité zéro", () => {
    expect(introVeil("net", 0)).toBe(
      "radial-gradient(ellipse at center, rgba(0,0,0,0.300), rgba(0,0,0,0.820) 78%), linear-gradient(to top, rgba(0,0,0,0.600), rgba(0,0,0,0) 45%)"
    );
    expect(introVeil("net", 30)).toContain("rgba(0,0,0,0.210)");
  });
});

describe("resolveIntroArt — le visuel trouvé sur l'appareil, sans requête", () => {
  it("un film par le catalogue", () => {
    const art = resolveIntroArt("film", cacheOf({ "/api/cinema/movies": catalogue([movie]) }));
    expect(art).toEqual({ name: "Alien", backdropUrl: TMDB, logoUrl: movie.logoUrl });
  });

  it("un épisode d'« À suivre » prend le visuel de sa série, avec saison et épisode", () => {
    const art = resolveIntroArt(
      "ep",
      cacheOf({
        "/api/cinema/series": catalogue([series]),
        "/api/cinema/next-up": { items: [{ jellyfinItemId: "ep", sonarrId: 3, seasonNumber: 2, episodeNumber: 5 }] },
      })
    );
    expect(art).toMatchObject({ name: "Ted Lasso", logoUrl: series.logoUrl, season: 2, episode: 5 });
  });

  it("un épisode de « Reprendre », par l'adresse de sa fiche et son sous-titre", () => {
    const art = resolveIntroArt(
      "ep",
      cacheOf({
        "/api/cinema/series": catalogue([series]),
        "/api/jellyfin/resume": { items: [{ id: "ep", cinemaHref: "/sonarr/3", subtitle: "S01E03 · Le pari" }] },
      })
    );
    expect(art).toMatchObject({ season: 1, episode: 3, episodeTitle: "Le pari", backdropUrl: series.backdropUrl });
  });

  it("un épisode d'une liste déjà ouverte, avec son titre", () => {
    const art = resolveIntroArt(
      "ep",
      cacheOf({
        "/api/cinema/series": catalogue([series]),
        "/api/cinema/series/serie/episodes": { seasons: [{ episodes: [{ jellyfinItemId: "ep", seasonNumber: 3, episodeNumber: 1, title: "Retour" }] }] },
      })
    );
    expect(art).toMatchObject({ season: 3, episode: 1, episodeTitle: "Retour" });
  });

  it("le premier épisode d'une série jamais commencée", () => {
    expect(resolveIntroArt("s1e1", cacheOf({ "/api/cinema/series": catalogue([series]) }))).toMatchObject({ season: 1, episode: 1 });
  });

  it("rien de connu : null, et un cache vide ne lève pas", () => {
    expect(resolveIntroArt("inconnu", cacheOf({}))).toBeNull();
    expect(resolveIntroArt("inconnu", cacheOf({ "/api/cinema/movies": "abîmé" }))).toBeNull();
  });
});

describe("introCaption — la légende contextuelle", () => {
  const t = (key: string, vars?: Record<string, string | number>) =>
    key === "cinema.episodeShort" ? `S${vars?.season} · É${vars?.episode}` : `Reprise à ${vars?.time}`;

  it("un film lancé depuis le début n'a pas de légende", () => {
    expect(introCaption({ resumeSeconds: 0 }, t)).toEqual([]);
    expect(introCaption({}, t)).toEqual([]);
  });

  it("un épisode, puis la reprise sur une seconde ligne", () => {
    expect(introCaption({ season: 1, episode: 3, episodeTitle: "Le pari", resumeSeconds: 725 }, t)).toEqual([
      "S1 · É3 · Le pari",
      "Reprise à 12 min 05",
    ]);
  });

  it("une reprise de quelques secondes ne vaut pas une ligne", () => {
    expect(introCaption({ resumeSeconds: 12 }, t)).toEqual([]);
    expect(formatResumeClock(4320)).toBe("1 h 12");
  });
});

describe("l'horloge partagée", () => {
  beforeEach(resetIntroClocks);

  it("le premier départ l'emporte : le lecteur qui prend la relève reprend la même heure", () => {
    const key = introKey(4, "film");
    expect(startIntroClock(key, 1000)).toBe(1000);
    expect(startIntroClock(key, 5000)).toBe(1000);
  });

  it("une lecture qui a montré une image ne rejoue pas l'ouverture ; l'épisode suivant a la sienne", () => {
    startIntroClock(introKey(4, "ep1"), 0);
    finishIntro(introKey(4, "ep1"));
    expect(introFinished(introKey(4, "ep1"))).toBe(true);
    expect(introFinished(introKey(4, "ep2"))).toBe(false);
  });

  it("garde ce qui a été montré pour le relais", () => {
    startIntroClock("k", 0);
    keepIntroSnapshot("k", { caption: ["Reprise à 1 h 12"] });
    expect(introSnapshot("k")).toEqual({ caption: ["Reprise à 1 h 12"] });
  });

  it("pas d'ouverture pour le banc, une page rechargée ou le retour d'une diffusion", () => {
    expect(introAllowedFor({})).toBe(true);
    expect(introAllowedFor({ bench: "r1" })).toBe(false);
    expect(introAllowedFor({ fromReload: true })).toBe(false);
    expect(introAllowedFor({ startPaused: true })).toBe(false);
  });
});
