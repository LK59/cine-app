// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";

// Le lecteur serveur (`ActivePlayer`, dans PlayerHost) : une fin d'épisode avec un épisode suivant
// laisse le lecteur ouvert et ferme la séance Jellyfin ; une relance doit la rouvrir. L'état « fermée
// par la fin » vivait dans la fermeture de l'effet `ended`, qui se réinstalle quand le lecteur passe
// en mini-lecteur ou revient en plein écran : réduit après la fin puis relancé, le second visionnage
// n'était jamais rapporté à Jellyfin (audit du 29/09/2026). Le harnais est celui de l'audit : tout ce
// qui entoure le lecteur est simulé, la négociation comprise.

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

// Les commandes, réduites aux trois gestes qui ferment ou rendent la séance.
vi.mock("@/components/PlayerControls", () => ({
  VOLUME_STORAGE_KEY: "volume",
  PlayerControls: (props: { onClose: () => void; onAdvance?: () => void; onCastReturn?: () => void }) => (
    <div data-testid="commandes">
      <button onClick={props.onClose}>fermer</button>
      {props.onAdvance && <button onClick={props.onAdvance}>suivant</button>}
      {props.onCastReturn && <button onClick={props.onCastReturn}>revenir</button>}
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
// Le compte a choisi le lecteur stable : c'est lui qui s'ouvre, sans passer par le natif.
vi.mock("@/lib/useLegacyPlayer", () => ({ useLegacyPlayer: () => ({ legacy: true }) }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));

/** L'état des relais — une diffusion en cours, quand un test le demande. */
let relais: { takeover: unknown } = { takeover: null };
const stepBack = vi.fn();
vi.mock("@/lib/useStableFallback", async (original) => ({
  ...(await original<typeof import("@/lib/useStableFallback")>()),
  useStableFallback: () => ({
    handedOver: [],
    negotiating: false,
    reason: null,
    takeover: relais.takeover,
    stepAside: vi.fn(),
    stepBack,
    returning: null,
  }),
}));

const reportPlayback = vi.fn();
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: (...args: unknown[]) => reportPlayback(...args) }));
const refreshAfterPlayback = vi.fn(async () => {});
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: (...args: unknown[]) => refreshAfterPlayback(...(args as [])) }));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
// Le HLS natif de Safari : pas de hls.js à charger dans le harnais.
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => true }));
vi.mock("@/lib/resumePosition", () => ({ resolveResumeAt: async (_id: string, at: number | undefined) => at ?? 0 }));
/** La route AirPlay est-elle établie au montage ? */
let routeEtablie = false;
vi.mock("@/lib/castRoute", () => ({ castRouteActive: () => routeEtablie }));

const stopNow = vi.fn(async () => {});
const resumeNow = vi.fn();
const stopOrphanSession = vi.fn(async () => {});
/** Ce que le lecteur annonce à Jellyfin, rendu après rendu : `null`/`false` veut dire « rien ». */
const seancesAnnoncees: unknown[] = [];
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: (_position: unknown, session: unknown) => {
    seancesAnnoncees.push(session);
    return { stop: stopNow, resume: resumeNow };
  },
  stopOrphanSession: (...args: unknown[]) => stopOrphanSession(...(args as [])),
}));

import { PlayerHost } from "@/components/PlayerHost";

/** La réponse de `/api/jellyfin/playback/start`. */
const reponse = {
  playSessionId: "seance-jf",
  mediaSourceId: "source",
  isDirectPlay: false,
  manifestUrl: "/api/jellyfin/stream/film/master.m3u8",
  audioTracks: [],
  subtitleTracks: [],
  title: "Film",
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/jellyfin/playback/start") {
        return { ok: true, status: 200, json: async () => reponse };
      }
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    })
  );
}

const lignes = (kind: string) => reportPlayback.mock.calls.filter(([k]) => k === kind).map(([, fields]) => fields as Record<string, unknown>);

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  playback.session = { itemId: "film", openId: 1, resumeAt: 120, title: "Film" };
  playback.mode = "full";
  relais = { takeover: null };
  routeEtablie = false;
  reportPlayback.mockClear();
  refreshAfterPlayback.mockClear();
  stopNow.mockClear();
  resumeNow.mockClear();
  stopOrphanSession.mockClear();
  stepBack.mockClear();
  playback.close.mockClear();
  seancesAnnoncees.length = 0;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PH-06 — fin d'épisode puis relance après un passage en mini-lecteur", () => {
  it("la relance rouvre la séance Jellyfin close par la fin", async () => {
    playback.session = {
      itemId: "ep-1",
      openId: 1,
      resumeAt: 0,
      title: "Ép. 1",
      getNextEpisode: () => ({ itemId: "ep-2", title: "Ép. 2" }),
    };
    stubFetch();
    const { rerender } = render(<PlayerHost />);
    await waitFor(() => expect(lignes("start")).toHaveLength(1));
    const video = document.querySelector("video")!;

    // Fin de l'épisode, plein écran, un épisode suivant : arrêt Jellyfin envoyé, lecteur ouvert.
    act(() => void video.dispatchEvent(new Event("ended")));
    expect(stopNow).toHaveBeenCalledTimes(1);

    // Le spectateur réduit le lecteur (l'effet `ended` se réinstalle), puis relance la lecture.
    playback.mode = "mini";
    rerender(<PlayerHost />);
    act(() => void video.dispatchEvent(new Event("play")));

    expect(resumeNow).toHaveBeenCalledTimes(1);
  });
});

describe("PH-06 témoin", () => {
  it("sans passage en mini-lecteur, la relance rouvre bien la séance", async () => {
    playback.session = { itemId: "ep-1", openId: 1, resumeAt: 0, title: "Ép. 1", getNextEpisode: () => ({ itemId: "ep-2", title: "Ép. 2" }) };
    stubFetch();
    render(<PlayerHost />);
    await waitFor(() => expect(lignes("start")).toHaveLength(1));
    const video = document.querySelector("video")!;
    act(() => void video.dispatchEvent(new Event("ended")));
    act(() => void video.dispatchEvent(new Event("play")));
    expect(resumeNow).toHaveBeenCalledTimes(1);
  });
});

describe("PH-06 — un autre épisode est une autre séance", () => {
  it("la fin de l'épisode précédent ne rouvre rien au premier play du suivant", async () => {
    playback.session = { itemId: "ep-1", openId: 1, resumeAt: 0, title: "Ép. 1", getNextEpisode: () => ({ itemId: "ep-2", title: "Ép. 2" }) };
    stubFetch();
    const { rerender } = render(<PlayerHost />);
    await waitFor(() => expect(lignes("start")).toHaveLength(1));
    const video = () => document.querySelector("video")!;
    act(() => void video().dispatchEvent(new Event("ended")));
    expect(stopNow).toHaveBeenCalledTimes(1);

    // L'épisode suivant, sur le même lecteur (même ouverture) : nouvelle négociation, nouvelle séance.
    playback.session = { itemId: "ep-2", openId: 1, resumeAt: 0, title: "Ép. 2", getNextEpisode: () => null };
    rerender(<PlayerHost />);
    await waitFor(() => expect(lignes("start")).toHaveLength(2));
    act(() => void video().dispatchEvent(new Event("play")));
    expect(resumeNow).not.toHaveBeenCalled();
  });
});
