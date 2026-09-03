// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor, fireEvent } from "@testing-library/react";

// The orchestrator, which is the one part of this player that had no tests and the one part that
// has produced regressions: it chooses the pipeline, gives the viewer back what they had chosen
// after a rebuild, decides whether a failure is a wait or a handover, and drives the spinner.
// Everything under it is mocked here on purpose — those layers have their own tests, and what is
// worth checking at this level is the decisions, not the decoding.

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (key: string) => key }));
vi.mock("@/lib/useViewportResizing", () => ({ useViewportResizing: () => false }));
vi.mock("@/lib/webcodecs/trace", () => ({ trace: vi.fn(), traceKeepAcrossReset: vi.fn() }));
vi.mock("@/lib/webcodecs/pathSelector", () => ({ describePath: () => "raison du choix" }));
vi.mock("@/lib/webcodecs/capabilities", () => ({
  probeCapabilities: async () => ({}),
  describeCapabilities: () => ({}),
}));
vi.mock("@/components/ExperimentalPlayerReport", () => ({
  ExperimentalPlayerReport: () => <div data-testid="report" />,
}));
vi.mock("@/components/MiniPlayer", () => ({
  MiniPlayerChrome: () => <div data-testid="mini" />,
  useMiniPlayerDrag: () => ({ pos: { x: 0, y: 0 }, size: { width: 1, height: 1 }, isDragging: false, handlers: {} }),
}));
vi.mock("@/lib/webcodecs/mediaFacade", () => ({
  MediaElementFacade: class {
    destroy = vi.fn();
  },
  asVideoElement: (facade: unknown) => facade,
}));

const stopPlaybackNow = vi.fn();
vi.mock("@/lib/usePlaybackSession", () => ({ usePlaybackSession: () => stopPlaybackNow }));
vi.mock("@/components/PlaybackProvider", () => ({
  usePlayback: () => ({ close: vi.fn(), minimize: vi.fn(), expand: vi.fn(), advance: vi.fn(), session: null }),
}));

// The controls, reduced to the two menus this component drives and the one prop it computes.
vi.mock("@/components/PlayerControls", () => ({
  PlayerControls: (props: {
    loading: boolean;
    audioTracks: { id: number; label: string }[];
    subtitleTracks: { id: number; label: string }[];
    onChangeAudio: (id: number) => void;
    onChangeSubtitle: (id: number | null) => void;
  }) => (
    <div data-testid="controls" data-loading={String(props.loading)}>
      {props.audioTracks.map((track) => (
        <button key={track.id} onClick={() => props.onChangeAudio(track.id)}>{`audio:${track.label}`}</button>
      ))}
      {props.subtitleTracks.map((track) => (
        <button key={track.id} onClick={() => props.onChangeSubtitle(track.id)}>{`st:${track.label}`}</button>
      ))}
    </div>
  ),
}));

// --- the file's description, as the route gives it -------------------------------------------

type Info = Record<string, unknown>;
let swr: { data: Info | undefined; error: unknown };
vi.mock("swr", () => ({ default: () => swr }));

function info(over: Info = {}): Info {
  return {
    streamUrl: "/stream.mkv",
    container: "mkv",
    refusedReason: null,
    canvasHdrRefusal: null,
    externalSubtitles: [],
    resumeSeconds: 0,
    video: { codec: "hevc", width: 1920, height: 1080, bitDepth: 10, isHdr: false, rangeType: "SDR" },
    introSkip: null,
    creditsStart: null,
    ...over,
  };
}

// --- the pipelines ----------------------------------------------------------------------------

type Callbacks = {
  onError: (message: string, kind?: "network" | "playback") => void;
  onWarning: (message: string) => void;
  onStarting: (at: number | null) => void;
  startSeconds: number;
};
let probes: Callbacks[] = [];
let nextProbe: () => unknown;

function fakeRemux(over: Record<string, unknown> = {}) {
  return {
    audioTracks: [
      { number: 1, codecId: "A_EAC3", language: "fre", name: null, isDefault: true, isForced: false },
      { number: 2, codecId: "A_AAC", language: "eng", name: null, isDefault: false, isForced: false },
    ],
    subtitleTracks: [{ number: 5, codecId: "S_TEXT/UTF8", language: "fre", name: null, isDefault: false, isForced: false }],
    currentAudioTrack: 1,
    selectAudioTrack: vi.fn(async () => {}),
    selectSubtitleTrack: vi.fn(),
    subtitleAt: vi.fn(() => null),
    diagnostics: {},
    destroy: vi.fn(),
    lost: false,
    position: 0,
    ...over,
  };
}

let remux: ReturnType<typeof fakeRemux>;

