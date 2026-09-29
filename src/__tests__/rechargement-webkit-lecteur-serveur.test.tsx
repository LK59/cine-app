// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, act } from "@testing-library/react";

// Le rechargement WebKit que demande le lecteur serveur (changement de piste, escalade de l'échelle
// audio) rouvrait la page sur le lecteur **natif** : après le rechargement, `handedOver` et
// `takeover` sont vides, et seul le lecteur serveur lit `initialAudioStreamIndex`. La piste choisie
// était perdue, et après une escalade le natif reprenait le fichier qu'il venait d'abandonner.
// Ce test monte le vrai PlaybackProvider et le vrai aiguillage de PlayerHost : l'intention posée
// dans `sessionStorage` est le seul point d'entrée, comme sur la page rechargée.

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => ({ locale: "fr", setLocale: () => {} }),
}));
vi.mock("@/lib/useViewportResizing", () => ({ useViewportResizing: () => false }));
vi.mock("@/lib/useWakeLock", () => ({ useWakeLock: () => {} }));
vi.mock("@/lib/playerBench/bridge", () => ({ publishHandedOver: () => {} }));
vi.mock("@/components/MiniPlayer", () => ({
  MiniPlayerChrome: () => <div data-testid="mini" />,
  useMiniPlayerDrag: () => ({ pos: { x: 0, y: 0 }, size: { width: 1, height: 1 }, isDragging: false, handlers: {} }),
}));
vi.mock("@/components/PlaybackInfoPanel", () => ({ PlaybackInfoPanel: () => null }));
vi.mock("@/components/ExperimentalPlayerHost", () => ({ ExperimentalPlayerHost: () => <div data-testid="natif" /> }));
vi.mock("@/components/PlayerControls", () => ({
  VOLUME_STORAGE_KEY: "volume",
  PlayerControls: () => <div data-testid="commandes" />,
}));
// Un compte qui n'a pas choisi le lecteur stable : sans relais, c'est le natif qui s'ouvre.
vi.mock("@/lib/useLegacyPlayer", () => ({ useLegacyPlayer: () => ({ legacy: false }) }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: () => {} }));
vi.mock("@/lib/unsentStop", () => ({ flushOrphanStops: () => {} }));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => true }));
vi.mock("@/lib/resumePosition", () => ({ resolveResumeAt: async (_id: string, at: number | undefined) => at ?? 0 }));
vi.mock("@/lib/castRoute", () => ({ castRouteActive: () => false }));
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: () => ({ stop: vi.fn(async () => {}), resume: vi.fn() }),
  stopOrphanSession: vi.fn(async () => {}),
}));

import { PlaybackProvider, PLAYER_RELOAD_INTENT_KEY } from "@/components/PlaybackProvider";
import { PlayerHost } from "@/components/PlayerHost";

function negociations() {
  return (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter(([url]) => url === "/api/jellyfin/playback/start")
    .map(([, init]) => JSON.parse((init as { body: string }).body) as Record<string, unknown>);
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/jellyfin/playback/start") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            playSessionId: "seance-jf",
            mediaSourceId: "source",
            isDirectPlay: false,
            manifestUrl: "/api/jellyfin/stream/film/master.m3u8",
            audioTracks: [],
            subtitleTracks: [],
            title: "Film",
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    })
  );
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const monter = () =>
  render(
    <PlaybackProvider>
      <PlayerHost />
    </PlaybackProvider>
  );

describe("rechargement WebKit demandé par le lecteur serveur", () => {
  it("rouvre le lecteur serveur, sur la piste demandée", async () => {
    sessionStorage.setItem(
      PLAYER_RELOAD_INTENT_KEY,
      JSON.stringify({ itemId: "film", title: "Film", audioStreamIndex: 3, resumeAt: 600, server: true })
    );
    monter();

    // L'intention est relue à l'effet de montage : la séance est posée une fois celui-ci passé.
    await act(async () => {});
    expect(screen.queryByTestId("natif")).toBeNull();
    // Le délai de grâce d'après rechargement (3 s) passe avant la négociation.
    await waitFor(() => expect(negociations()).toHaveLength(1), { timeout: 5000 });
    expect(negociations()[0]).toMatchObject({ itemId: "film", audioStreamIndex: 3 });
  }, 10_000);

  it("une intention sans le champ garde l'aiguillage d'avant : le lecteur natif", async () => {
    sessionStorage.setItem(
      PLAYER_RELOAD_INTENT_KEY,
      JSON.stringify({ itemId: "film", title: "Film", audioStreamIndex: 3, resumeAt: 600 })
    );
    monter();

    await waitFor(() => expect(screen.getByTestId("natif")).toBeTruthy());
    expect(negociations()).toHaveLength(0);
  });
});
