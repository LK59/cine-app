// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";
import { findOrphanStops, saveUnsentStop } from "@/lib/unsentStop";

// La fin d'une séance du lecteur serveur, par le comportement — avant tout découpage de PlayerHost
// (audit du 22/10/2026, « 2-playerhost-overlap », §2.1 et §5.2 : `pagehide` et le démontage n'avaient
// aucun test, ni la cadence du bilan gardé). Ce qui est vérifié : les lignes envoyées, par quel canal
// (balise ou `fetch`), une seule par séance quel que soit l'enchaînement — fermer, `pagehide`,
// démontage, épisode suivant, main rendue au natif à la fin d'une diffusion —, et la copie du bilan
// gardée dans `localStorage` (écrite tant que la séance vit, tenue « vivante ici », effacée à l'arrêt).
// Harnais de player-host-server.test.tsx (HLS natif de Safari, pas de hls.js).

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
  PlayerControls: (props: { onClose: () => void; onAdvance?: () => void; onPlayEpisode?: (e: { itemId: string; title: string; resumeAt: number }) => void }) => (
    <div data-testid="commandes">
      <button onClick={props.onClose}>fermer</button>
      {props.onAdvance && <button onClick={props.onAdvance}>suivant</button>}
      {props.onPlayEpisode && <button onClick={() => props.onPlayEpisode!({ itemId: "ep-4", title: "Épisode 4", resumeAt: 0 })}>épisode 4</button>}
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
const SERVEUR = vi.hoisted(() => ["film", "ep-1", "ep-2", "ep-3", "ep-4"]);
vi.mock("@/lib/useStableFallback", async (original) => ({
  ...(await original<typeof import("@/lib/useStableFallback")>()),
  useStableFallback: () => ({ handedOver: SERVEUR, negotiating: false, reason: null, takeover: relais.takeover, stepAside: vi.fn(), stepBack, returning: null }),
}));
/**
 * Les lignes du journal, relevées à l'entrée de `reportPlayback` ; `real` les laisse aussi partir par
 * le vrai module, pour voir le canal (balise ou `fetch`).
 */
const journal = vi.hoisted(() => ({ real: false, lines: [] as [string, Record<string, unknown>][] }));
vi.mock("@/lib/reportPlayback", async (original) => {
  const actual = await original<typeof import("@/lib/reportPlayback")>();
  return {
    reportPlayback: (kind: Parameters<typeof actual.reportPlayback>[0], fields: Record<string, unknown>) => {
      journal.lines.push([kind, fields]);
      if (journal.real) actual.reportPlayback(kind, fields);
    },
  };
});
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
const lignes = (kind: string) => journal.lines.filter(([k]) => k === kind).map(([, f]) => f);
const PREFIX = "cine:unsent-stop:";
const kept = (session: string) => JSON.parse(localStorage.getItem(PREFIX + session) ?? "null") as null | { savedAt: number; fields: Record<string, unknown> };
/** La séance du journal, telle que la ligne `start` la nomme. */
async function opened(): Promise<string> {
  await waitFor(() => expect(lignes("start")).toHaveLength(1));
  return lignes("start")[0].session as string;
}
const pagehide = (persisted: boolean) => act(() => void window.dispatchEvent(Object.assign(new Event("pagehide"), { persisted })));
/** La route AirPlay, lue par l'élément comme Safari la dit. */
const route = vi.hoisted(() => ({ wireless: false }));
function setRoute(wireless: boolean) {
  route.wireless = wireless;
  act(() => void document.querySelector("video")!.dispatchEvent(new Event("webkitcurrentplaybacktargetiswirelesschanged")));
}
function setVisibility(state: "hidden" | "visible") {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  act(() => void document.dispatchEvent(new Event("visibilitychange")));
}

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.stubGlobal("MediaError", { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 });
  Object.defineProperty(HTMLMediaElement.prototype, "webkitCurrentPlaybackTargetIsWireless", { configurable: true, get: () => route.wireless });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/jellyfin/playback/start") return { ok: true, status: 200, json: async () => reponse };
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    })
  );
  playback.session = { itemId: "film", openId: 1, resumeAt: 120, title: "Film" };
  playback.mode = "full";
  playback.close.mockClear();
  playback.advance.mockClear();
  relais.takeover = null;
  route.wireless = false;
  stepBack.mockClear();
  journal.real = false;
  journal.lines = [];
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete (HTMLMediaElement.prototype as { webkitCurrentPlaybackTargetIsWireless?: boolean }).webkitCurrentPlaybackTargetIsWireless;
  delete (document as { visibilityState?: string }).visibilityState;
  delete (navigator as { sendBeacon?: unknown }).sendBeacon;
});

