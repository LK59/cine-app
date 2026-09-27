// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent, waitFor } from "@testing-library/react";

// Le lecteur serveur (`ActivePlayer`, dans PlayerHost) n'avait aucun test de composant. Ce harnais
// le monte seul : tout ce qui l'entoure est simulé — la négociation avec Jellyfin, les commandes,
// le lecteur natif, les rapports —, et ce qui est vérifié ici, ce sont ses décisions de fin de
// séance : fermer, revenir de la télé, une négociation qui arrive trop tard. Les trois défauts
// relevés le 27/09/2026 en cartographiant le lecteur (docs/cycle-de-vie-lecteur.md, points 6, 7
// et 10) ont chacun leur test ici.

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
  useLocale: () => ({ locale: "fr", setLocale: () => {} }),
}));
vi.mock("@/lib/useViewportResizing", () => ({ useViewportResizing: () => false }));
vi.mock("@/lib/useWakeLock", () => ({ useWakeLock: () => {} }));
vi.mock("@/lib/playerBench/bridge", () => ({ publishHandedOver: () => {} }));
vi.mock("@/lib/resumeRewind", () => ({ noteWatching: vi.fn() }));
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
const stopOrphanSession = vi.fn(async () => {});
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: () => ({ stop: stopNow, resume: vi.fn() }),
  stopOrphanSession: (...args: unknown[]) => stopOrphanSession(...(args as [])),
}));

import { PlayerHost } from "@/components/PlayerHost";

/** La réponse de `/api/jellyfin/playback/start`, rendue quand le test le décide. */
let libererNegociation: () => void = () => {};
const reponse = {
  playSessionId: "seance-jf",
  mediaSourceId: "source",
  isDirectPlay: false,
  manifestUrl: "/api/jellyfin/stream/film/master.m3u8",
  audioTracks: [],
  subtitleTracks: [],
  title: "Film",
};

function stubFetch({ retenue = false } = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/jellyfin/playback/start") {
        if (retenue) await new Promise<void>((resolve) => (libererNegociation = resolve));
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
  stopOrphanSession.mockClear();
  stepBack.mockClear();
  playback.close.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("lecteur serveur — fermer", () => {
  it("une seule ligne `stop` et une seule relecture pour deux appuis", async () => {
    stubFetch();
    render(<PlayerHost />);
    await waitFor(() => expect(lignes("start")).toHaveLength(1));

    fireEvent.click(screen.getByText("fermer"));
    fireEvent.click(screen.getByText("fermer"));

    expect(lignes("stop")).toHaveLength(1);
    expect(stopNow).toHaveBeenCalledTimes(1);
    expect(refreshAfterPlayback).toHaveBeenCalledTimes(1);
  });
});

describe("lecteur serveur — une négociation qui répond trop tard", () => {
  it("fermé pendant la négociation : la séance ouverte chez Jellyfin est refermée, rien n'est lancé", async () => {
    stubFetch({ retenue: true });
    const { unmount } = render(<PlayerHost />);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/jellyfin/playback/start", expect.anything()));

    // Le lecteur part (fermeture, autre film) avant la réponse.
    unmount();
    await act(async () => libererNegociation());

    await waitFor(() => expect(stopOrphanSession).toHaveBeenCalledTimes(1));
    expect(stopOrphanSession).toHaveBeenCalledWith(
      { itemId: "film", playSessionId: "seance-jf", mediaSourceId: "source" },
      120
    );
    expect(lignes("start")).toHaveLength(0);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it("une négociation à l'heure n'est pas refermée", async () => {
    stubFetch();
    render(<PlayerHost />);
    await waitFor(() => expect(lignes("start")).toHaveLength(1));
    expect(stopOrphanSession).not.toHaveBeenCalled();
  });
});

describe("lecteur serveur — revenir sur le téléphone", () => {
  const diffusion = () => {
    // Une diffusion demandée depuis le lecteur natif : le relais appartient à cette séance.
    relais = { takeover: { resumeAt: 120, owner: playback.session, cast: true } };
  };

  it("arrête le téléviseur et écrit la fin de diffusion", async () => {
    diffusion();
    routeEtablie = true;
    stubFetch();
    render(<PlayerHost />);
    await waitFor(() => expect(lignes("cast")).toHaveLength(1));
    const video = document.querySelector("video")!;
    video.setAttribute("src", "/api/jellyfin/stream/film/master.m3u8");

    fireEvent.click(screen.getByText("revenir"));

    expect(lignes("fallback")).toEqual([expect.objectContaining({ cast: true, reason: "fin de diffusion (retour demandé sur le téléphone)" })]);
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(video.hasAttribute("src")).toBe(false);
    expect(stepBack).toHaveBeenCalledTimes(1);
  });

  it("sans route établie (sélecteur refermé sur le téléphone), écrit la ligne sans rien arrêter", async () => {
    diffusion();
    stubFetch();
    render(<PlayerHost />);
    await waitFor(() => expect(lignes("start")).toHaveLength(1));
    const video = document.querySelector("video")!;
    video.setAttribute("src", "/api/jellyfin/stream/film/master.m3u8");

    fireEvent.click(screen.getByText("revenir"));

    expect(lignes("fallback")).toHaveLength(1);
    expect(video.hasAttribute("src")).toBe(true);
    expect(stepBack).toHaveBeenCalledTimes(1);
  });
});