vi.mock("@/lib/webcodecs/remuxPlayback", () => ({
  probePlaybackPath: vi.fn(async (options: Callbacks) => {
    probes.push(options);
    return nextProbe();
  }),
}));

const engineHandlers = new Map<string, ((payload?: unknown) => void)[]>();
const emit = (event: string, payload?: unknown) =>
  act(() => void (engineHandlers.get(event) ?? []).forEach((handler) => handler(payload)));

vi.mock("@/lib/webcodecs/engine", () => ({
  PlaybackEngine: class {
    audioTracks = [{ number: 1, codecId: "A_AAC", language: "fre", name: null, isDefault: true, isForced: false }];
    subtitleTracks = [];
    currentAudioTrack = 1;
    diagnostics = {};
    on(event: string, handler: (payload?: unknown) => void) {
      const list = engineHandlers.get(event) ?? [];
      list.push(handler);
      engineHandlers.set(event, list);
      return () => {};
    }
    load = vi.fn(async () => {});
    play = vi.fn(async () => {});
    pause = vi.fn();
    destroy = vi.fn();
    resumeAudio = vi.fn();
    setSubtitleTrack = vi.fn();
    setAudioTrack = vi.fn(async () => {});
  },
}));

import { ExperimentalPlayerHost } from "@/components/ExperimentalPlayerHost";

const onFallback = vi.fn();

function mount(over: Partial<{ resumeAt: number; itemId: string }> = {}) {
  return render(
    <ExperimentalPlayerHost
      session={
        {
          itemId: over.itemId ?? "item-1",
          title: "Un film",
          resumeAt: over.resumeAt ?? null,
        } as never
      }
      mode="full"
      onFallback={onFallback}
    />
  );
}

/** The <video> the host mounts, with a clock it is allowed to have in jsdom. */
function videoElement(at = 0) {
  const element = document.querySelector("video")!;
  Object.defineProperty(element, "currentTime", { value: at, writable: true, configurable: true });
  return element;
}

const settle = () => act(async () => void (await Promise.resolve()));

beforeEach(() => {
  vi.clearAllMocks();
  probes = [];
  engineHandlers.clear();
  swr = { data: info(), error: undefined };
  remux = fakeRemux();
  nextProbe = () => ({ path: "remux", start: async () => remux, discard: vi.fn() });
  Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
  HTMLMediaElement.prototype.play = vi.fn(async () => {});
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ----------------------------------------------------------------------------------------------

describe("le chemin choisi", () => {
  it("monte le remultiplexage et publie ses pistes", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("controls")).toBeTruthy());
    expect(screen.getByText("audio:fre")).toBeTruthy();
    expect(screen.getByText("st:fre")).toBeTruthy();
  });

  it("donne l'URL à l'élément lui-même quand le fichier est déjà un MP4", async () => {
    nextProbe = () => ({ path: "direct", discard: vi.fn() });
    swr = { data: info({ container: "mp4", streamUrl: "/film.mp4" }), error: undefined };
    mount();

    await waitFor(() => expect(document.querySelector("video")!.getAttribute("src")).toBe("/film.mp4"));
    // Nothing opens the container on this path, so there are no track menus to offer.
    fireEvent(document.querySelector("video")!, new Event("loadedmetadata"));
    await waitFor(() => expect(screen.getByTestId("controls")).toBeTruthy());
    expect(screen.queryByText(/^audio:/)).toBeNull();
  });

  it("ne démarre rien pour un fichier que le serveur a déjà refusé", async () => {
    swr = { data: info({ refusedReason: "conteneur avi" }), error: undefined };
    mount();

    await waitFor(() => expect(onFallback).toHaveBeenCalledWith("conteneur avi"));
    // Starting a pipeline for a file already known to be unreadable is a decoder opened for
    // nothing, and a second failure to explain on top of the one that is already known.
    expect(probes).toHaveLength(0);
  });

  it("cède la main quand la description du fichier n'arrive pas", async () => {
    swr = { data: undefined, error: new Error("réseau") };
    mount();
    await waitFor(() => expect(onFallback).toHaveBeenCalledWith(expect.stringContaining("informations du fichier")));
  });
});