describe("la page qui part (`pagehide`)", () => {
  it("non mise en cache : un `stop \"page\"` de la séance, et rien de plus ensuite — ni second `pagehide`, ni démontage", async () => {
    const { unmount } = render(<PlayerHost />);
    const session = await opened();
    pagehide(false);
    expect(lignes("stop")).toEqual([expect.objectContaining({ why: "page", session, itemId: "film", player: "serveur", path: "serveur" })]);
    pagehide(false);
    unmount();
    expect(lignes("stop")).toHaveLength(1);
  });

  it("mise en cache (bfcache) : rien ne part, la séance peut revenir ; le démontage écrit ensuite `unmount`", async () => {
    const { unmount } = render(<PlayerHost />);
    const session = await opened();
    pagehide(true);
    expect(lignes("stop")).toHaveLength(0);
    // Le bilan gardé, lui, reste sur l'appareil : c'est lui qui suffit si la page ne revient pas.
    expect(kept(session)).not.toBeNull();
    unmount();
    expect(lignes("stop")).toEqual([expect.objectContaining({ why: "unmount", session })]);
  });

  it("le `stop` d'un `pagehide` part par balise vers le journal, pas par `fetch`", async () => {
    journal.real = true;
    const beacon = vi.fn((_url: string, _data?: BodyInit | null) => true);
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
    render(<PlayerHost />);
    await opened();
    vi.mocked(fetch).mockClear();
    pagehide(false);
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0][0]).toBe("/api/player/log");
    const body = JSON.parse(await (beacon.mock.calls[0][1] as Blob).text());
    expect(body).toMatchObject({ kind: "stop", fields: { why: "page", player: "serveur" } });
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/player/log")).toHaveLength(0);
  });

  it("balise refusée : le même `stop` part par `fetch` keepalive, une seule fois", async () => {
    journal.real = true;
    const beacon = vi.fn(() => false);
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: beacon });
    const { unmount } = render(<PlayerHost />);
    await opened();
    vi.mocked(fetch).mockClear();
    pagehide(false);
    unmount();
    const posts = vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/player/log");
    const stops = posts.map(([, init]) => JSON.parse((init as RequestInit).body as string)).filter((b) => b.kind === "stop");
    expect(stops).toHaveLength(1);
    expect(stops[0].fields.why).toBe("page");
    expect(posts.find(([, init]) => JSON.parse((init as RequestInit).body as string).kind === "stop")![1]).toMatchObject({ keepalive: true, method: "POST" });
  });
});

describe("le démontage", () => {
  it("sans fermeture : un `stop \"unmount\"`", async () => {
    const { unmount } = render(<PlayerHost />);
    const session = await opened();
    unmount();
    expect(lignes("stop")).toEqual([expect.objectContaining({ why: "unmount", session })]);
  });

  it("après la croix : seulement le `stop \"close\"` — ni `pagehide`, ni démontage n'en ajoutent", async () => {
    const { unmount } = render(<PlayerHost />);
    await opened();
    fireEvent.click(screen.getByText("fermer"));
    pagehide(false);
    unmount();
    expect(lignes("stop").map((s) => s.why)).toEqual(["close"]);
  });
});

describe("l'épisode suivant ferme la séance", () => {
  const episode = { itemId: "ep-1", openId: 7, resumeAt: 600, title: "Épisode 1", getNextEpisode: () => ({ itemId: "ep-2", title: "Épisode 2" }) };

  it("`stop \"next\"`, puis ni `pagehide` ni démontage avant que l'épisode arrive n'écrivent un second bilan", async () => {
    playback.session = episode;
    const { unmount } = render(<PlayerHost />);
    await opened();
    fireEvent.click(screen.getByText("suivant"));
    expect(playback.advance).toHaveBeenCalledWith(expect.objectContaining({ itemId: "ep-2" }));
    pagehide(false);
    unmount();
    expect(lignes("stop").map((s) => s.why)).toEqual(["next"]);
  });

  it("l'épisode choisi dans le menu : le même `stop \"next\"`, une fois, puis la croix n'ajoute rien à cette séance", async () => {
    playback.session = episode;
    render(<PlayerHost />);
    const session = await opened();
    fireEvent.click(screen.getByText("épisode 4"));
    expect(playback.advance).toHaveBeenCalledWith(expect.objectContaining({ itemId: "ep-4" }));
    fireEvent.click(screen.getByText("fermer"));
    expect(lignes("stop")).toEqual([expect.objectContaining({ why: "next", session })]);
  });

  it("enchaîné en place puis `pagehide` : chaque épisode a son bilan, sous sa séance", async () => {
    playback.session = episode;
    const { rerender } = render(<PlayerHost />);
    await opened();
    fireEvent.click(screen.getByText("suivant"));
    playback.session = { itemId: "ep-2", openId: 7, resumeAt: 0, title: "Épisode 2" };
    rerender(<PlayerHost />);
    await waitFor(() => expect(lignes("start")).toHaveLength(2));
    pagehide(false);
    const stops = lignes("stop");
    expect(stops.map((s) => [s.why, s.itemId])).toEqual([["next", "ep-1"], ["page", "ep-2"]]);
    expect(stops[1].session).toBe(lignes("start")[1].session);
    expect(stops[0].session).not.toBe(stops[1].session);
  });
});

