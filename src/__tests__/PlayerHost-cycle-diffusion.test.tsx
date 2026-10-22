// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";

// La route AirPlay du lecteur serveur, l'écran « diffusion interrompue », le chien de garde de
// l'ouverture et le motif (`why`) de chaque négociation — par le comportement, avant tout découpage
// de PlayerHost (audit du 22/10/2026, « 2-playerhost-overlap », lot C : `useAirPlayRoute`,
// `ServerPlayerOverlays`, `serverLoadWatch`). Jusqu'ici, l'écran et sa relance n'étaient gardés que
// par des lectures du texte source (castToken.test.ts). Ici : ce que Safari signale à l'élément
// (`webkitcurrentplaybacktargetiswirelesschanged`, `remote` connect/disconnect), et ce qui en sort —
// lignes du journal, négociations, écrans. Harnais de player-host-server.test.tsx (HLS natif).

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
const relais = vi.hoisted(() => ({ takeover: null as unknown }));
const stepBack = vi.hoisted(() => vi.fn());
const SERVEUR = vi.hoisted(() => ["film"]);
vi.mock("@/lib/useStableFallback", async (original) => ({
  ...(await original<typeof import("@/lib/useStableFallback")>()),
  useStableFallback: () => ({ handedOver: SERVEUR, negotiating: false, reason: null, takeover: relais.takeover, stepAside: vi.fn(), stepBack, returning: null }),
}));
const reportPlayback = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: (...a: unknown[]) => reportPlayback(...a) }));
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: async () => {} }));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => true }));
vi.mock("@/lib/resumePosition", () => ({ resolveResumeAt: async (_id: string, at: number | undefined) => at ?? 0 }));
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: () => ({ stop: async () => {}, reportNow: () => {}, resume: () => {} }),
  stopOrphanSession: async () => {},
}));

import { PlayerHost } from "@/components/PlayerHost";

const reponse = {
  playSessionId: "seance-jf",
  mediaSourceId: "source",
  isDirectPlay: false,
  manifestUrl: "/api/jellyfin/stream/film/master.m3u8",
  audioTracks: [],
  subtitleTracks: [],
  title: "Film",
};
let negociations: Record<string, unknown>[] = [];
const lignes = (kind: string) => reportPlayback.mock.calls.filter(([k]) => k === kind).map(([, f]) => f as Record<string, unknown>);
const video = () => document.querySelector("video")!;
const fire = (name: string) => act(() => void video().dispatchEvent(new Event(name)));
async function nextNegotiation(count: number) {
  await waitFor(() => expect(negociations.length).toBe(count), { timeout: 6000 });
  await act(async () => {});
}
const wait = (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

/** La route AirPlay telle que l'élément la lit : l'attribut de WebKit, et l'API standard `remote`. */
const route = vi.hoisted(() => ({ wireless: false, remote: null as null | (EventTarget & { state: string }) }));
function setWireless(wireless: boolean) {
  route.wireless = wireless;
  fire("webkitcurrentplaybacktargetiswirelesschanged");
}
function failElement(code: number) {
  Object.defineProperty(video(), "error", { configurable: true, value: { code } });
  fire("error");
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal("MediaError", { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 });
  Object.defineProperty(HTMLMediaElement.prototype, "webkitCurrentPlaybackTargetIsWireless", { configurable: true, get: () => route.wireless });
  Object.defineProperty(HTMLMediaElement.prototype, "remote", { configurable: true, get: () => route.remote ?? undefined });
  negociations = [];
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
  playback.session = { itemId: "film", openId: 1, resumeAt: 120, title: "Film" };
  playback.close.mockClear();
  relais.takeover = null;
  route.wireless = false;
  route.remote = null;
  stepBack.mockClear();
  reportPlayback.mockClear();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLMediaElement.prototype as { webkitCurrentPlaybackTargetIsWireless?: boolean }).webkitCurrentPlaybackTargetIsWireless;
  delete (HTMLMediaElement.prototype as { remote?: unknown }).remote;
});

