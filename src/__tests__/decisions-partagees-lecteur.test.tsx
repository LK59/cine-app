// @vitest-environment jsdom
/**
 * Les décisions partagées du lecteur serveur, éprouvées par ce qu'il fait (22/10/2026).
 *
 * `decisions-partagees.test.ts` les gardait en cherchant une ligne dans `PlayerHost.tsx`
 * (`resolveResumeAt(itemId, initialResumeAt)`, `restoreRememberedVolume(`) : le découpage prévu de ce
 * fichier aurait cassé le test sans casser la règle. Ici, le lecteur est monté et on regarde ce
 * qu'il demande et ce qu'il pose sur l'élément. Harnais réduit de `player-host-server.test.tsx` —
 * mais `resolveResumeAt` et `restoreRememberedVolume` y sont les vrais.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";

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
vi.mock("@/components/PlayerControls", () => ({ PlayerControls: () => <div data-testid="commandes" /> }));

const playback = {
  session: null as null | Record<string, unknown>,
  mode: "full" as "full" | "mini" | "closed",
  close: vi.fn(),
  advance: vi.fn(),
  minimize: vi.fn(),
  expand: vi.fn(),
};
vi.mock("@/components/PlaybackProvider", () => ({
  usePlayback: () => playback,
  PLAYER_RELOAD_INTENT_KEY: "reload-intent",
}));
vi.mock("@/lib/useAccountPreferences", () => ({ useAccountPreferencesLoader: () => {} }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));
// Le lecteur serveur s'ouvre pour les titres que le natif lui a passés (`handedOver`).
vi.mock("@/lib/useStableFallback", async (original) => ({
  ...(await original<typeof import("@/lib/useStableFallback")>()),
  useStableFallback: () => ({
    handedOver: ["film"],
    negotiating: false,
    reason: null,
    takeover: null,
    stepAside: vi.fn(),
    stepBack: vi.fn(),
    returning: null,
  }),
}));
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: () => {} }));
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: async () => {} }));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => true }));
vi.mock("@/lib/castRoute", () => ({ castRouteActive: () => false }));
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: () => ({ stop: async () => {}, reportNow: () => {}, resume: vi.fn() }),
  stopOrphanSession: async () => {},
}));

import { PlayerHost } from "@/components/PlayerHost";
import { VOLUME_STORAGE_KEY } from "@/lib/rememberedVolume";

/** La position que Jellyfin connaît pour le film, rendue par `playback-state`. */
let positionServeur = 0;

function stubFetch() {
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
      if (url === "/api/jellyfin/playback-state/film") {
        return { ok: true, status: 200, json: async () => ({ resumeSeconds: positionServeur, known: true }) };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    })
  );
}

const appels = () => vi.mocked(fetch).mock.calls.map(([url]) => String(url));
const negociations = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([url]) => url === "/api/jellyfin/playback/start")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as Record<string, unknown>);

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  playback.mode = "full";
  positionServeur = 0;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// `resumeAt` absent veut dire « demande au serveur », pas « du début » (CLAUDE.md, `resolveResumeAt`).
// Le lecteur stable lisait l'absence comme un zéro : la séance d'un compte qui l'avait choisi repartait
// du début, puis ses rapports de progression effaçaient la position chez Jellyfin.
describe("le lecteur serveur et une position absente", () => {
  it("demande la position au serveur et ouvre là (moins le recul de la première ouverture)", async () => {
    playback.session = { itemId: "film", openId: 1, title: "Film" };
    positionServeur = 300;
    stubFetch();
    render(<PlayerHost />);
    await waitFor(() => expect(negociations()).toHaveLength(1));
    expect(appels()).toContain("/api/jellyfin/playback-state/film");
    expect(negociations()[0].startTicks).toBe(295 * 10_000_000);
  });

  it("une position affirmée — zéro compris — ne demande rien au serveur", async () => {
    playback.session = { itemId: "film", openId: 1, title: "Film", resumeAt: 0 };
    positionServeur = 300;
    stubFetch();
    render(<PlayerHost />);
    await waitFor(() => expect(negociations()).toHaveLength(1));
    expect(appels()).not.toContain("/api/jellyfin/playback-state/film");
    expect(negociations()[0].startTicks ?? 0).toBe(0);
  });
});

// DECISIONS.md §35 : le volume et le muet retenus par les commandes sont rendus à l'élément du
// lecteur serveur comme à celui du natif (`remembered-volume.test.tsx`).
describe("le lecteur serveur et le volume retenu", () => {
  it("pose le volume et le muet retenus sur son élément", async () => {
    localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify({ volume: 0.3, muted: true }));
    playback.session = { itemId: "film", openId: 1, title: "Film", resumeAt: 120 };
    stubFetch();
    render(<PlayerHost />);
    await waitFor(() => expect(negociations()).toHaveLength(1));
    const video = document.querySelector("video")!;
    expect(video.volume).toBe(0.3);
    expect(video.muted).toBe(true);
  });
});
