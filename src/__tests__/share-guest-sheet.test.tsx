// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * La fiche d'un lien de partage (DECISIONS.md §112), vue par l'invité : le titre, Lire, la reprise, la
 * bande-annonce, les épisodes d'une série — et rien de ce que l'application montre autour d'une fiche
 * du foyer (« À voir », « Vu », téléchargement, personnes, titres similaires, épisodes manquants, rien
 * vers quoi se refermer).
 *
 * Chaque requête que la fiche envoie est confrontée à la vraie liste de la porte des liens
 * (`shareRuleFor`) : une fiche qui demanderait une route refusée à l'invité ferait échouer ce test, pas
 * seulement afficher un trou.
 */

const play = vi.fn();
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play }) }));
vi.mock("@/lib/usePlayerEnabled", () => ({
  usePlayerEnabled: () => true,
  usePlayerEnabledState: () => true,
  usePlayerServerFallback: () => true,
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string) => k,
  useLocale: () => ({ locale: "fr" }),
}));
let mobile = false;
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => mobile, useIsShortViewport: () => false, useIsTouch: () => false }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));
// La porte, sans la base : seule sa liste de règles sert ici.
vi.mock("@/lib/share/store", () => ({ sharesDb: {} }));
vi.mock("@/lib/share/scope", () => ({ itemInShare: vi.fn() }));

import { ShareTitleSheet } from "@/components/shareGuest/ShareTitleSheet";
import { shareRuleFor } from "@/lib/share/gate";
import type { ShareTitlePayload } from "@/app/api/share/title/route";

const MOVIE_ID = "a".repeat(32);
const SERIES_ID = "b".repeat(32);
const EP1 = "c".repeat(32);
const EP2 = "d".repeat(32);

const moviePayload = (over: Partial<ShareTitlePayload> = {}): ShareTitlePayload =>
  ({
    kind: "movie",
    item: {
      radarrId: 12,
      tmdbId: 99,
      jellyfinItemId: MOVIE_ID,
      title: "Un film",
      year: 1973,
      posterUrl: null,
      backdropUrl: null,
      logoUrl: null,
      posterTextlessUrl: null,
      overview: "Une histoire.",
      tagline: "",
      trailerKey: "yt-key",
      imdbRating: "8.1",
      runtimeMinutes: 120,
      genres: [],
      addedAt: null,
    },
    expiresAt: Date.UTC(2026, 9, 27, 20, 0),
    maxStreams: 3,
    playingElsewhere: 0,
    ...over,
  }) as ShareTitlePayload;

const seriesPayload = (over: Partial<ShareTitlePayload> = {}): ShareTitlePayload =>
  ({
    kind: "series",
    item: {
      sonarrId: 7,
      tvdbId: 1,
      tmdbId: 5,
      jellyfinItemId: SERIES_ID,
      title: "Une série",
      year: 2020,
      posterUrl: null,
      backdropUrl: null,
      logoUrl: null,
      posterTextlessUrl: null,
      overview: "Des épisodes.",
      tagline: "",
      trailerKey: null,
      imdbRating: null,
      genres: [],
      addedAt: null,
      seasonCount: 1,
    },
    expiresAt: Date.UTC(2026, 9, 27, 20, 0),
    maxStreams: 3,
    playingElsewhere: 0,
    ...over,
  }) as ShareTitlePayload;

const episodes = {
  seasons: [
    {
      seasonNumber: 1,
      episodes: [
        { jellyfinItemId: EP1, seasonNumber: 1, episodeNumber: 1, title: "Pilote", overview: null, thumbnailUrl: null, runtimeMinutes: 40, runtimeTicks: 24_000_000_000, watched: true, resumeTicks: null },
        { jellyfinItemId: EP2, seasonNumber: 1, episodeNumber: 2, title: "Deuxième", overview: null, thumbnailUrl: null, runtimeMinutes: 40, runtimeTicks: 24_000_000_000, watched: false, resumeTicks: 6_000_000_000 },
      ],
    },
  ],
  nextEpisode: { itemId: EP2, title: "Deuxième", resumeTicks: 6_000_000_000, runtimeTicks: 24_000_000_000, seasonNumber: 1, episodeNumber: 2 },
};

let requested: string[] = [];
beforeEach(() => {
  requested = [];
  mobile = false;
  play.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      requested.push(url);
      const json = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
      if (url.startsWith("/api/radarr/movies/12/info")) {
        return json({ imdbId: null, trailerKey: "yt-key", tmdb: { overview: "", cast: [{ tmdbId: 1, name: "Alice" }, { tmdbId: 2, name: "Bruno" }] } });
      }
      if (url.startsWith("/api/sonarr/series/7/info")) return json({ imdbId: null, trailerKey: null, tmdb: { overview: "", cast: [] } });
      if (url.startsWith(`/api/cinema/progress/${MOVIE_ID}`)) return json({ known: true, resumeTicks: 6_000_000_000, runtimeTicks: 72_000_000_000, played: false, favorite: false });
      if (url.startsWith(`/api/cinema/series/${SERIES_ID}/episodes`)) return json(episodes);
      return json({});
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(payload: ShareTitlePayload) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ShareTitleSheet payload={payload} />
    </SWRConfig>
  );
}

