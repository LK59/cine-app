// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { SWRConfig } from "swr";

/**
 * Un épisode choisi dans « Plus d'épisodes » au bureau se lance, et reste lancé (18/10/2026).
 *
 * Le lecteur plein écran empile son entrée d'historique (§94, 15/10) ; la fiche série, elle,
 * refermait l'écran des épisodes juste après `play()` — par `history.back()`, qui retirait donc
 * l'entrée du lecteur à peine posée : Retour reconnu, le lecteur se fermait aussitôt (`stop "close"`,
 * rien de vu) et l'écran des épisodes restait là. Un clic sur un épisode « ne faisait rien ». Le
 * téléphone ne refermait rien et n'avait pas le défaut. Le vrai `PlaybackProvider`, le vrai
 * historique de jsdom, et un lecteur réduit à sa croix, comme `playerHistory.test.tsx`.
 */

vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
vi.mock("@/lib/unsentStop", () => ({ flushOrphanStops: async () => {} }));
vi.mock("@/lib/unsentLines", () => ({ flushUnsentLines: async () => {} }));
vi.mock("@/lib/unsentPosition", () => ({ flushUnsentPositions: async () => {}, unsentPositionsPending: () => false }));
vi.mock("@/lib/catalogueOutage", () => ({ playBlockedByOutage: () => false }));
vi.mock("@/lib/usePlayerEnabled", () => ({
  usePlayerEnabled: () => true,
  usePlayerEnabledState: () => true,
  usePlayerServerFallback: () => true,
}));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string) => k,
  useLocale: () => ({ locale: "fr" }),
}));
const EPISODES = {
  seasons: [
    {
      seasonNumber: 1,
      episodes: [
        { jellyfinItemId: "ep1", title: "Pilote", episodeNumber: 1, seasonNumber: 1, watched: false },
        { jellyfinItemId: "ep2", title: "Deuxième", episodeNumber: 2, seasonNumber: 1, watched: false },
      ],
    },
  ],
  nextEpisode: null,
};
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  // Seule la liste des épisodes répond ; le reste attend.
  fetcher: (url: string) => (url.endsWith("/episodes") ? Promise.resolve(EPISODES) : new Promise(() => {})),
}));
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  arrivedByBack: () => false,
  useSheetBehind: () => false,
  useRouteBehind: () => null,
}));
vi.mock("@/lib/usePlayerSeriesRequests", () => ({
  usePlayerSeriesRequests: () => ({ seasons: [], seasonOf: () => undefined }),
}));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => false, useIsShortViewport: () => false, useIsTouch: () => false }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/useAddToWatchlist", () => ({
  canJoinWatchlist: (tmdbId: number | null | undefined) => !!tmdbId,
  useAddToWatchlist: () => ({ addedStatus: null, addToWatchlist: vi.fn(), removeFromWatchlist: vi.fn() }),
}));
vi.mock("@/lib/useJellyfinItemState", () => ({
  useJellyfinItemState: () => ({ progress: { known: false }, watched: false, known: false, busy: false, toggleWatched: vi.fn() }),
}));
vi.mock("@/lib/usePlaybackPrefetch", () => ({ usePlaybackPrefetch: () => {} }));
vi.mock("@/lib/missingFiles", () => ({ useFileMissing: () => false }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({
  useCinemaSimilar: () => [],
  CinemaSimilarRow: () => null,
  similarRowKeyNav: () => false,
}));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({
  useCinemaCollection: () => ({ parts: [] }),
  CinemaCollectionRow: () => null,
  CinemaMovieCollectionRow: () => null,
}));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));

import { PlaybackProvider, usePlayback } from "@/components/PlaybackProvider";
import { usePlayerBackClose, __resetPlayerHistoryForTests } from "@/lib/playerHistory";
import { CinemaSeriesDetail } from "@/components/cinema/CinemaSeriesDetail";
import { cinemaNavigate } from "@/lib/cinemaRoute";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

const SERIES = {
  sonarrId: 7,
  tmdbId: 1234,
  jellyfinItemId: "jfs",
  title: "Une série",
  year: 1990,
  posterUrl: null,
  backdropUrl: null,
  logoUrl: null,
  genres: [],
} as unknown as CinemaSeries;

let api!: ReturnType<typeof usePlayback>;
const stops: string[] = [];

/** Un lecteur : sa croix écrit son bilan une fois, puis ferme la séance après son fondu. */
function FakePlayer() {
  const playback = usePlayback();
  const closed = useRef(false);
  const session = playback.session;
  const handleClose = () => {
    if (closed.current || !session) return;
    closed.current = true;
    stops.push("close");
    const openId = session.openId;
    setTimeout(() => playback.close(openId), 30);
  };
  usePlayerBackClose(handleClose);
  return null;
}

function Probe() {
  const playback = usePlayback();
  useEffect(() => {
    api = playback;
  });
  return playback.session ? <FakePlayer key={playback.session.openId} /> : null;
}

beforeEach(() => {
  __resetPlayerHistoryForTests();
  stops.length = 0;
  sessionStorage.clear();
  // Ouverts comme au clic — la fiche, puis « Plus d'épisodes » : deux entrées empilées, que
  // `cinemaClose` sait refermer par `history.back()`.
  window.history.replaceState(null, "", "/");
  cinemaNavigate({ serie: 7 });
  cinemaNavigate({ episodes: true });
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("« Plus d'épisodes » au bureau", () => {
  it("un épisode choisi se lance et le lecteur reste ouvert", async () => {
    const { findByText } = render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <PlaybackProvider>
          <Probe />
          <CinemaSeriesDetail item={SERIES} onClose={vi.fn()} />
        </PlaybackProvider>
      </SWRConfig>
    );
    fireEvent.click(await findByText(/Deuxième/));
    await waitFor(() => expect(api.session?.itemId).toBe("ep2"));
    // Le temps qu'un `history.back()` arrive et que la croix finisse son fondu.
    await act(async () => void (await new Promise((r) => setTimeout(r, 120))));
    expect(stops).toEqual([]);
    expect(api.session?.itemId).toBe("ep2");
  });
});