describe("l'attente", () => {
  it("retire le mot et le spinner dès que la lecture est prête", async () => {
    // The regression that shipped once: the pipeline was playing and the overlay still said it
    // was working, because readiness cleared one wait and not the other.
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    expect(screen.queryByText("player.experimental.loading")).toBeNull();
    expect(screen.queryByText("player.experimental.stillWorking")).toBeNull();
  });

  it("efface une reprise en attente au moment où le pipeline se déclare prêt", async () => {
    // A resume the previous pipeline was waiting for died with it. Left behind, it is a spinner
    // on the controls that nothing will ever answer.
    nextProbe = () => ({
      path: "remux",
      start: async () => {
        probes[probes.length - 1].onStarting(Date.now());
        return remux;
      },
      discard: vi.fn(),
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
  });

  it("cède la main quand aucune image n'arrive du tout", async () => {
    // The one failure a viewer cannot wait out: nothing on screen ever changes.
    vi.useFakeTimers();
    nextProbe = () => new Promise(() => {}) as never; // never settles
    mount();
    await act(async () => void vi.advanceTimersByTime(36000));
    expect(onFallback).toHaveBeenCalledWith(expect.stringContaining("aucune image"));
  });
});

describe("une coupure réseau", () => {
  it("attend au lieu de céder la main, en disant où et dans quelle langue", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));

    const element = videoElement(3725);
    await act(async () => void fireEvent(element, new Event("timeupdate")));
    act(() => probes[0].onError("plus de réseau", "network"));

    expect(screen.getByText("Connexion perdue")).toBeTruthy();
    expect(screen.getByText(/Reprise à 1 h 02/)).toBeTruthy();
    // Handing the file to a player that needs the very same network would give up hardware
    // decoding for a reason that has nothing to do with the file.
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("reprend exactement là où l'image s'est arrêtée quand on redemande", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));

    await act(async () => void fireEvent(videoElement(3725), new Event("timeupdate")));
    act(() => probes[0].onError("plus de réseau", "network"));
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /Réessayer/ })));

    await waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[1].startSeconds).toBeCloseTo(3725, 1);
  });

  it("repart tout seul quand le réseau revient, sans rien demander", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    mount();
    await act(async () => {});
    act(() => probes[0].onError("plus de réseau", "network"));
    expect(screen.getByText("Connexion perdue")).toBeTruthy();

    Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
    act(() => void window.dispatchEvent(new Event("online")));
    expect(screen.getByText("La connexion est revenue")).toBeTruthy();

    await act(async () => void vi.advanceTimersByTime(1000));
    expect(probes.length).toBeGreaterThan(1);
  });
});

describe("une source perdue", () => {
  it("reconstruit au lieu de reporter une panne", async () => {
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));

    remux.lost = true;
    remux.position = 100;
    act(() => probes[0].onError("la source est morte"));

    await waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[1].startSeconds).toBeCloseTo(100, 1);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("reprend au-delà du passage qui vient d'échouer plutôt que de le relire", async () => {
    // Reading the identical bytes again is a guaranteed way to die again — the record showed
    // three rebuilds each losing the source on the same segment.
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));

    remux.lost = true;
    remux.position = 100;
    act(() => probes[0].onError("morte"));
    await waitFor(() => expect(probes).toHaveLength(2));
    act(() => probes[1].onError("morte encore"));

    await waitFor(() => expect(probes).toHaveLength(3));
    expect(probes[2].startSeconds).toBeCloseTo(112, 1);
  });

  it("finit par céder la main plutôt que de reconstruire sans fin", async () => {
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    remux.lost = true;

    for (let attempt = 0; attempt < 4; attempt++) {
      const at = probes.length;
      act(() => probes[at - 1].onError("morte"));
      await act(async () => {});
    }
    expect(onFallback).toHaveBeenCalledWith("morte");
  });
});

describe("ce que le spectateur avait choisi", () => {
  it("rend la piste audio choisie au pipeline reconstruit", async () => {
    // A pipeline built again knows nothing: it opens on the file's own default track, which
    // after a cut means coming back to a film in the wrong language.
    mount();
    await waitFor(() => expect(screen.getByText("audio:eng")).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText("audio:eng")));

    const rebuilt = fakeRemux({ currentAudioTrack: 1 });
    nextProbe = () => ({ path: "remux", start: async () => rebuilt, discard: vi.fn() });
    remux.lost = true;
    act(() => probes[0].onError("morte"));

    await waitFor(() => expect(rebuilt.selectAudioTrack).toHaveBeenCalledWith(2));
  });

  it("ne repasse pas au pipeline un numéro qui n'appartient pas au fichier", async () => {
    // An external subtitle's number means nothing to a pipeline reading the container; passing
    // it down would select a track that does not exist, or none at all.
    swr = {
      data: info({ externalSubtitles: [{ id: -1, language: "fra", title: "Français", url: "/sub.vtt" }] }),
      error: undefined,
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "" })));
    mount();
    await waitFor(() => expect(screen.getByText("st:fra — Français")).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText("st:fra — Français")));

    const rebuilt = fakeRemux();
    nextProbe = () => ({ path: "remux", start: async () => rebuilt, discard: vi.fn() });
    remux.lost = true;
    act(() => probes[0].onError("morte"));

    await waitFor(() => expect(probes).toHaveLength(2));
    expect(rebuilt.selectSubtitleTrack).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("un autre film", () => {
  it("repart de rien, sans traîner ce que le précédent avait choisi", async () => {
    // Advancing to the next episode remounts this player, so everything it accumulated is gone
    // with it. That only holds while none of that state lives outside the component: a module
    // level variable would survive the remount and carry a track number — which on another file
    // may well be another language — straight into the next episode.
    mount();
    await waitFor(() => expect(screen.getByText("audio:eng")).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText("audio:eng")));
    cleanup();

    const next = fakeRemux({ currentAudioTrack: 1 });
    nextProbe = () => ({ path: "remux", start: async () => next, discard: vi.fn() });
    mount({ itemId: "item-2" });
    await waitFor(() => expect(screen.getByTestId("controls")).toBeTruthy());

    expect(next.selectAudioTrack).not.toHaveBeenCalled();
    expect(next.selectSubtitleTrack).not.toHaveBeenCalled();
    // And it opens where the new film asks to be opened, not where the last one stopped.
    expect(probes[probes.length - 1].startSeconds).toBe(0);
  });
});