/** Chaque requête de la fiche est-elle une que la porte des liens connaît ? */
function everyRequestAllowed() {
  for (const url of requested) {
    const { pathname } = new URL(url, "https://cine.example");
    expect(shareRuleFor("GET", pathname), url).not.toBeNull();
  }
}

/**
 * Ce qu'une fiche du foyer propose et que l'invité n'a pas. (« Retour » n'en fait pas partie : l'écran
 * des épisodes a le sien, qui ramène à la fiche — la fiche elle-même n'en a pas, voir plus bas.)
 */
function noHouseholdControls() {
  for (const label of ["cinema.markWatched", "cinema.watchedState", "watchlist.statuses.toWatch", "cinema.inMyList", "cinema.similar"]) {
    expect(screen.queryByText(label), label).toBeNull();
  }
  expect(document.querySelector("[data-offline-download], [data-episode-download]")).toBeNull();
}

describe("fiche d'un lien de partage — bureau", () => {
  it("un film : Lire (reprise), Recommencer, Bande-annonce, la fin du lien — et rien d'autre", async () => {
    show(moviePayload());
    await waitFor(() => expect(screen.getByText("cinema.restartFromBeginning")).toBeTruthy());
    expect(screen.getByText("Un film")).toBeTruthy();
    expect(screen.getByText("cinema.trailer")).toBeTruthy();
    expect(screen.getByText("share.guest.availableUntil")).toBeTruthy();
    // La distribution en texte, sans aucun bouton vers une personne.
    await waitFor(() => expect(document.querySelector("[data-share-cast]")?.textContent).toContain("Alice, Bruno"));
    expect(document.querySelector("[data-share-cast] button")).toBeNull();
    noHouseholdControls();
    // La fiche est la page : rien vers quoi se refermer.
    expect(screen.queryByText("cinema.back")).toBeNull();

    fireEvent.click(screen.getByText("cinema.restartFromBeginning"));
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ itemId: MOVIE_ID, resumeAt: 0 }));
    everyRequestAllowed();
  });

  it("le lien est déjà lu sur trois appareils : la phrase remplace Lire, rien ne se lance", async () => {
    show(moviePayload({ playingElsewhere: 3 }));
    expect(screen.getByText("share.guest.streamsFull")).toBeTruthy();
    expect(document.querySelector("[data-play-unavailable], [data-detail-actions] button[title]")).toBeNull();
    expect(screen.queryByText("cinema.restartFromBeginning")).toBeNull();
    // La description du fichier n'est pas demandée d'avance : elle serait refusée.
    await waitFor(() => expect(requested.some((u) => u.startsWith("/api/radarr/movies/12/info"))).toBe(true));
    expect(requested.some((u) => u.startsWith("/api/jellyfin/direct/"))).toBe(false);
  });

  it("une série : l'épisode à suivre, puis l'écran des épisodes de l'application — sans ce qui manque ni téléchargement", async () => {
    show(seriesPayload());
    await waitFor(() => expect(screen.getByText("cinema.moreEpisodes")).toBeTruthy());
    expect(screen.queryByText("cinema.back")).toBeNull();
    fireEvent.click(screen.getByText("cinema.moreEpisodes"));
    await waitFor(() => expect(screen.getByText("2. Deuxième")).toBeTruthy());
    fireEvent.click(screen.getByText("2. Deuxième"));
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ itemId: EP2, resumeAt: 600 }));
    // L'épisode suivant reste branché : le lecteur enchaîne.
    expect(typeof play.mock.calls[0][0].getNextEpisode).toBe("function");
    noHouseholdControls();
    expect(requested.some((u) => u.includes("/missing"))).toBe(false);
    everyRequestAllowed();
  });
});

describe("fiche d'un lien de partage — téléphone", () => {
  it("une série : Lire l'épisode à suivre et la liste sous la fiche", async () => {
    mobile = true;
    show(seriesPayload());
    await waitFor(() => expect(document.querySelector("[data-share-episodes]")).toBeTruthy());
    expect(document.querySelector('[data-share-sheet="phone"]')).toBeTruthy();
    fireEvent.click(screen.getByText(/^1\. Pilote/));
    expect(play).toHaveBeenCalledWith(expect.objectContaining({ itemId: EP1, resumeAt: 0 }));
    noHouseholdControls();
    everyRequestAllowed();
  });

  it("le lien plein : ni Lire, ni épisode qui se lance", async () => {
    mobile = true;
    show(seriesPayload({ playingElsewhere: 5 }));
    await waitFor(() => expect(document.querySelector("[data-share-episodes]")).toBeTruthy());
    expect(screen.getByText("share.guest.streamsFull")).toBeTruthy();
    fireEvent.click(screen.getByText(/^2\. Deuxième/));
    expect(play).not.toHaveBeenCalled();
  });
});