describe("la route AirPlay, écoutée dans toute séance du lecteur serveur", () => {
  it("une télé prend la route depuis les commandes de la vidéo : une ligne `cast`, une seule, et aucune renégociation", async () => {
    render(<PlayerHost />);
    await nextNegotiation(1);
    fire("loadeddata");
    setWireless(true);
    expect(lignes("cast")).toEqual([expect.objectContaining({ cast: true, path: "serveur", reason: "diffusion établie", itemId: "film", session: lignes("start")[0].session })]);
    // WebKit redit l'état : pas une seconde diffusion.
    setWireless(true);
    expect(lignes("cast")).toHaveLength(1);
    await wait(300);
    expect(negociations).toHaveLength(1);
    // Les lignes qui suivent disent la diffusion — l'arrêt compris.
    fireEvent.click(screen.getByText("fermer"));
    expect(lignes("stop")).toEqual([expect.objectContaining({ why: "close", cast: true })]);
  });

  it("un « faux » à l'arrivée n'est pas une fin de diffusion", async () => {
    render(<PlayerHost />);
    await nextNegotiation(1);
    setWireless(false);
    expect(lignes("cast")).toHaveLength(0);
    expect(lignes("fallback")).toHaveLength(0);
  });

  it("séance ordinaire, route perdue : la fin de diffusion écrite, mais le lecteur reste — ni main rendue, ni `stop`", async () => {
    render(<PlayerHost />);
    await nextNegotiation(1);
    setWireless(true);
    setWireless(false);
    expect(lignes("fallback")).toEqual([expect.objectContaining({ cast: true, reason: "fin de diffusion (route sans fil perdue)" })]);
    expect(stepBack).not.toHaveBeenCalled();
    expect(lignes("stop")).toHaveLength(0);
    expect(screen.getByTestId("commandes")).toBeTruthy();
  });

  it("l'API standard (`remote`) : connect puis disconnect — la même ligne d'établissement, la fin nommée « appareil distant déconnecté »", async () => {
    route.remote = Object.assign(new EventTarget(), { state: "disconnected" });
    relais.takeover = { resumeAt: 120, owner: playback.session, cast: true };
    render(<PlayerHost />);
    await nextNegotiation(1);
    route.remote.state = "connected";
    act(() => void route.remote!.dispatchEvent(new Event("connect")));
    expect(lignes("cast")).toHaveLength(1);
    route.remote.state = "disconnected";
    act(() => void route.remote!.dispatchEvent(new Event("disconnect")));
    expect(lignes("fallback")).toEqual([expect.objectContaining({ cast: true, reason: "fin de diffusion (appareil distant déconnecté)" })]);
    // Ouverte pour diffuser : la main revient au téléphone, en pause.
    expect(stepBack).toHaveBeenCalledTimes(1);
    expect(stepBack.mock.calls[0][3]).toBe(true);
  });

  it("une route déjà établie au montage (lecteur remonté pendant la diffusion) est lue une fois : la ligne `cast`", async () => {
    route.wireless = true;
    render(<PlayerHost />);
    await nextNegotiation(1);
    expect(lignes("cast")).toHaveLength(1);
  });

  it("la croix pendant la diffusion arrête la télé, et la fin de route qu'elle provoque n'écrit rien de plus", async () => {
    relais.takeover = { resumeAt: 120, owner: playback.session, cast: true };
    render(<PlayerHost />);
    await nextNegotiation(1);
    setWireless(true);
    video().setAttribute("src", "/api/jellyfin/stream/film/master.m3u8");
    fireEvent.click(screen.getByText("fermer"));
    expect(video().hasAttribute("src")).toBe(false);
    setWireless(false);
    expect(lignes("fallback")).toHaveLength(0);
    expect(stepBack).not.toHaveBeenCalled();
    expect(lignes("stop").map((s) => s.why)).toEqual(["close"]);
  });
});

