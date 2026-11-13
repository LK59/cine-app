// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { SWRConfig } from "swr";
import fr from "@/locales/fr.json";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import de from "@/locales/de.json";

/**
 * Les retouches de la fenêtre « Détails » du 13/11/2026 (DECISIONS.md §152), côté fiches :
 *
 *  - un petit « i » à côté du téléchargement de chaque ligne d'épisode, au téléphone et dans « Plus
 *    d'épisodes » du bureau, qui ouvre la fenêtre pour cet épisode — absent pour un épisode sans fichier, et
 *    dans un lien de partage ;
 *  - une légende sous le rond « Poser une question », le seul rond de la rangée du bureau qui n'en avait pas.
 */
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play: vi.fn() }), usePlaybackMode: () => "idle" }));
vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k),
  useLocale: () => ({ locale: "fr" }),
}));
const fetched: string[] = [];
vi.mock("@/lib/swr", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swr")>()),
  fetcher: (url: string) => {
    fetched.push(url);
    return new Promise(() => {});
  },
}));
vi.mock("@/lib/cinemaRoute", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cinemaRoute")>()),
  arrivedByBack: () => false,
  useSheetBehind: () => false,
  useRouteBehind: () => null,
}));
vi.mock("@/lib/usePlayerSeriesRequests", () => ({ usePlayerSeriesRequests: () => ({ seasons: [], episodes: [], seasonOf: () => undefined }) }));
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => true, useIsShortViewport: () => false, useIsTouch: () => true }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerEnabled: () => true, usePlayerEnabledState: () => true, usePlayerServerFallback: () => true }));
vi.mock("@/lib/useWatchlistStatusMap", () => ({ useWatchlistStatusMap: () => ({}) }));
vi.mock("@/lib/useAddToWatchlist", () => ({
  canJoinWatchlist: (tmdbId: number | null | undefined) => !!tmdbId,
  useAddToWatchlist: () => ({ addedStatus: null, addToWatchlist: vi.fn(), removeFromWatchlist: vi.fn() }),
}));
vi.mock("@/lib/useJellyfinItemState", () => ({ useJellyfinItemState: () => ({ watched: false, known: true, busy: false, toggleWatched: vi.fn() }) }));
vi.mock("@/lib/usePlaybackPrefetch", () => ({ usePlaybackPrefetch: () => {} }));
vi.mock("@/lib/missingFiles", () => ({ useFileMissing: () => false }));
vi.mock("@/components/cinema/CinemaSimilarRow", () => ({ useCinemaSimilar: () => [], CinemaSimilarRow: () => null }));
vi.mock("@/components/cinema/CinemaCollectionRow", () => ({ CinemaMovieCollectionRow: () => null }));
vi.mock("@/components/cinema/CinemaMissingEpisodes", () => ({ CinemaMissingEpisodes: () => null }));
vi.mock("@/components/PosterImage", () => ({ PosterImage: () => null }));
// Le téléchargement hors ligne fermé : le « i » ne dépend pas de lui.
vi.mock("@/lib/offline/useOfflineEnabled", () => ({ useOfflineDownloadsEnabled: () => false }));
// La question offerte, son panneau remplacé : seule la légende du rond est en cause ici.
vi.mock("@/lib/ask/client", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ask/client")>()), useAskAvailable: () => true }));
vi.mock("@/components/ask/AskPanel", () => ({ AskPanel: () => null }));

import { CinemaEpisodeBrowser } from "@/components/cinema/CinemaEpisodeBrowser";
import { CinemaMobileDetail } from "@/components/cinema/mobile/CinemaMobileDetail";
import { AskTitleControl } from "@/components/ask/AskTitleControl";
import type { CinemaSeason, CinemaEpisode } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";
import type { CinemaSeries } from "@/app/api/cinema/series/route";

const ep = (n: number, change: Partial<CinemaEpisode> = {}): CinemaEpisode => ({
  jellyfinItemId: `ep10${n}`,
  seasonNumber: 1,
  episodeNumber: n,
  title: `Épisode ${n}`,
  overview: null,
  thumbnailUrl: null,
  runtimeMinutes: 45,
  runtimeTicks: 27_000_000_000,
  watched: false,
  resumeTicks: null,
  ...change,
});
// L'épisode 3 est connu de Jellyfin sans fichier (`LocationType: "Virtual"`).
const S1: CinemaSeason = { seasonNumber: 1, episodes: [ep(1), ep(2), ep(3, { fileMissing: true })] };

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

afterEach(() => {
  cleanup();
  fetched.length = 0;
});

const detailsButtons = () => [...document.body.querySelectorAll<HTMLButtonElement>("[data-episode-details]")];

describe("le « i » d'une ligne d'épisode", () => {
  it("au téléphone : sur chaque épisode qui a un fichier, et pas sur celui qui n'en a pas", () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, fallback: { "/api/cinema/series/jfs/episodes": { seasons: [S1], nextEpisode: null } } }}>
        <CinemaMobileDetail item={SERIES} mediaType="series" onClose={vi.fn()} />
      </SWRConfig>
    );
    const rows = [...document.body.querySelectorAll<HTMLElement>("[data-episode-row]")];
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.querySelector("[data-episode-details]") !== null)).toEqual([true, true, false]);
    // Hors du bouton de l'épisode : jamais un bouton dans un bouton.
    expect(detailsButtons().every((b) => b.parentElement?.closest("button") === null)).toBe(true);
  });

  it("au bureau, dans « Plus d'épisodes » : présent quand la fiche le passe, et il ouvre la fenêtre de l'épisode", () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <CinemaEpisodeBrowser title="Une série" seasons={[S1]} episodeDetails={{ logoUrl: null }} onClose={vi.fn()} onPlayEpisode={vi.fn()} />
      </SWRConfig>
    );
    expect(detailsButtons()).toHaveLength(2);
    // Rien n'est demandé avant l'appui.
    expect(fetched.filter((u) => u.includes("/streams/"))).toEqual([]);
    fireEvent.click(detailsButtons()[1]);
    const dialog = screen.getByRole("dialog");
    // En tête le titre de la série (pas de logo ici), puis « S1 · É2 — Épisode 2 ».
    expect(within(dialog).getByRole("heading", { name: "Une série" })).toBeTruthy();
    expect(dialog.querySelector("[data-details-episode]")!.textContent).toBe('cinema.episodeShort:{"season":1,"episode":2} — Épisode 2');
    expect(fetched).toContain("/api/jellyfin/streams/ep102");
  });

  it("absent sans `episodeDetails` — le cas du lien de partage, qui ne le passe pas", () => {
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <CinemaEpisodeBrowser title="Une série" seasons={[S1]} onClose={vi.fn()} onPlayEpisode={vi.fn()} />
      </SWRConfig>
    );
    expect(document.body.querySelectorAll("[data-episode-row]")).toHaveLength(3);
    expect(detailsButtons()).toHaveLength(0);
  });

  it("le lien de partage n'en a pas, la fiche série du bureau si", () => {
    const share = readFileSync("src/components/shareGuest/ShareTitleSheet.tsx", "utf8");
    expect(share).toContain("<CinemaEpisodeBrowser");
    expect(share).not.toMatch(/episodeDetails|EpisodeDetailsButton|TitleDetailsSheet/);
    expect(readFileSync("src/components/cinema/CinemaSeriesDetail.tsx", "utf8")).toMatch(/episodeDetails=\{\{ logoUrl: item\.logoUrl \}\}/);
  });
});

describe("la légende du rond « Poser une question »", () => {
  it("un mot court sous le rond, sur une ligne, comme « Vu », « À voir » et « Infos »", () => {
    render(<AskTitleControl itemId="jf1" variant="round" />);
    const round = document.body.querySelector<HTMLElement>('[data-round-action="ask"]')!;
    const box = round.parentElement!;
    expect(box.className).toContain("min-w-14");
    const caption = box.querySelector<HTMLElement>("[data-round-caption]")!;
    expect(caption.textContent).toBe("ask.caption");
    expect(caption.className).toContain("whitespace-nowrap");
    expect(caption.getAttribute("aria-hidden")).toBe("true");
  });

  it("« Question », « Ask », « Pregunta », « Frage »", () => {
    const caption = (d: unknown) => (d as { ask: { caption: string } }).ask.caption;
    expect([fr, en, es, de].map(caption)).toEqual(["Question", "Ask", "Pregunta", "Frage"]);
  });
});
