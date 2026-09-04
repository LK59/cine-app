import { describe, it, expect } from "vitest";
import { posterUrl, backdropUrl, tmdbResize } from "@/lib/images";

const tmdb = (path: string) => `https://image.tmdb.org/t/p/original${path}`;
const tvdb = "https://artworks.thetvdb.com/banners/fanart/original/82459-3.jpg";
const tvdbV4 = "https://artworks.thetvdb.com/banners/v4/series/383203/backgrounds/60d5931c1f29c.jpg";

describe("tmdbResize", () => {
  it("demande la taille voulue à TMDB", () => {
    expect(tmdbResize(tmdb("/a.jpg"), "w780")).toBe("https://image.tmdb.org/t/p/w780/a.jpg");
    expect(tmdbResize("https://image.tmdb.org/t/p/w500/a.jpg", "w342")).toBe("https://image.tmdb.org/t/p/w342/a.jpg");
  });

  /**
   * Le défaut derrière les bannières manquantes.
   *
   * Radarr et Sonarr renvoient aussi des visuels de TheTVDB, dont les chemins contiennent un
   * segment `/original/`. La substitution le remplaçait par une taille qui n'existe pas là-bas :
   * mesuré en direct, l'adresse d'origine répond 200 et celle réécrite 403.
   */
  it("ne touche pas à une adresse qui n'est pas de TMDB", () => {
    expect(tmdbResize(tvdb, "w1280")).toBe(tvdb);
    expect(tmdbResize(tvdbV4, "w1280")).toBe(tvdbV4);
    expect(tmdbResize("https://ailleurs.example/original/x.jpg", "w300")).toBe("https://ailleurs.example/original/x.jpg");
  });

  it("laisse passer l'absence d'adresse", () => {
    expect(tmdbResize(null, "w500")).toBeNull();
    expect(tmdbResize(undefined, "w500")).toBeNull();
  });
});

describe("les visuels d'un titre", () => {
  /** `url` pointe sur le nom d'hôte interne de Radarr/Sonarr, que le navigateur n'atteint pas. */
  it("n'utilise que l'adresse publique, jamais celle du conteneur", () => {
    const images = [{ coverType: "poster", url: "http://sonarr:8989/MediaCover/1/poster.jpg" }];
    expect(posterUrl(images)).toBeNull();
  });

  it("rend la bannière de TheTVDB intacte", () => {
    expect(backdropUrl([{ coverType: "fanart", remoteUrl: tvdb }], "full")).toBe(tvdb);
    expect(backdropUrl([{ coverType: "fanart", remoteUrl: tvdb }], "thumb")).toBe(tvdb);
  });

  it("redimensionne encore celle de TMDB", () => {
    const images = [{ coverType: "fanart", remoteUrl: tmdb("/b.jpg") }];
    expect(backdropUrl(images, "thumb")).toBe("https://image.tmdb.org/t/p/w780/b.jpg");
  });

  it("rend null quand le type d'image demandé n'existe pas", () => {
    expect(backdropUrl([{ coverType: "poster", remoteUrl: tmdb("/p.jpg") }])).toBeNull();
  });
});