describe("« diffusion interrompue » et sa relance", () => {
  async function interrupted() {
    render(<PlayerHost />);
    await nextNegotiation(1);
    fire("loadeddata");
    setWireless(true);
    failElement(4);
  }

  it("une erreur de l'élément pendant la diffusion : l'écran, la raison au journal, et ni reprise ni échelle", { timeout: 20_000 }, async () => {
    await interrupted();
    expect(screen.getByText("player.castInterrupted")).toBeTruthy();
    expect(lignes("error")).toEqual([expect.objectContaining({ path: "serveur", reason: "erreur pendant une diffusion — reprise refusée, relance proposée", code: 4 })]);
    // L'échelle aurait rejoué la demande au bout de 1,2 s — ce qui rompt la route AirPlay.
    await wait(1500);
    expect(negociations).toHaveLength(1);
    // L'écran d'erreur ordinaire ne se superpose pas.
    expect(screen.queryByText("common.retry")).toBeNull();
  });

  it("« Relancer » : l'écran part, une seule négociation `cast-relaunch` à la position atteinte, comptée au bilan", { timeout: 20_000 }, async () => {
    await interrupted();
    // La télé a joué jusqu'à 900 s : l'élément le dit (il tient une image).
    Object.defineProperty(video(), "readyState", { configurable: true, get: () => 4 });
    Object.defineProperty(video(), "currentTime", { configurable: true, get: () => 900, set: () => {} });
    fire("timeupdate");
    fireEvent.click(screen.getByText("player.castRelaunch"));
    await nextNegotiation(2);
    expect(screen.queryByText("player.castInterrupted")).toBeNull();
    expect(lignes("start").map((s) => s.why)).toEqual(["open", "cast-relaunch"]);
    expect(lignes("start")[1].at).toBe(900);
    await wait(300);
    expect(negociations).toHaveLength(2);
    fireEvent.click(screen.getByText("fermer"));
    expect(lignes("stop")[0]).toMatchObject({ why: "close", restarts: 1, restartWhy: expect.stringContaining("cast-relaunch") });
  });

  it("une nouvelle erreur après la relance, la route toujours tenue : l'écran revient plutôt que l'échelle", { timeout: 20_000 }, async () => {
    await interrupted();
    fireEvent.click(screen.getByText("player.castRelaunch"));
    await nextNegotiation(2);
    failElement(4);
    expect(screen.getByText("player.castInterrupted")).toBeTruthy();
    await wait(1500);
    expect(negociations).toHaveLength(2);
  });

  it("« Quitter » sur cet écran ferme la séance : un `stop \"close\"`", async () => {
    await interrupted();
    fireEvent.click(screen.getByText("player.quit"));
    expect(lignes("stop")).toEqual([expect.objectContaining({ why: "close" })]);
    await waitFor(() => expect(playback.close).toHaveBeenCalledWith(1));
  });

  it("hors diffusion, la même erreur prend l'échelle et non l'écran", { timeout: 20_000 }, async () => {
    render(<PlayerHost />);
    await nextNegotiation(1);
    failElement(4);
    expect(screen.queryByText("player.castInterrupted")).toBeNull();
    await nextNegotiation(2);
    expect(lignes("start")[1]).toMatchObject({ why: "ladder", rung: 1, trigger: "élément : code 4" });
  });
});

describe("le chien de garde de l'ouverture (20 s sans image)", () => {
  it("l'écran « trop long », la ligne `error` qui le dit, puis « Réessayer » : une négociation `retry`", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    render(<PlayerHost />);
    await nextNegotiation(1);
    act(() => void vi.advanceTimersByTime(20_000));
    expect(lignes("error")).toEqual([expect.objectContaining({ path: "serveur", reason: "pas de première image en 20 s" })]);
    expect(screen.getByText("player.loadingTooLong")).toBeTruthy();
    fireEvent.click(screen.getByText("common.retry"));
    await nextNegotiation(2);
    expect(lignes("start").map((s) => s.why)).toEqual(["open", "retry"]);
    expect(screen.queryByText("player.loadingTooLong")).toBeNull();
    fireEvent.click(screen.getByText("fermer"));
    expect(lignes("stop")[0]).toMatchObject({ why: "close", restarts: 1, restartWhy: expect.stringContaining("retry") });
  });

  it("une image avant l'échéance le désarme", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    render(<PlayerHost />);
    await nextNegotiation(1);
    act(() => void vi.advanceTimersByTime(5_000));
    fire("loadeddata");
    act(() => void vi.advanceTimersByTime(30_000));
    expect(lignes("error")).toHaveLength(0);
    expect(screen.queryByText("player.loadingTooLong")).toBeNull();
  });
});

describe("le motif de la première négociation", () => {
  it("une ouverture : `open`, sans relance au bilan", async () => {
    render(<PlayerHost />);
    await nextNegotiation(1);
    expect(lignes("start")).toEqual([expect.objectContaining({ why: "open", player: "serveur" })]);
    fireEvent.click(screen.getByText("fermer"));
    expect(lignes("stop")[0].restartWhy).toBeUndefined();
  });

  it("une page rechargée pour changer de piste (WebKit) : `audio-reload`", { timeout: 20_000 }, async () => {
    playback.session = { itemId: "film", openId: 1, resumeAt: 120, title: "Film", fromReload: true, audioStreamIndex: 2 };
    render(<PlayerHost />);
    await nextNegotiation(1);
    expect(lignes("start")[0]).toMatchObject({ why: "audio-reload" });
  });

  it("une page rechargée par l'échelle épuisée : `retry-reload`", { timeout: 20_000 }, async () => {
    playback.session = { itemId: "film", openId: 1, resumeAt: 120, title: "Film", fromReload: true, reloadAttempt: 1 };
    render(<PlayerHost />);
    await nextNegotiation(1);
    expect(lignes("start")[0]).toMatchObject({ why: "retry-reload" });
  });
});
