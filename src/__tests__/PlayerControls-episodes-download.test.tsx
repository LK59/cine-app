// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { useRef, type RefObject } from "react";
import { SWRConfig } from "swr";

/**
 * Deux gestes du lecteur ajoutés le 19/10/2026 :
 * - le bouton « Épisodes », pour un épisode seulement : la saison en cours, l'épisode en cours marqué
 *   et inerte, un autre épisode lancé à sa position — celui d'avant, quitté par erreur ;
 * - « Télécharger le fichier » dans le ⋮, au bureau seulement et pour un compte que Jellyfin autorise.
 */

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
  useLocale: () => ({ locale: "fr" }),
}));
let mobile = false;
vi.mock("@/lib/useIsMobile", () => ({ useIsMobile: () => mobile, useIsTouch: () => mobile, useIsTablet: () => false, useIsShortViewport: () => false }));

import { PlayerControls } from "@/components/PlayerControls";

const SERIES = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ep = (id: string, n: number, extra: Record<string, unknown> = {}) => ({
  jellyfinItemId: id,
  seasonNumber: 1,
  episodeNumber: n,
  title: `Épisode ${n}`,
  overview: null,
  thumbnailUrl: null,
  runtimeMinutes: 42,
  runtimeTicks: 42 * 60 * 10_000_000,
  watched: false,
  resumeTicks: null,
  ...extra,
});
const EPISODES = {
  seasons: [
    // Le 2 quitté à 30 min par un bouton du casque : sa position est connue.
    { seasonNumber: 1, episodes: [ep("e1", 1, { watched: true }), ep("e2", 2, { resumeTicks: 30 * 60 * 10_000_000 }), ep("e3", 3)] },
    { seasonNumber: 2, episodes: [ep("f1", 1)] },
  ],
  nextEpisode: null,
};

let item: Record<string, unknown> = {};
beforeEach(() => {
  mobile = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = url.startsWith("/api/player/item/") ? item : url.endsWith("/episodes") ? EPISODES : null;
      return { ok: !!body, status: body ? 200 : 404, json: async () => body };
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const noop = () => {};

function Harness(props: Partial<React.ComponentProps<typeof PlayerControls>>) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <div ref={containerRef}>
        <video ref={videoRef} />
        <PlayerControls
          videoRef={videoRef as RefObject<HTMLVideoElement | null>}
          containerRef={containerRef}
          itemId="e3"
          title="Série — S01E03"
          onClose={noop}
          onMinimize={noop}
          onTogglePlaybackInfo={noop}
          audioTracks={[]}
          currentAudioId={null}
          onChangeAudio={noop}
          subtitleTracks={[]}
          currentSubtitleId={null}
          onChangeSubtitle={noop}
          hidden={false}
          loading={false}
          introSkip={null}
          creditsStart={null}
          nextEpisode={null}
          onAdvance={noop}
          {...props}
        />
      </div>
    </SWRConfig>
  );
}

const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 20))));

describe("le bouton « Épisodes »", () => {
  it("un épisode : la saison en cours, l'épisode d'avant relancé à sa position, l'épisode en cours inerte", async () => {
    item = { seriesId: SERIES, download: null };
    const onPlayEpisode = vi.fn();
    const { container } = render(<Harness onPlayEpisode={onPlayEpisode} />);
    await settle();
    const button = container.querySelector('[data-player-nav="episodes"]');
    expect(button).not.toBeNull();
    await act(async () => void fireEvent.click(button!));
    await waitFor(() => expect(container.querySelectorAll("[data-episode-row]")).toHaveLength(3));
    const rows = [...container.querySelectorAll<HTMLButtonElement>("[data-episode-row]")];
    expect(rows[2].getAttribute("aria-current")).toBe("true");
    // Deux saisons : le choix de la saison est là.
    expect(container.querySelector("[data-episodes-seasons]")).not.toBeNull();
    await act(async () => void fireEvent.click(rows[2]));
    expect(onPlayEpisode).not.toHaveBeenCalled();
    await act(async () => void fireEvent.click(rows[1]));
    expect(onPlayEpisode).toHaveBeenCalledWith({ itemId: "e2", title: "Épisode 2", resumeAt: 30 * 60 });
    // Le menu se referme sur le choix.
    expect(container.querySelector("[data-episode-row]")).toBeNull();
  });

  it("un film, ou un lecteur qui ne sait pas changer d'épisode : pas de bouton", async () => {
    item = { seriesId: null, download: null };
    const { container, unmount } = render(<Harness onPlayEpisode={vi.fn()} />);
    await settle();
    expect(container.querySelector('[data-player-nav="episodes"]')).toBeNull();
    unmount();
    item = { seriesId: SERIES, download: null };
    const again = render(<Harness />);
    await settle();
    expect(again.container.querySelector('[data-player-nav="episodes"]')).toBeNull();
  });
});

describe("« Télécharger le fichier »", () => {
  const openMore = async (container: HTMLElement) => {
    await act(async () => void fireEvent.click(container.querySelector('[data-player-nav="more"]')!));
  };

  it("au bureau, pour un compte autorisé : la ligne, vers la route, avec la taille", async () => {
    item = { seriesId: null, download: { sizeBytes: 1_100_000_000 } };
    const { container } = render(<Harness />);
    await settle();
    await openMore(container);
    const row = container.querySelector<HTMLAnchorElement>("[data-download-row]");
    expect(row).not.toBeNull();
    expect(row!.getAttribute("href")).toBe("/api/player/download/e3");
    expect(row!.hasAttribute("download")).toBe(true);
    expect(row!.textContent).toContain("1,1");
  });

  it("sans le droit, ou sur un téléphone ou une tablette tactile : pas de ligne", async () => {
    item = { seriesId: null, download: null };
    const first = render(<Harness />);
    await settle();
    await openMore(first.container);
    expect(first.container.querySelector("[data-download-row]")).toBeNull();
    first.unmount();
    mobile = true;
    item = { seriesId: null, download: { sizeBytes: 5 } };
    const second = render(<Harness />);
    await settle();
    await openMore(second.container);
    expect(second.container.querySelector("[data-download-row]")).toBeNull();
  });
});
