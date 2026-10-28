// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";

/**
 * La fiche d'un lien de partage pour un titre que Jellyfin a seul (§89, §112 ; audit des fiches,
 * 23/10/2026, V9).
 *
 * La fiche de l'invité ne demandait aucune description pour un tel titre (« rien à demander ») : ni
 * distribution, ni repli d'accroche ou de bande-annonce, alors que la fiche du foyer les a — depuis
 * §89, les routes `/info` répondent pour un identifiant réservé, par TMDB. La question est d'abord
 * celle de la porte des liens : elle accepte déjà cette adresse pour le titre du lien (la règle
 * `radarr` / `sonarr` compare le nombre de l'adresse à celui que le lien a gardé, réservé compris), et
 * ce test le prouve sans rien y changer — puis que la fiche s'en sert, comme au foyer.
 */
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play: vi.fn() }), usePlaybackMode: () => "closed" }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true, usePlayerEnabledState: () => true, usePlayerServerFallback: () => true }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));
let mobile = false;
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => mobile, useIsShortViewport: () => false, useIsTouch: () => false }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));
// La porte, sans la base : seule sa liste de règles sert ici.
vi.mock("@/lib/share/store", () => ({ sharesDb: {} }));
vi.mock("@/lib/share/scope", () => ({ itemInShare: vi.fn() }));

import { ShareTitleSheet } from "@/components/shareGuest/ShareTitleSheet";
import { shareAllows, shareRuleFor } from "@/lib/share/gate";
import { JELLYFIN_ONLY_ID_BASE } from "@/lib/jellyfinOnlyId";
import type { ShareTitlePayload } from "@/app/api/share/title/route";
import type { Share } from "@/lib/share/store";

const MOVIE_ID = "a".repeat(32);
const SERIES_ID = "b".repeat(32);
const RESERVED_MOVIE = JELLYFIN_ONLY_ID_BASE + 123;
const RESERVED_SERIES = JELLYFIN_ONLY_ID_BASE + 456;

const moviePayload = (): ShareTitlePayload =>
  ({
    kind: "movie",
    item: {
      radarrId: RESERVED_MOVIE,
      source: "jellyfin",
      tmdbId: 0,
      jellyfinItemId: MOVIE_ID,
      title: "Un film de Jellyfin seul",
      year: 2001,
      posterUrl: null,
      backdropUrl: null,
      logoUrl: null,
      posterTextlessUrl: null,
      overview: "Une histoire.",
      imdbRating: null,
      runtimeMinutes: 100,
      genres: [],
      addedAt: null,
    },
    expiresAt: Date.UTC(2026, 9, 27, 20, 0),
    maxStreams: 3,
    playingElsewhere: 0,
  }) as ShareTitlePayload;

const seriesPayload = (): ShareTitlePayload =>
  ({
    kind: "series",
    item: {
      sonarrId: RESERVED_SERIES,
      source: "jellyfin",
      tvdbId: 0,
      tmdbId: 5,
      jellyfinItemId: SERIES_ID,
      title: "Le Flambeau",
      year: 2022,
      posterUrl: null,
      backdropUrl: null,
      logoUrl: null,
      posterTextlessUrl: null,
      overview: "Des épisodes.",
      imdbRating: null,
      genres: [],
      addedAt: null,
      seasonCount: 1,
    },
    expiresAt: Date.UTC(2026, 9, 27, 20, 0),
    maxStreams: 3,
    playingElsewhere: 0,
  }) as ShareTitlePayload;

let requested: string[] = [];
beforeEach(() => {
  requested = [];
  mobile = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = String(input);
      requested.push(url);
      const json = (body: unknown) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
      if (url.startsWith(`/api/radarr/movies/${RESERVED_MOVIE}/info`)) {
        return json({ imdbId: null, trailerKey: null, tmdb: { overview: "", cast: [{ tmdbId: 1, name: "Alice" }, { tmdbId: 2, name: "Bruno" }] } });
      }
      if (url.startsWith(`/api/sonarr/series/${RESERVED_SERIES}/info`)) {
        return json({ imdbId: null, trailerKey: null, tmdb: { overview: "", cast: [{ tmdbId: 3, name: "Chloé" }] } });
      }
      if (url.startsWith(`/api/cinema/series/${SERIES_ID}/episodes`)) return json({ seasons: [], nextEpisode: null });
      return json({});
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = (payload: ShareTitlePayload) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ShareTitleSheet payload={payload} />
    </SWRConfig>
  );

const shareOf = (kind: "movie" | "series") =>
  ({
    kind,
    itemId: kind === "movie" ? MOVIE_ID : SERIES_ID,
    radarrId: kind === "movie" ? RESERVED_MOVIE : null,
    sonarrId: kind === "series" ? RESERVED_SERIES : null,
  }) as unknown as Share;
const url = (pathname: string) => ({ pathname, searchParams: new URLSearchParams() });

describe("la porte des liens, pour un titre que Jellyfin a seul (inchangée)", () => {
  it("accepte la description du titre du lien sous son identifiant réservé, et rien d'autre", async () => {
    expect(await shareAllows(shareOf("movie"), "GET", url(`/api/radarr/movies/${RESERVED_MOVIE}/info`))).toBe(true);
    expect(await shareAllows(shareOf("movie"), "GET", url(`/api/radarr/movies/${RESERVED_MOVIE + 1}/info`))).toBe(false);
    expect(await shareAllows(shareOf("movie"), "GET", url(`/api/sonarr/series/${RESERVED_MOVIE}/info`))).toBe(false);
    expect(await shareAllows(shareOf("series"), "GET", url(`/api/sonarr/series/${RESERVED_SERIES}/info`))).toBe(true);
    expect(await shareAllows(shareOf("series"), "GET", url(`/api/sonarr/series/${RESERVED_SERIES + 1}/info`))).toBe(false);
  });
});

describe.each([
  ["bureau", false],
  ["téléphone", true],
] as const)("fiche de l'invité, %s, titre que Jellyfin a seul", (_name, isPhone) => {
  it("un film : la distribution, comme au foyer", async () => {
    mobile = isPhone;
    show(moviePayload());
    await waitFor(() => expect(document.querySelector("[data-share-cast]")?.textContent).toContain("Alice, Bruno"));
    for (const u of requested) expect(shareRuleFor("GET", new URL(u, "https://cine.example").pathname), u).not.toBeNull();
  });

  it("une série : la distribution, comme au foyer", async () => {
    mobile = isPhone;
    show(seriesPayload());
    await waitFor(() => expect(document.querySelector("[data-share-cast]")?.textContent).toContain("Chloé"));
  });
});