describe("la main rendue au lecteur natif à la fin d'une diffusion", () => {
  // Une séance ouverte pour diffuser : quand la télé lâche la route, sa ligne `fallback` raconte la fin
  // et la séance continue sur le natif. Ni `stop`, ni bilan gardé ici.
  it("route perdue : une ligne de fin de diffusion, la main rendue en pause, puis aucun `stop` — `pagehide` ou démontage", async () => {
    relais.takeover = { resumeAt: 120, owner: playback.session, cast: true };
    const { unmount } = render(<PlayerHost />);
    const session = await opened();
    setRoute(true);
    expect(lignes("cast")).toHaveLength(1);
    expect(kept(session)).not.toBeNull();
    setRoute(false);
    expect(lignes("fallback")).toEqual([expect.objectContaining({ cast: true, reason: "fin de diffusion (route sans fil perdue)", session })]);
    expect(stepBack).toHaveBeenCalledTimes(1);
    expect(stepBack.mock.calls[0][0]).toBe("film");
    expect(stepBack.mock.calls[0][3]).toBe(true);
    expect(kept(session)).toBeNull();
    pagehide(false);
    unmount();
    expect(lignes("stop")).toHaveLength(0);
  });
});

describe("le bilan gardé sur l'appareil", () => {
  it("écrit dès l'ouverture, sous la séance, en `lost` ; tenu « vivant ici » quel que soit son âge", async () => {
    render(<PlayerHost />);
    const session = await opened();
    await waitFor(() => expect(kept(session)).not.toBeNull());
    expect(kept(session)!.fields).toMatchObject({ why: "lost", session, player: "serveur", itemId: "film" });
    // Une heure plus tard sans réécriture, une page qui tient encore la séance ne la renvoie pas.
    expect(findOrphanStops(Date.now() + 3600_000, "compte").map((o) => o.key)).not.toContain(PREFIX + session);
  });

  it.each([
    ["la croix", () => fireEvent.click(screen.getByText("fermer"))],
    ["`pagehide`", () => pagehide(false)],
  ])("effacé par l'arrêt (%s), et la séance n'est plus tenue ici", async (_name, stop) => {
    render(<PlayerHost />);
    const session = await opened();
    await waitFor(() => expect(kept(session)).not.toBeNull());
    stop();
    expect(kept(session)).toBeNull();
    // Une copie qui reparaîtrait (un autre onglet, un ancien code) serait désormais orpheline.
    const old = Date.now() - 3600_000;
    saveUnsentStop(session, { why: "lost" }, old);
    expect(findOrphanStops(Date.now(), "compte").map((o) => o.key)).toContain(PREFIX + session);
  });

  it("réécrit toutes les 30 s et à chaque passage en arrière-plan ; plus jamais après l'arrêt", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    render(<PlayerHost />);
    const session = await opened();
    await waitFor(() => expect(kept(session)).not.toBeNull());
    const first = kept(session)!.savedAt;

    act(() => void vi.advanceTimersByTime(30_000));
    const second = kept(session)!.savedAt;
    expect(second - first).toBeGreaterThanOrEqual(30_000);

    // L'arrière-plan : réécrit à l'instant, sans attendre la minuterie, et compté au décompte.
    act(() => void vi.advanceTimersByTime(5_000));
    setVisibility("hidden");
    expect(kept(session)!.savedAt - second).toBeGreaterThanOrEqual(5_000);
    expect(kept(session)!.savedAt - second).toBeLessThan(30_000);
    act(() => void vi.advanceTimersByTime(4_000));
    setVisibility("visible");

    fireEvent.click(screen.getByText("fermer"));
    expect(lignes("stop")[0]).toMatchObject({ why: "close", backgrounds: 1 });
    act(() => void vi.advanceTimersByTime(90_000));
    expect(kept(session)).toBeNull();
  });

  it("après `stop \"next\"` (épisode pas encore arrivé), la minuterie ne réécrit plus le bilan de la séance close", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    playback.session = { itemId: "ep-1", openId: 7, resumeAt: 600, title: "Épisode 1", getNextEpisode: () => ({ itemId: "ep-2", title: "Épisode 2" }) };
    render(<PlayerHost />);
    const session = await opened();
    await waitFor(() => expect(kept(session)).not.toBeNull());
    fireEvent.click(screen.getByText("suivant"));
    expect(kept(session)).toBeNull();
    act(() => void vi.advanceTimersByTime(30_000));
    setVisibility("hidden");
    expect(kept(session)).toBeNull();
  });

  it("rien pour un banc d'essai", async () => {
    playback.session = { itemId: "film", openId: 1, resumeAt: 120, title: "Film", bench: "banc-1" };
    render(<PlayerHost />);
    const session = await opened();
    setVisibility("hidden");
    expect(kept(session)).toBeNull();
    expect(Object.keys(localStorage).filter((k) => k.startsWith(PREFIX))).toEqual([]);
  });
});
