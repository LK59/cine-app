// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, act, renderHook } from "@testing-library/react";

// « Deux sous-titres » dans le lecteur serveur (DECISIONS.md §87) : un seul sous-titre reste dessiné
// par le navigateur (`showing`) ; à deux, les deux pistes passent en `hidden` et la page dessine les
// deux au calque du lecteur natif — puis rend la main au navigateur quand on revient à un seul.

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
type ControlsProps = {
  subtitleTracks: { id: number; label: string }[];
  currentSubtitleId: number | null;
  onChangeSubtitle: (id: number | null) => void;
  secondSubtitle?: { currentId: number | null; onChange: (id: number | null) => void; offset?: unknown; generation?: unknown };
};
let controls: ControlsProps | null = null;
vi.mock("@/components/PlayerControls", () => ({
  PlayerControls: (props: ControlsProps) => {
    controls = props;
    return <div data-testid="commandes" />;
  },
}));
vi.mock("@/components/player/ChromecastPlayer", () => ({ ChromecastPlayer: () => <div data-testid="chromecast" /> }));

const playback = { session: null as null | Record<string, unknown>, mode: "full", close: vi.fn(), advance: vi.fn(), minimize: vi.fn(), expand: vi.fn() };
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => playback, PLAYER_RELOAD_INTENT_KEY: "reload-intent" }));
vi.mock("@/lib/useAccountPreferences", () => ({ useAccountPreferencesLoader: () => {} }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));
let takeover: unknown = null;
vi.mock("@/lib/useStableFallback", async (original) => ({
  ...(await original<typeof import("@/lib/useStableFallback")>()),
  useStableFallback: () => ({ handedOver: ["film"], negotiating: false, reason: null, takeover, stepAside: vi.fn(), stepBack: vi.fn(), returning: null }),
}));
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: vi.fn() }));
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: vi.fn(async () => {}) }));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => true }));
vi.mock("@/lib/resumePosition", () => ({ resolveResumeAt: async (_id: string, at: number | undefined) => at ?? 0 }));
vi.mock("@/lib/castRoute", () => ({ castRouteActive: () => false }));
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: () => ({ stop: vi.fn(async () => {}), reportNow: () => {}, resume: vi.fn() }),
  stopOrphanSession: vi.fn(async () => {}),
}));

import { PlayerHost } from "@/components/PlayerHost";
import { useServerDualSubtitles } from "@/lib/useServerDualSubtitles";

/** Une piste `<track>` comme le navigateur la tient : son mode, ses répliques actives, `cuechange`. */
class FakeTextTrack extends EventTarget {
  mode: TextTrackMode = "disabled";
  activeCues: { length: number; [i: number]: { startTime: number; text: string } } = { length: 0 };
  cues = this.activeCues;
  say(...texts: string[]) {
    const list: { length: number; [i: number]: { startTime: number; text: string } } = { length: texts.length };
    texts.forEach((text, i) => (list[i] = { startTime: i, text }));
    this.activeCues = list;
    this.dispatchEvent(new Event("cuechange"));
  }
}
const trackLists = new WeakMap<HTMLMediaElement, FakeTextTrack[]>();
function textTracksOf(video: HTMLMediaElement): FakeTextTrack[] {
  const list = trackLists.get(video) ?? [];
  const count = video.querySelectorAll("track").length;
  while (list.length < count) list.push(new FakeTextTrack());
  trackLists.set(video, list);
  return list;
}

const SUBTITLES = [
  { index: 2, url: "/s2.vtt", language: "eng", title: null, isDefault: false },
  { index: 3, url: "/s3.vtt", language: "fre", title: null, isDefault: false },
];

beforeEach(() => {
  window.localStorage.clear();
  Object.defineProperty(HTMLMediaElement.prototype, "textTracks", {
    configurable: true,
    get(this: HTMLMediaElement) {
      return textTracksOf(this);
    },
  });
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ playSessionId: "p", mediaSourceId: "m", manifestUrl: "/x.m3u8", audioTracks: [], subtitleTracks: SUBTITLES }),
      text: async () => "",
    }))
  );
  playback.session = { itemId: "film", openId: 1, resumeAt: 0, title: "Film" };
  takeover = null;
  controls = null;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLMediaElement.prototype as unknown as { textTracks?: unknown }).textTracks;
});