describe("les sous-titres posés à côté du film", () => {
  const withExternal = () => {
    swr = {
      data: info({ externalSubtitles: [{ id: -1, language: "fra", title: "Français", url: "/sub.vtt" }] }),
      error: undefined,
    };
  };

  it("les propose à côté de celles du conteneur", async () => {
    withExternal();
    mount();
    await waitFor(() => expect(screen.getByText("st:fre")).toBeTruthy());
    expect(screen.getByText("st:fra — Français")).toBeTruthy();
  });

  it("éteint la piste du conteneur et affiche le fichier, à la bonne seconde", async () => {
    withExternal();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nBonjour." }))
    );
    mount();
    await waitFor(() => expect(screen.getByText("st:fra — Français")).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText("st:fra — Français")));

    // Two sources writing the same line would race; the container's is turned off first.
    expect(remux.selectSubtitleTrack).toHaveBeenCalledWith(null);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/sub.vtt", expect.anything()));

    await act(async () => void fireEvent(videoElement(2), new Event("timeupdate")));
    await waitFor(() => expect(screen.getByText("Bonjour.")).toBeTruthy());
    vi.unstubAllGlobals();
  });

  it("le dit sans rien casser quand le fichier ne vient pas", async () => {
    withExternal();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    mount();
    await waitFor(() => expect(screen.getByText("st:fra — Français")).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText("st:fra — Français")));

    await waitFor(() => expect(screen.getByText(/Sous-titres externes indisponibles/)).toBeTruthy());
    // A subtitle that could not be fetched is not a reason to abandon the film.
    expect(onFallback).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("le chemin canvas", () => {
  it("refuse le HDR seulement une fois qu'il est vraiment question de le convertir", async () => {
    // The native path shows this file's HDR untouched; it is landing on the canvas that makes
    // tone mapping necessary, so the refusal cannot be decided before the path is known.
    swr = { data: info({ canvasHdrRefusal: "HDR non converti" }), error: undefined };
    nextProbe = () => ({ path: "webcodecs", chosen: {}, discard: vi.fn() });
    mount();
    await waitFor(() => expect(onFallback).toHaveBeenCalledWith("HDR non converti"));
  });

  it("se tait sur les répliques du conteneur pendant qu'un fichier externe est affiché", async () => {
    swr = {
      data: info({ externalSubtitles: [{ id: -1, language: "fra", title: "Français", url: "/sub.vtt" }] }),
      error: undefined,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, text: async () => "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nDu fichier." }))
    );
    nextProbe = () => ({ path: "webcodecs", chosen: {}, discard: vi.fn() });
    mount();
    await waitFor(() => expect(screen.getByText("st:fra — Français")).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText("st:fra — Français")));
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    emit("subtitle", "Du conteneur.");
    expect(screen.queryByText("Du conteneur.")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("distingue un avertissement, qui laisse jouer, d'une erreur, qui arrête", async () => {
    nextProbe = () => ({ path: "webcodecs", chosen: {}, discard: vi.fn() });
    mount();
    await waitFor(() => expect(screen.getByTestId("controls")).toBeTruthy());

    emit("warning", "son dégradé");
    expect(screen.getByText("son dégradé")).toBeTruthy();
    expect(onFallback).not.toHaveBeenCalled();

    emit("error", "décodage impossible");
    expect(onFallback).toHaveBeenCalledWith("décodage impossible");
  });
});
