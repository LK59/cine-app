// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
// Le temps regardé du lecteur serveur pendant une attente de l'élément (15/10/2026, LECTEUR-4).
// Le harnais est celui de PlayerHost-echelle.test.tsx : tout ce qui entoure le lecteur est simulé.

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
  PlayerControls: (props: { onClose: () => void }) => (
    <div data-testid="commandes">
      <button onClick={props.onClose}>fermer</button>
    </div>
  ),
}));

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
// Le lecteur serveur s'ouvre parce que le natif lui a passé ces titres (`handedOver`) : le choix
// « lecteur legacy » par compte, qui l'ouvrait d'office, a disparu le 13/10/2026.
const SERVEUR = vi.hoisted(() => ["film", "ep-1", "ep-2"]);
vi.mock("@/lib/useStableFallback", async (original) => ({
  ...(await original<typeof import("@/lib/useStableFallback")>()),
  useStableFallback: () => ({
    handedOver: SERVEUR,
    negotiating: false,
    reason: null,
    takeover: null,
    stepAside: vi.fn(),
    stepBack: vi.fn(),
    returning: null,
  }),
}));
const reportPlayback = vi.fn();
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: (...args: unknown[]) => reportPlayback(...args) }));
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: async () => {} }));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
// Safari : HLS natif — le chemin le plus simple de ce lecteur.
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => true }));
vi.mock("@/lib/resumePosition", () => ({ resolveResumeAt: async (_id: string, at: number | undefined) => at ?? 0 }));
vi.mock("@/lib/castRoute", () => ({ castRouteActive: () => false }));
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: () => ({ stop: async () => {}, reportNow: () => {}, resume: () => {} }),
  stopOrphanSession: async () => {},
}));

import { PlayerHost, __resetLegacyBlocklistPurgeForTests } from "@/components/PlayerHost";

const reponse = {
  playSessionId: "seance-jf",
  mediaSourceId: "source",
  isDirectPlay: false,
  manifestUrl: "/api/jellyfin/stream/film/master.m3u8",
  audioTracks: [],
  subtitleTracks: [],
  title: "Film",
};

/** Le corps de chaque négociation, dans l'ordre. */
let negociations: Record<string, unknown>[] = [];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body?: string }) => {
      if (url === "/api/jellyfin/playback/start") {
        negociations.push(JSON.parse(init?.body ?? "{}"));
        return { ok: true, status: 200, json: async () => reponse };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    })
  );
}

const video = () => document.querySelector("video")!;

function loadElement() {
  act(() => void video().dispatchEvent(new Event("loadeddata")));
}

async function nextNegotiation(count: number) {
  await waitFor(() => expect(negociations.length).toBe(count), { timeout: 6000 });
  // Laisse la négociation finir de poser la source avant le geste suivant.
  await act(async () => {});
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  // jsdom n'a pas `MediaError` ; l'écouteur d'erreur y lit `MEDIA_ERR_ABORTED`.
  vi.stubGlobal("MediaError", { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 });
  playback.session = { itemId: "film", openId: 1, resumeAt: 120, title: "Film" };
  playback.mode = "full";
  reportPlayback.mockClear();
  negociations = [];
  localStorage.clear();
  sessionStorage.clear();
  __resetLegacyBlocklistPurgeForTests();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("le temps regardé du lecteur serveur", () => {
  it("s'arrête pendant une attente de l'élément et repart à l'image", { timeout: 20_000 }, async () => {
    stubFetch();
    const { getByText } = render(<PlayerHost />);
    await nextNegotiation(1);
    loadElement();
    const now = vi.spyOn(Date, "now");
    let t = 5_000_000;
    now.mockImplementation(() => t);
    act(() => void video().dispatchEvent(new Event("play")));
    act(() => void video().dispatchEvent(new Event("playing")));
    t += 10_000;
    act(() => void video().dispatchEvent(new Event("waiting")));
    t += 120_000;
    act(() => void video().dispatchEvent(new Event("playing")));
    t += 5_000;
    act(() => void getByText("fermer").click());
    now.mockRestore();
    await waitFor(() => expect(reportPlayback.mock.calls.some(([k]) => k === "stop")).toBe(true));
    const stop = reportPlayback.mock.calls.filter(([k]) => k === "stop").map(([, f]) => f as Record<string, unknown>)[0];
    expect(stop.watched).toBe(15);
  });
});