const tracks = () => textTracksOf(document.querySelector("video")!);
const modes = () => tracks().map((t) => t.mode);

async function opened() {
  render(<PlayerHost />);
  await waitFor(() => expect(controls?.subtitleTracks).toHaveLength(2));
}

describe("deux sous-titres — lecteur serveur", () => {
  it("le menu reçoit le second, sans décalage ni génération à lui (les lignes se décalent sur leur piste)", async () => {
    await opened();
    expect(controls!.secondSubtitle).toMatchObject({ currentId: null });
    expect(controls!.secondSubtitle!.offset).toBeUndefined();
    expect(controls!.secondSubtitle!.generation).toBeUndefined();
  });

  it("un seul : le navigateur dessine. Deux : les deux en `hidden`, et la page dessine les deux, le second au-dessus", async () => {
    await opened();
    await act(async () => controls!.onChangeSubtitle(2));
    expect(modes()).toEqual(["showing", "disabled"]);
    expect(document.querySelector("[data-subtitle-primary]")).toBeNull();

    await act(async () => controls!.secondSubtitle!.onChange(3));
    expect(modes()).toEqual(["hidden", "hidden"]);
    await act(async () => {
      tracks()[0].say("<i>Hello.</i>");
      tracks()[1].say("Bonjour.");
    });
    const row = document.querySelector('[data-subtitle-row="bottom"]')!;
    expect([...row.children].map((el) => el.textContent)).toEqual(["Bonjour.", "Hello."]);
    expect(row.lastElementChild!.hasAttribute("data-subtitle-primary")).toBe(true);

    // Le second se tait : le principal reste, à sa place.
    await act(async () => tracks()[1].say());
    expect(document.querySelector("[data-subtitle-second]")).toBeNull();
    expect(document.querySelector("[data-subtitle-primary]")?.textContent).toBe("Hello.");
  });

  it("revenir à un seul rend la main au navigateur ; éteindre le principal éteint tout", async () => {
    await opened();
    await act(async () => controls!.onChangeSubtitle(2));
    await act(async () => controls!.secondSubtitle!.onChange(3));
    await act(async () => controls!.secondSubtitle!.onChange(null));
    expect(modes()).toEqual(["showing", "disabled"]);
    expect(document.querySelector('[data-subtitle-row="bottom"]')).toBeNull();

    await act(async () => controls!.secondSubtitle!.onChange(3));
    await act(async () => controls!.onChangeSubtitle(null));
    expect(controls!.secondSubtitle!.currentId).toBeNull();
    expect(modes()).toEqual(["disabled", "disabled"]);
  });

  it("le second n'est jamais le principal, ni sans principal", async () => {
    await opened();
    await act(async () => controls!.secondSubtitle!.onChange(3));
    expect(controls!.secondSubtitle!.currentId).toBeNull();
    await act(async () => controls!.onChangeSubtitle(2));
    await act(async () => controls!.secondSubtitle!.onChange(2));
    expect(controls!.secondSubtitle!.currentId).toBeNull();
  });

  it("retenu sur l'appareil, réappliqué à l'ouverture si les langues sont dans le flux", async () => {
    await opened();
    await act(async () => controls!.onChangeSubtitle(2));
    await act(async () => controls!.secondSubtitle!.onChange(3));
    expect(JSON.parse(window.localStorage.getItem("cine:dual-subtitles")!)).toMatchObject({ primary: "en", second: "fr" });
    cleanup();
    controls = null;

    await opened();
    await waitFor(() => expect(controls!.secondSubtitle!.currentId).toBe(3));
    expect(controls!.currentSubtitleId).toBe(2);
    await waitFor(() => expect(modes()).toEqual(["hidden", "hidden"]));
  });
});

describe("useServerDualSubtitles", () => {
  it("pendant une diffusion, rien n'est touché : la télévision ne reçoit que le principal", () => {
    const video = document.createElement("video");
    video.append(document.createElement("track"), document.createElement("track"));
    const list = textTracksOf(video);
    list[0].mode = "showing";
    const { result } = renderHook(() =>
      useServerDualSubtitles({
        videoRef: { current: video },
        trackIds: [2, 3],
        primaryNow: () => 2,
        primary: 2,
        second: 3,
        enabled: false,
        videoKey: 0,
      })
    );
    expect(result.current.active).toBe(false);
    expect(list.map((t) => t.mode)).toEqual(["showing", "disabled"]);
  });
});
