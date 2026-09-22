// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor, fireEvent } from "@testing-library/react";

// The orchestrator, which is the one part of this player that had no tests and the one part that
// has produced regressions: it chooses the pipeline, gives the viewer back what they had chosen
// after a rebuild, decides whether a failure is a wait or a handover, and drives the spinner.
// Everything under it is mocked here on purpose — those layers have their own tests, and what is
// worth checking at this level is the decisions, not the decoding.

// Les étiquettes de pistes ont une forme fixe depuis le 20/09/2026 — « Anglais — Dolby TrueHD —
// 7.1 » et non plus le code de langue brut. Ces tests interrogent donc le début de l'étiquette
// plutôt que sa totalité : ce qu'ils vérifient est le comportement du menu, pas la typographie.
//
// `useLocale` est arrivé avec les étiquettes de pistes : le double doit suivre, sinon tout le
// fichier tombe sur un export manquant plutôt que sur ce qu'il teste.
vi.mock("@/components/TranslationProvider", () => ({
  // Le dernier segment de la clé plutôt que la clé entière : les étiquettes de pistes en
  // deviennent lisibles dans les assertions — « Français — full (external) ».
  useT: () => (key: string) => key.split(".").pop() ?? key,
  useLocale: () => ({ locale: "fr", setLocale: () => {} }),
}));
vi.mock("@/lib/useViewportResizing", () => ({ useViewportResizing: () => false }));
vi.mock("@/lib/webcodecs/trace", () => ({ trace: vi.fn(), traceKeepAcrossReset: vi.fn(), traceRecent: () => [] }));
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
const facadeSeeks: number[] = [];
vi.mock("@/lib/webcodecs/mediaFacade", () => ({
  MediaElementFacade: class {
    constructor(readonly engine: { seek?: (at: number) => void; play: () => Promise<void> }) {}
    destroy = vi.fn();
    set currentTime(at: number) {
      facadeSeeks.push(at);
    }
    play() {
      return this.engine.play();
    }
  },
  asVideoElement: (facade: unknown) => facade,
}));

const stopPlaybackNow = vi.fn();
/** Ce que le lecteur annonce à Jellyfin, rendu après rendu : `null` veut dire « pas de séance ». */
const announcedSessions: unknown[] = [];
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: (_position: unknown, session: unknown) => {
    announcedSessions.push(session);
    return stopPlaybackNow;
  },
}));
vi.mock("@/components/player/PlayerEndScreen", () => ({
  PlayerEndScreen: (props: { onReplay: () => void }) => <button onClick={props.onReplay}>revoir</button>,
}));
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
    onSeekRequest?: (seconds: number) => void;
    suspended?: boolean;
  }) => (
    <div data-testid="controls" data-loading={String(props.loading)} data-suspended={String(!!props.suspended)}>
      {/* Un saut demandé depuis les commandes : le signal d'abord, puis l'élément, comme elles. */}
      <button
        onClick={(e) => {
          const target = Number((e.currentTarget as HTMLButtonElement).dataset.to);
          props.onSeekRequest?.(target);
        }}
        data-to="600"
      >
        saut:600
      </button>
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

/**
 * Y a-t-il un lecteur serveur derrière ? `undefined` par défaut, comme pendant l'attente réelle.
 *
 * C'est ce qui décide du sens de « renoncer » : céder la main, ou s'arrêter en le disant.
 */
let serverFallback: boolean | undefined;
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => serverFallback }));

/**
 * Ce que la route `playback-state` répond — position et préférences.
 *
 * Ces deux champs vivaient dans la charge du fichier, et c'est précisément ce qu'on a séparé :
 * le fichier ne change jamais, le spectateur si.
 */
let viewerState: { resumeSeconds: number; preferences: unknown } | null;

/**
 * Le `fetch` du harnais.
 *
 * Le lecteur lit l'état du spectateur à chaque ouverture ; un test qui remplace `fetch` pour ses
 * propres besoins doit donc quand même répondre à cette adresse-là, sinon il coupe une lecture
 * qui n'a rien à voir avec ce qu'il examine. D'où ce point d'entrée unique : l'état d'abord, le
 * reste au test.
 */
function stubFetch(rest: (url: string) => unknown = () => ({ ok: true, text: async () => "" })) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (typeof url === "string" && url.startsWith("/api/jellyfin/playback-state/")) {
        return { ok: true, json: async () => viewerState };
      }
      return rest(url);
    })
  );
}

function info(over: Info = {}): Info {
  return {
    streamUrl: "/stream.mkv",
    container: "mkv",
    refusedReason: null,
    canvasHdrRefusal: null,
    externalSubtitles: [],
    video: { codec: "hevc", width: 1920, height: 1080, bitDepth: 10, isHdr: false, rangeType: "SDR" },
    introSkip: null,
    creditsStart: null,
    ...over,
  };
}

// --- the pipelines ----------------------------------------------------------------------------

type Callbacks = {
  onError: (message: string, kind?: "network" | "playback") => void;
  onWarning: (warning: { code: string; detail?: string }) => void;
  onStarting: (at: number | null) => void;
  startSeconds: number;
};
let probes: Callbacks[] = [];
let nextProbe: () => unknown;

function fakeRemux(over: Record<string, unknown> = {}) {
  const fake = {
    audioTracks: [
      { number: 1, codecId: "A_EAC3", language: "fre", name: null, isDefault: true, isForced: false },
      { number: 2, codecId: "A_AAC", language: "eng", name: null, isDefault: false, isForced: false },
    ],
    subtitleTracks: [{ number: 5, codecId: "S_TEXT/UTF8", language: "fre", name: null, isDefault: false, isForced: false }],
    currentAudioTrack: 1,
    // Par défaut ce chemin porte tout : les tests qui examinent le refus le disent eux-mêmes.
    canCarryAudio: vi.fn(() => true),
    // Tout changement de piste reconstruit le lecteur ; seul un fichier sans index en cours de
    // film le refuse, et les tests qui l'examinent le disent eux-mêmes.
    requestAudioTrack: vi.fn((id: number): "rebuild" | "refused" | null => (id === fake.currentAudioTrack ? null : "rebuild")),
    selectSubtitleTrack: vi.fn(),
    subtitleAt: vi.fn(() => null),
    diagnostics: {},
    destroy: vi.fn(),
    lost: false,
    position: 0,
    ...over,
  };
  return fake;
}

/** Le pipeline qu'une reconstruction ouvre, directement sur la piste demandée. */
function rebuildOn(track: number) {
  const rebuilt = fakeRemux({ currentAudioTrack: track });
  nextProbe = () => ({ path: "remux", start: async () => rebuilt, discard: vi.fn() });
  return rebuilt;
}

let remux: ReturnType<typeof fakeRemux>;

vi.mock("@/lib/webcodecs/remuxPlayback", () => ({
  probePlaybackPath: vi.fn(async (options: Callbacks) => {
    probes.push(options);
    return nextProbe();
  }),
}));

/** Les pistes du moteur canevas — une seule par défaut, les tests qui en veulent plus le disent. */
const ONE_ENGINE_TRACK = [{ number: 1, codecId: "A_AAC", language: "fre", name: null, isDefault: true, isForced: false }];
let engineAudio: unknown[] = ONE_ENGINE_TRACK;
let engineSubtitles: unknown[] = [];
const engineHandlers = new Map<string, ((payload?: unknown) => void)[]>();
/** Les moteurs construits, pour lire ce qu'on a demandé à `load`. */
const engineInstances: { load: ReturnType<typeof vi.fn> }[] = [];
const emit = (event: string, payload?: unknown) =>
  act(() => void (engineHandlers.get(event) ?? []).forEach((handler) => handler(payload)));

vi.mock("@/lib/webcodecs/engine", () => ({
  PlaybackEngine: class {
    constructor() {
      engineInstances.push(this as never);
    }
    audioTracks = engineAudio;
    subtitleTracks = engineSubtitles;
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

function player(over: Partial<{ resumeAt: number; itemId: string; mode: "full" | "mini" }> = {}) {
  return (
    <ExperimentalPlayerHost
      session={
        {
          itemId: over.itemId ?? "item-1",
          title: "Un film",
          resumeAt: over.resumeAt ?? null,
        } as never
      }
      mode={over.mode ?? "full"}
      // Deliberately a fresh function each time, as the parent used to hand down.
      // Le relais n'est transmis que lorsqu'il existe : un repli au démarrage n'en porte pas, et
      // le noter quand même ferait lire à chaque assertion un argument qui ne veut rien dire.
      onFallback={(reason, takeover) => (takeover ? onFallback(reason, takeover) : onFallback(reason))}
    />
  );
}

function mount(over: Partial<{ resumeAt: number; itemId: string; mode: "full" | "mini" }> = {}) {
  return render(player(over));
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
  serverFallback = undefined;
  probes = [];
  engineHandlers.clear();
  engineInstances.length = 0;
  engineAudio = ONE_ENGINE_TRACK;
  engineSubtitles = [];
  announcedSessions.length = 0;
  swr = { data: info(), error: undefined };
  viewerState = { resumeSeconds: 0, preferences: null };
  stubFetch();
  remux = fakeRemux();
  nextProbe = () => ({ path: "remux", start: async () => remux, discard: vi.fn() });
  Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
  HTMLMediaElement.prototype.play = vi.fn(async () => {});
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ----------------------------------------------------------------------------------------------

describe("une piste que ce chemin ne portera jamais", () => {
  // Le cas TrueHD : le film joue parfaitement en français, et la VO est enfermée dans un codec
  // qu'aucun navigateur ne décode. L'ancien comportement disait au spectateur que sa langue était
  // indisponible ; le lecteur serveur, lui, sait la porter — Jellyfin ne ré-encode que l'audio et
  // recopie la vidéo. Renoncer ici serait renoncer pour rien.
  beforeEach(() => {
    remux = fakeRemux({
      audioTracks: [
        { number: 1, codecId: "A_DTS", language: "fre", name: null, isDefault: true, isForced: false },
        { number: 2, codecId: "A_TRUEHD", language: "eng", name: null, isDefault: false, isForced: false },
      ],
      canCarryAudio: vi.fn((n: number) => n !== 2),
    });
    nextProbe = () => ({ path: "remux", start: async () => remux, discard: vi.fn() });
    serverFallback = true;
  });

  it("cède la main au lecteur serveur au lieu de refuser la VO", async () => {
    swr = { data: info({ audio: [{ index: 1 }, { index: 2 }] }), error: undefined };
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());

    act(() => void screen.getByText(/^audio:Anglais/).click());

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0]).toContain("A_TRUEHD");
    // Et surtout : pas de reconstruction sur une piste que ce chemin refuserait. Le verdict était
    // connu d'avance.
    expect(remux.requestAudioTrack).not.toHaveBeenCalled();
    expect(probes).toHaveLength(1);
  });

  it("dit au repli où reprendre et sur quelle piste", async () => {
    swr = { data: info({ audio: [{ index: 1 }, { index: 2 }] }), error: undefined };
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    await act(async () => void fireEvent(videoElement(2400), new Event("timeupdate")));

    act(() => void screen.getByText(/^audio:Anglais/).click());

    // La position courante, pas celle de l'ouverture : le spectateur est à quarante minutes.
    // Et l'index Jellyfin de la piste demandée, pas le numéro Matroska.
    expect(onFallback.mock.calls[0][1]).toEqual({ resumeAt: 2400, audioStreamIndex: 2 });
  });

  it("ne nomme aucune piste plutôt que d'en nommer une au hasard", async () => {
    // Les deux listes décrivent le même fichier ; si elles ne comptent pas le même nombre de
    // pistes, la correspondance par rang ne tient plus et un index calculé serait une invention.
    swr = { data: info({ audio: [{ index: 1 }] }), error: undefined };
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());

    act(() => void screen.getByText(/^audio:Anglais/).click());

    expect(onFallback.mock.calls[0][1].audioStreamIndex).toBeUndefined();
    // La position, elle, reste connue : c'est la piste seule qu'on renonce à nommer.
    expect(onFallback.mock.calls[0][1].resumeAt).toBe(0);
  });

  it("s'arrête en le disant là où il n'y a pas de lecteur serveur", async () => {
    // Sans personne à qui confier le fichier, le repli n'existe pas : la raison est la réponse.
    serverFallback = false;
    swr = { data: info({ audio: [{ index: 1 }, { index: 2 }] }), error: undefined };
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());

    act(() => void screen.getByText(/^audio:Anglais/).click());

    expect(onFallback).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/A_TRUEHD/)).toBeTruthy());
  });

  it("laisse passer sans rien déranger une piste que le chemin porte", async () => {
    swr = { data: info({ audio: [{ index: 1 }, { index: 2 }] }), error: undefined };
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Français/)).toBeTruthy());

    act(() => void screen.getByText(/^audio:Français/).click());

    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe("le chemin choisi", () => {
  it("monte le remultiplexage et publie ses pistes", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("controls")).toBeTruthy());
    expect(screen.getByText(/^audio:Français/)).toBeTruthy();
    expect(screen.getByText(/^st:Français — full/)).toBeTruthy();
  });

  it("fait passer un MP4 par le même traitement qu'un Matroska, menus compris", async () => {
    // Il était remis tel quel à l'élément : ni menu de pistes, ni langue du compte, ni
    // sous-titres intégrés, et un E-AC3 muet sur Chrome sans que rien ne le dise.
    swr = { data: info({ container: "mp4", streamUrl: "/film.mp4" }), error: undefined };
    mount();

    await waitFor(() => expect(screen.getByTestId("controls")).toBeTruthy());
    expect(probes[0]).toMatchObject({ streamUrl: "/film.mp4" });
    expect(screen.getByText(/^audio:Français/)).toBeTruthy();
    expect(screen.getByText(/^st:Français — full/)).toBeTruthy();
    // L'élément reçoit une MediaSource, jamais l'adresse du fichier.
    expect(document.querySelector("video")!.getAttribute("src")).not.toBe("/film.mp4");
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

  it("s'arrête en le disant là où il n'y a pas de lecteur serveur", async () => {
    // Le même refus que plus haut, sur une installation qui n'a personne à qui confier le
    // fichier : la raison ne part pas à un autre lecteur, elle s'affiche.
    serverFallback = false;
    swr = { data: info({ refusedReason: "conteneur avi" }), error: undefined };
    mount();

    await waitFor(() => expect(screen.getByText("unplayable")).toBeTruthy());
    expect(screen.getByText("conteneur avi")).toBeTruthy();
    expect(onFallback).not.toHaveBeenCalled();
    // Un bouton vers un lecteur qui n'existe pas mènerait à un écran vide.
    expect(screen.queryByText("player.experimental.switchToStable")).toBeNull();
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

    expect(screen.getByText("connectionLost")).toBeTruthy();
    // La phrase est traduite (le double de `useT` rend la fin de la clé) ; la position, elle, est
    // vérifiée par la reprise du test suivant.
    expect(screen.getByText(/resumeAt/)).toBeTruthy();
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
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /retry/ })));

    await waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[1].startSeconds).toBeCloseTo(3725, 1);
  });

  it("montre l'écran d'attente quand le fichier ne s'ouvre même pas, faute de réseau", async () => {
    // A file that could not be opened because there is no network is not a file this player
    // cannot play.
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    const offline = Object.assign(new Error("Failed to fetch"), { network: true });
    nextProbe = () => {
      throw offline;
    };
    // Faked from before the player exists, so the give-up timer below is one of the timers
    // being advanced rather than a real one left running beside them.
    vi.useFakeTimers();
    mount();
    await act(async () => {});

    expect(screen.getByText("connectionLost")).toBeTruthy();
    expect(onFallback).not.toHaveBeenCalled();

    // And it keeps waiting. The give-up timer had no idea the network was out, so an outage
    // lasting more than thirty-five seconds handed the film to the player that needs the very
    // same network — silently, and against the whole point of this screen.
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(onFallback).not.toHaveBeenCalled();
    expect(screen.getByText("connectionLost")).toBeTruthy();
    vi.useRealTimers();
  });

  it("repart tout seul quand le réseau revient, sans rien demander", async () => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    mount();
    await act(async () => {});
    act(() => probes[0].onError("plus de réseau", "network"));
    expect(screen.getByText("connectionLost")).toBeTruthy();

    Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
    act(() => void window.dispatchEvent(new Event("online")));
    expect(screen.getByText("connectionBack")).toBeTruthy();

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

  it("rend son budget de reconstructions quand la lecture a tenu entre-temps", async () => {
    // Three hiccups an hour apart are not the fault the limit exists to stop. Without a window,
    // a two-hour film exhausted the budget by accident and handed itself over mid-viewing.
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    remux.lost = true;

    for (let hiccup = 0; hiccup < 6; hiccup++) {
      act(() => probes[probes.length - 1].onError("morte"));
      await act(async () => {});
      // Time passes, and the film plays through all of it.
      vi.setSystemTime(Date.now() + 10 * 60_000);
    }

    expect(onFallback).not.toHaveBeenCalled();
    expect(probes.length).toBeGreaterThan(4);
    vi.useRealTimers();
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
    expect(onFallback).toHaveBeenCalledWith("morte", expect.anything());
  });

  it("confie au lecteur stable l'endroit du film et la piste, pas la position d'ouverture", async () => {
    // Relu le 22/09/2026 : seuls la diffusion et la piste impossible transmettaient un relais.
    // Un renoncement en cours de film — ici, une source perdue quatre fois — rouvrait le lecteur
    // stable au point d'ouverture de la séance : une heure de film rembobinée.
    swr = { data: info({ audio: [{ index: 1 }, { index: 2 }] }), error: undefined };
    mount({ resumeAt: 600 });
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    await act(async () => void fireEvent(videoElement(4200), new Event("timeupdate")));
    remux.lost = true;

    for (let attempt = 0; attempt < 4; attempt++) {
      const at = probes.length;
      act(() => probes[at - 1].onError("morte"));
      await act(async () => {});
    }
    const [reason, takeover] = onFallback.mock.calls[0];
    expect(reason).toBe("morte");
    // Là où le film en était — un peu au-delà, même : les reconstructions sautent le passage qui
    // venait d'échouer —, et jamais les 600 s de l'ouverture. Sur la piste qui jouait.
    expect(takeover.resumeAt).toBeGreaterThanOrEqual(4200);
    expect(takeover.resumeAt).toBeLessThan(4300);
    expect(takeover.audioStreamIndex).toBe(1);
  });

  it("ne transmet rien quand rien n'a encore joué : la séance dit déjà où ouvrir", async () => {
    swr = { data: info({ refusedReason: "conteneur avi" }), error: undefined };
    serverFallback = true;
    mount({ resumeAt: 600 });
    await waitFor(() => expect(onFallback).toHaveBeenCalled());
    expect(onFallback.mock.calls[0]).toEqual(["conteneur avi"]);
  });
});

describe("ce que le spectateur avait choisi", () => {
  it("rend la piste audio choisie au pipeline reconstruit", async () => {
    // A pipeline built again knows nothing: it opens on the file's own default track, which
    // after a cut means coming back to a film in the wrong language.
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    const switched = rebuildOn(2);
    await act(async () => void fireEvent.click(screen.getByText(/^audio:Anglais/)));
    await waitFor(() => expect(probes).toHaveLength(2));

    rebuildOn(2);
    switched.lost = true;
    act(() => probes[1].onError("morte"));

    await waitFor(() => expect(probes).toHaveLength(3));
    expect(probes[2]).toMatchObject({ audioTrackNumber: 2 });
  });

  it("ne repasse pas au pipeline un numéro qui n'appartient pas au fichier", async () => {
    // An external subtitle's number means nothing to a pipeline reading the container; passing
    // it down would select a track that does not exist, or none at all.
    swr = {
      data: info({ externalSubtitles: [{ id: -1, language: "fra", title: "Français", url: "/sub.vtt" }] }),
      error: undefined,
    };
    stubFetch();
    mount();
    await waitFor(() => expect(screen.getByText(/^st:Français — full \(external\)/)).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText(/^st:Français — full \(external\)/)));

    const rebuilt = fakeRemux();
    nextProbe = () => ({ path: "remux", start: async () => rebuilt, discard: vi.fn() });
    remux.lost = true;
    act(() => probes[0].onError("morte"));

    await waitFor(() => expect(probes).toHaveLength(2));
    expect(rebuilt.selectSubtitleTrack).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

/**
 * Tout changement de piste reconstruit le lecteur à la même position, directement sur la piste
 * voulue — même format ou non. Le changement « dans le tampon », plus lent et source d'un décalage
 * durable du son sur WebKit, a été retiré le 22/09/2026.
 */
describe("changer de piste audio", () => {
  const logged = () =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === "/api/player/log")
      .map(([, init]) => JSON.parse((init as { body: string }).body) as { kind: string; fields: Record<string, unknown> });

  it("reconstruit le lecteur directement sur la piste choisie", async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());

    const rebuilt = rebuildOn(2);
    await act(async () => void fireEvent.click(screen.getByText(/^audio:Anglais/)));

    // Le pipeline suivant est demandé sur la piste choisie : il ouvre dessus.
    await waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[1]).toMatchObject({ audioTrackNumber: 2 });
    expect(remux.requestAudioTrack).toHaveBeenCalledWith(2);
    // Le nouveau a ouvert sur la bonne piste : il n'a rien à changer, donc rien à redemander.
    await waitFor(() => expect(remux.destroy).toHaveBeenCalled());
    expect(rebuilt.requestAudioTrack).not.toHaveBeenCalled();
    // Le compte rendu dit par où c'est passé.
    await waitFor(() =>
      expect(logged().some((e) => e.kind === "audio" && e.fields.via === "reconstruction" && e.fields.to === 2)).toBe(true)
    );
  });

  it("garde un film en pause en pause", async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalled());
    Object.defineProperty(HTMLMediaElement.prototype, "paused", { value: true, configurable: true });
    try {
      (HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>).mockClear();
      rebuildOn(2);
      await act(async () => void fireEvent.click(screen.getByText(/^audio:Anglais/)));
      await waitFor(() => expect(probes).toHaveLength(2));
      // Et la source l'apprend aussi : sans cela, sa garde de démarrage prenait l'élément à
      // l'arrêt pour un démarrage raté et relançait le film elle-même (iPhone, 21/09/2026).
      expect(probes[1]).toMatchObject({ startPaused: true, audioTrackNumber: 2 });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    } finally {
      delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>).paused;
    }
  });

  it("revient à la piste d'avant quand la nouvelle n'ouvre pas par le lecteur natif", async () => {
    // Relu le 22/09/2026 : module TrueHD injoignable, encodeur qui refuse — la reconstruction
    // tombait sur le canevas ou le lecteur serveur, et un film qui jouait était perdu pour un
    // choix de langue. Avant la livraison par piste, un changement raté laissait l'ancienne jouer.
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());

    const back = fakeRemux({ currentAudioTrack: 1 });
    let attempt = 0;
    nextProbe = () =>
      ++attempt === 1
        ? { path: "webcodecs", chosen: { path: "webcodecs", attempts: [] }, discard: vi.fn() }
        : { path: "remux", start: async () => back, discard: vi.fn() };
    await act(async () => void fireEvent.click(screen.getByText(/^audio:Anglais/)));

    await waitFor(() => expect(probes).toHaveLength(3));
    expect(probes[1]).toMatchObject({ audioTrackNumber: 2 });
    expect(probes[2]).toMatchObject({ audioTrackNumber: 1 });
    // Ni moteur canevas, ni lecteur serveur : le film continue sur la piste qui jouait.
    expect(engineInstances).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("audioTrackRefused")).toBeTruthy());
  });

  it("ne reconstruit rien quand le fichier refuse le changement, et le menu reste sur la piste qui joue", async () => {
    // Un fichier sans index, en cours de film : la reconstruction le reprendrait à zéro. Le refus
    // (et son avertissement) vient du pipeline ; ici, rien ne bouge et le journal le dit.
    remux.requestAudioTrack = vi.fn((_id: number): "rebuild" | "refused" | null => "refused");
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText(/^audio:Anglais/)));

    expect(remux.requestAudioTrack).toHaveBeenCalledWith(2);
    expect(probes).toHaveLength(1);
    expect(remux.destroy).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(logged().some((e) => e.kind === "audio" && e.fields.via === "refus" && e.fields.applied === false)).toBe(true)
    );
  });
});

describe("réduire le lecteur", () => {
  it("ne reconstruit rien, et ne renvoie pas le film à son point de départ", async () => {
    // Minimising redraws the component above, which handed down a new callback every time it
    // drew. The pipeline is built by an effect that depended on that callback, so the film was
    // torn down and opened again — at the position it had been started from, since a rebuild
    // nobody asked for carries no position of its own. Both halves are fixed; both are checked.
    const { rerender } = render(player({ resumeAt: 300 }));
    await waitFor(() => expect(probes).toHaveLength(1));

    await act(async () => void fireEvent(videoElement(1500), new Event("timeupdate")));
    await act(async () => void rerender(player({ resumeAt: 300, mode: "mini" })));
    await act(async () => void rerender(player({ resumeAt: 300, mode: "full" })));

    expect(probes).toHaveLength(1);
    expect(remux.destroy).not.toHaveBeenCalled();
  });

  it("une source perdue qui ne sait plus où elle était reprend là où le film en est", async () => {
    // The position of last resort, and the one the fix above leans on: what the element itself
    // last reported, never the position the film was opened at.
    mount({ resumeAt: 300 });
    await waitFor(() => expect(probes).toHaveLength(1));
    expect(probes[0].startSeconds).toBe(300);

    await act(async () => void fireEvent(videoElement(1500), new Event("timeupdate")));
    remux.lost = true;
    remux.position = 0; // nothing to say about where it was
    act(() => probes[0].onError("morte"));

    await waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[1].startSeconds).toBeCloseTo(1500, 1);
  });
});

describe("les préférences du compte Jellyfin", () => {
  const preferences = {
    audioLanguage: "fra",
    subtitleLanguage: "fra",
    subtitleMode: "OnlyForced",
    playDefaultAudioTrack: false,
  };

  it("ouvre sur la piste que le compte demande, malgré deux écritures différentes", async () => {
    // The container says `fre`, the account says `fra`. Compared as strings they never match,
    // and this whole feature would silently do nothing.
    viewerState = { resumeSeconds: 0, preferences };
    remux = fakeRemux({ currentAudioTrack: 2 }); // opens on English
    const rebuilt = fakeRemux({ currentAudioTrack: 1 });
    nextProbe = () => ({ path: "remux", start: async () => (probes.length === 1 ? remux : rebuilt), discard: vi.fn() });
    mount();
    await waitFor(() => expect(remux.requestAudioTrack).toHaveBeenCalledWith(1));
    // Rouvert sur elle, comme tout changement de piste.
    await waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[1]).toMatchObject({ audioTrackNumber: 1 });
  });

  it("ne touche à rien quand la langue demandée n'est pas là", async () => {
    // Being handed the only other track is being given a film in a language nobody asked for.
    viewerState = { resumeSeconds: 0, preferences: { ...preferences, audioLanguage: "jpn" } };
    mount();
    await waitFor(() => expect(screen.getByTestId("controls")).toBeTruthy());
    expect(remux.requestAudioTrack).not.toHaveBeenCalled();
  });

  it("laisse le choix du spectateur l'emporter sur une reconstruction", async () => {
    // Coming back from a network cut must give back what *they* picked, not what their account
    // would have picked.
    viewerState = { resumeSeconds: 0, preferences };
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    const switched = rebuildOn(2);
    await act(async () => void fireEvent.click(screen.getByText(/^audio:Anglais/)));
    await waitFor(() => expect(probes).toHaveLength(2));

    const rebuilt = rebuildOn(2);
    switched.lost = true;
    act(() => probes[1].onError("morte"));
    await waitFor(() => expect(probes).toHaveLength(3));
    expect(probes[2]).toMatchObject({ audioTrackNumber: 2 });
    // Rouvert sur la piste du spectateur, le nouveau pipeline n'a rien à changer — et surtout pas
    // à revenir à celle du compte.
    await waitFor(() => expect(switched.destroy).toHaveBeenCalled());
    expect(rebuilt.requestAudioTrack).not.toHaveBeenCalled();
  });

  it("peut satisfaire une préférence de sous-titres avec un fichier posé à côté", async () => {
    // Un fichier sans sous-titre intégré : celui d'à côté est le seul moyen d'en avoir.
    stubFetch();
    remux = fakeRemux({ subtitleTracks: [] });
    swr = {
      data: info({
        container: "mp4",
        externalSubtitles: [{ id: -1, language: "fra", title: "Français", url: "/sub.vtt" }],
      }),
      error: undefined,
    };
    // « Always » : le son est déjà en français, et « Default » ne montrerait alors que les forcés.
    viewerState = { resumeSeconds: 0, preferences: { ...preferences, subtitleMode: "Always" } };
    mount();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/sub.vtt", expect.anything()));
    vi.unstubAllGlobals();
  });

  it("se passe très bien de préférences quand le serveur n'en donne pas", async () => {
    viewerState = { resumeSeconds: 0, preferences: null };
    mount();
    await waitFor(() => expect(screen.getByTestId("controls")).toBeTruthy());
    expect(remux.requestAudioTrack).not.toHaveBeenCalled();
  });
});

describe("un autre film", () => {
  it("repart de rien, sans traîner ce que le précédent avait choisi", async () => {
    // Advancing to the next episode remounts this player, so everything it accumulated is gone
    // with it. That only holds while none of that state lives outside the component: a module
    // level variable would survive the remount and carry a track number — which on another file
    // may well be another language — straight into the next episode.
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    rebuildOn(2);
    await act(async () => void fireEvent.click(screen.getByText(/^audio:Anglais/)));
    await waitFor(() => expect(probes).toHaveLength(2));
    cleanup();

    const next = fakeRemux({ currentAudioTrack: 1 });
    nextProbe = () => ({ path: "remux", start: async () => next, discard: vi.fn() });
    mount({ itemId: "item-2" });
    await waitFor(() => expect(screen.getByTestId("controls")).toBeTruthy());

    expect(next.requestAudioTrack).not.toHaveBeenCalled();
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
    await waitFor(() => expect(screen.getByText(/^st:Français — full \(track\)/)).toBeTruthy());
    expect(screen.getByText(/^st:Français — full \(external\)/)).toBeTruthy();
  });

  it("éteint la piste du conteneur et affiche le fichier, à la bonne seconde", async () => {
    withExternal();
    stubFetch(() => ({ ok: true, text: async () => "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nBonjour." }));
    mount();
    await waitFor(() => expect(screen.getByText(/^st:Français — full \(external\)/)).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText(/^st:Français — full \(external\)/)));

    // Two sources writing the same line would race; the container's is turned off first.
    expect(remux.selectSubtitleTrack).toHaveBeenCalledWith(null);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/sub.vtt", expect.anything()));

    await act(async () => void fireEvent(videoElement(2), new Event("timeupdate")));
    await waitFor(() => expect(screen.getByText("Bonjour.")).toBeTruthy());
    vi.unstubAllGlobals();
  });

  it("le dit sans rien casser quand le fichier ne vient pas", async () => {
    withExternal();
    stubFetch(() => ({ ok: false, status: 404 }));
    mount();
    await waitFor(() => expect(screen.getByText(/^st:Français — full \(external\)/)).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText(/^st:Français — full \(external\)/)));

    await waitFor(() => expect(screen.getByText("externalSubtitlesUnavailable")).toBeTruthy());
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
    stubFetch(() => ({ ok: true, text: async () => "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nDu fichier." }));
    nextProbe = () => ({ path: "webcodecs", chosen: {}, discard: vi.fn() });
    mount();
    await waitFor(() => expect(screen.getByText(/^st:Français — full/)).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText(/^st:Français — full/)));
    await waitFor(() => expect(fetch).toHaveBeenCalled());

    emit("subtitle", "Du conteneur.");
    expect(screen.queryByText("Du conteneur.")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("retire un avertissement tout seul, parce qu'il ne décrivait qu'un instant", async () => {
    // Measured on a real file: a seek recovered by the second route left "cette position est
    // impossible à atteindre" on screen for the rest of the film, while the film played.
    vi.useFakeTimers();
    mount();
    await act(async () => {});
    act(() => probes[0].onWarning({ code: "noIndexSeek" }));
    expect(screen.getByText("noIndexSeek")).toBeTruthy();

    await act(async () => void vi.advanceTimersByTime(6100));
    expect(screen.queryByText("noIndexSeek")).toBeNull();
    vi.useRealTimers();
  });

  it("réaffiche le même avertissement s'il se reproduit plus tard", async () => {
    // Held as a bare string, a repeat of the same sentence changed nothing and re-armed nothing,
    // so a problem that came back stayed invisible.
    vi.useFakeTimers();
    mount();
    await act(async () => {});
    act(() => probes[0].onWarning({ code: "audioInterrupted" }));
    await act(async () => void vi.advanceTimersByTime(6100));
    expect(screen.queryByText("audioInterrupted")).toBeNull();

    act(() => probes[0].onWarning({ code: "audioInterrupted" }));
    expect(screen.getByText("audioInterrupted")).toBeTruthy();
    vi.useRealTimers();
  });

  it("reconstruit un moteur qui s'arrête en cours de film, au lieu de céder la main", async () => {
    // The rebuild machinery is the same one the native path uses for a lost source; it was
    // simply never wired to this one. A decoder the platform took away mid-film says nothing
    // about the file.
    nextProbe = () => ({ path: "webcodecs", chosen: {}, discard: vi.fn() });
    mount();
    await waitFor(() => expect(screen.getByTestId("controls")).toBeTruthy());
    emit("playing"); // the picture is actually running

    emit("error", "Le contexte graphique a été perdu.");
    await waitFor(() => expect(probes).toHaveLength(2));
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("ne s'acharne pas sur un fichier que l'appareil ne sait pas décoder", async () => {
    // That one fails on the way up, and retrying it is three spinners and the same answer.
    nextProbe = () => ({ path: "webcodecs", chosen: {}, discard: vi.fn() });
    mount();
    await waitFor(() => expect(screen.getByTestId("controls")).toBeTruthy());

    emit("error", "Aucun décodeur disponible pour l'audio DTS.");
    await waitFor(() => expect(onFallback).toHaveBeenCalledWith("Aucun décodeur disponible pour l'audio DTS.", expect.anything()));
    expect(probes).toHaveLength(1);
  });

  it("distingue un avertissement, qui laisse jouer, d'une erreur, qui arrête", async () => {
    nextProbe = () => ({ path: "webcodecs", chosen: {}, discard: vi.fn() });
    mount();
    await waitFor(() => expect(screen.getByTestId("controls")).toBeTruthy());

    emit("warning", { code: "noSound", detail: "0 bloc décodé" });
    expect(screen.getByText("noSound")).toBeTruthy();
    expect(onFallback).not.toHaveBeenCalled();

    // Nothing has played yet, so this one is answered by handing the file over rather than by
    // trying the same thing again.
    emit("error", "décodage impossible");
    expect(onFallback).toHaveBeenCalledWith("décodage impossible", expect.anything());
  });
});

describe("la fin d'une séance, au journal", () => {
  // Le type `stop` existait et rien ne l'envoyait : au 21/09, 444 `start` et pas un `stop`. Un
  // film vu jusqu'au bout et un film abandonné laissaient la même trace — c'est-à-dire aucune.
  const logged = (kind: string) =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === "/api/player/log")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
      .filter((entry) => entry.kind === kind);

  it("écrit une ligne quand le lecteur s'en va, avec le chemin et la position", async () => {
    const { unmount } = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const element = videoElement(1200);
    act(() => void element.dispatchEvent(new Event("timeupdate")));

    unmount();

    const stops = logged("stop");
    expect(stops).toHaveLength(1);
    expect(stops[0].fields).toMatchObject({ why: "unmount", path: "remux", ended: false, itemId: "item-1" });
    expect(stops[0].fields.gaveUpAfterMs).toBeUndefined();
  });

  it("dit l'accord du son et de l'image : horloges du son ré-encodé et images sautées", async () => {
    // 22/09/2026 : sur Chrome Android, le son se décalait peu à peu et un saut le recalait —
    // sans aucune trace nulle part. La ligne de fin de séance porte maintenant de quoi trancher.
    remux = fakeRemux({ audioTiming: () => ({ sourceMs: 40, encoderMs: 0 }) });
    const { unmount } = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const element = videoElement(600);
    Object.assign(element, { getVideoPlaybackQuality: () => ({ totalVideoFrames: 14400, droppedVideoFrames: 12 }) });

    unmount();

    expect(logged("stop")[0].fields).toMatchObject({
      audioSync: { sourceMs: 40, encoderMs: 0 },
      frames: { total: 14400, dropped: 12 },
    });
  });

  it("n'en écrit qu'une, quand la page s'en va avant le lecteur", async () => {
    const { unmount } = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));

    act(() => void window.dispatchEvent(new Event("pagehide")));
    unmount();

    const stops = logged("stop");
    expect(stops).toHaveLength(1);
    expect(stops[0].fields.why).toBe("page");
  });

  it("dit combien de temps on a attendu quand on renonce avant la première image", async () => {
    nextProbe = () => new Promise(() => {}) as never; // n'aboutit jamais
    const { unmount } = mount();
    await settle();

    unmount();

    const stops = logged("stop");
    expect(stops).toHaveLength(1);
    expect(typeof stops[0].fields.gaveUpAfterMs).toBe("number");
  });

  it("se tait après un repli, que la ligne `fallback` a déjà raconté", async () => {
    serverFallback = true;
    swr = { data: info({ refusedReason: "conteneur avi" }), error: undefined };
    const { unmount } = mount();
    await waitFor(() => expect(onFallback).toHaveBeenCalledWith("conteneur avi"));

    unmount();

    expect(logged("fallback")).toHaveLength(1);
    expect(logged("stop")).toHaveLength(0);
  });
});

describe("le canevas ouvre sur la bonne piste", () => {
  // Il ouvrait toujours sur la piste par défaut du fichier, et l'écran basculait ensuite vers celle
  // du compte — la bascule que le chemin remultiplexé avait supprimée le 20/09. L'hôte lui passe
  // maintenant la même règle que son écran.
  const tracks = [
    { number: 1, codecId: "A_AAC", language: "eng", name: null, isDefault: true, isForced: false, channels: 2 },
    { number: 2, codecId: "A_AAC", language: "fre", name: null, isDefault: false, isForced: false, channels: 2 },
    { number: 3, codecId: "A_AC3", language: "fre", name: null, isDefault: false, isForced: false, channels: 6 },
  ];
  const chooser = () =>
    (engineInstances[0].load.mock.calls[0][1] as { chooseAudioTrack: (t: typeof tracks) => number | null }).chooseAudioTrack;

  beforeEach(() => {
    nextProbe = () => ({ path: "webcodecs", chosen: {}, discard: vi.fn() });
  });

  it("choisit la langue du compte, et la plus riche des pistes de cette langue", async () => {
    viewerState = {
      resumeSeconds: 0,
      preferences: { audioLanguage: "fra", subtitleLanguage: null, subtitleMode: "Default", playDefaultAudioTrack: false },
    };
    mount();
    await waitFor(() => expect(engineInstances[0]?.load).toHaveBeenCalled());
    expect(chooser()(tracks)).toBe(3);
  });

  it("laisse la règle du fichier sans préférence", async () => {
    viewerState = { resumeSeconds: 0, preferences: null };
    mount();
    await waitFor(() => expect(engineInstances[0]?.load).toHaveBeenCalled());
    expect(chooser()(tracks)).toBeNull();
  });
});

describe("relu le 22/09/2026", () => {
  it("rouvre le moteur canevas reconstruit sur la piste et les sous-titres choisis", async () => {
    // Le menu restait sur le choix du spectateur, le film revenait sur la piste du compte et sans
    // ses sous-titres : le chemin canevas ne retenait pas le choix audio, et ne redonnait pas les
    // sous-titres du conteneur au nouveau moteur.
    engineAudio = [
      { number: 1, codecId: "A_AAC", language: "fre", name: null, isDefault: true, isForced: false },
      { number: 2, codecId: "A_AAC", language: "eng", name: null, isDefault: false, isForced: false },
    ];
    engineSubtitles = [{ number: 5, codecId: "S_TEXT/UTF8", language: "fre", name: null, isDefault: false, isForced: false }];
    nextProbe = () => ({ path: "webcodecs", chosen: {}, discard: vi.fn() });
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    emit("playing");
    await act(async () => void fireEvent.click(screen.getByText(/^audio:Anglais/)));
    await act(async () => void fireEvent.click(screen.getByText(/^st:Français/)));

    emit("error", "Le contexte graphique a été perdu.");
    await waitFor(() => expect(engineInstances[1]?.load).toHaveBeenCalled());
    const options = engineInstances[1].load.mock.calls[0][1] as { chooseAudioTrack: (t: unknown[]) => number | null };
    expect(options.chooseAudioTrack(engineAudio)).toBe(2);
    await waitFor(() =>
      expect((engineInstances[1] as unknown as { setSubtitleTrack: ReturnType<typeof vi.fn> }).setSubtitleTrack).toHaveBeenCalledWith(5)
    );
  });

  it("garde la même séance Jellyfin à travers une reconstruction", async () => {
    // Chaque reconstruction — un geste ordinaire depuis la livraison par piste — clôturait la
    // séance chez Jellyfin puis en annonçait une nouvelle.
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const before = announcedSessions.length;
    remux.lost = true;
    act(() => probes[0].onError("morte"));
    await waitFor(() => expect(probes).toHaveLength(2));
    expect(announcedSessions.slice(before).every((session) => session !== null)).toBe(true);
  });

  it("« Revoir » rejoue le film sur le chemin canevas", async () => {
    nextProbe = () => ({ path: "webcodecs", chosen: {}, discard: vi.fn() });
    mount();
    await waitFor(() => expect(screen.getByTestId("controls")).toBeTruthy());
    emit("playing");
    emit("ended");
    const engine = engineInstances[0] as unknown as { play: ReturnType<typeof vi.fn> };
    engine.play.mockClear();
    facadeSeeks.length = 0;

    await act(async () => void fireEvent.click(screen.getByText("revoir")));

    expect(facadeSeeks).toEqual([0]);
    expect(engine.play).toHaveBeenCalled();
  });

  it("espace ses relances quand le réseau est là mais que le serveur ne répond pas", async () => {
    // Pendant un redéploiement, « en ligne » était vrai et le lecteur relançait toutes les 0,8 s.
    vi.useFakeTimers();
    const unreachable = Object.assign(new Error("Load failed"), { network: true });
    nextProbe = () => {
      throw unreachable;
    };
    mount();
    await act(async () => {});
    expect(probes).toHaveLength(1);

    await act(async () => void vi.advanceTimersByTime(900)); // 0,8 s
    expect(probes).toHaveLength(2);
    await act(async () => void vi.advanceTimersByTime(900)); // la suivante attend 1,6 s
    expect(probes).toHaveLength(2);
    await act(async () => void vi.advanceTimersByTime(800));
    expect(probes).toHaveLength(3);
    vi.useRealTimers();
  });

  it("ne laisse pas « Analyse du fichier… » transparaître sous l'écran de coupure", async () => {
    // Vu sur iPhone le 21/09/2026, en mode avion : le cercle et le mot de l'ouverture restaient
    // dessinés sous le voile de « Connexion perdue ».
    vi.useFakeTimers();
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    const offline = Object.assign(new Error("Load failed"), { network: true });
    nextProbe = () => {
      throw offline;
    };
    mount();
    await act(async () => {});
    await act(async () => void vi.advanceTimersByTime(8000));
    expect(screen.getByText("connectionLost")).toBeTruthy();
    expect(screen.queryByText("loading")).toBeNull();
    expect(screen.queryByText("stillWorking")).toBeNull();
    vi.useRealTimers();
  });

  it("dit un avertissement du pipeline dans la langue du spectateur, sans son détail technique", async () => {
    // Relevé le 21/09/2026 : le pipeline écrivait ses avertissements en français, et un compte
    // en anglais les lisait tels quels. Il envoie maintenant un code ; le détail part au journal.
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    act(() => probes[0].onWarning({ code: "audioTrackRefused", detail: "InternalAudioEncoderCocoa encoding failed" }));
    expect(screen.getByText("audioTrackRefused")).toBeTruthy();
    expect(screen.queryByText(/InternalAudioEncoderCocoa/)).toBeNull();
  });

  it("ignore ce qui n'est pas un avertissement connu", async () => {
    nextProbe = () => ({ path: "webcodecs", chosen: {}, discard: vi.fn() });
    mount();
    await waitFor(() => expect(screen.getByTestId("controls")).toBeTruthy());
    emit("warning", "une phrase nue d'une ancienne version");
    expect(screen.queryByText(/phrase nue/)).toBeNull();
  });

  it("un changement de piste pendant un saut encore en chargement rouvre à la position du saut", async () => {
    // 22/09/2026 : à 2 min, saut à 10 min, et changement de piste pendant le chargement — la
    // reconstruction repartait de la dernière position lue, 2 min. Un geste sur deux était perdu.
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    await act(async () => void fireEvent(videoElement(120), new Event("timeupdate")));

    // Le saut est demandé ; l'élément n'y est pas encore (pas de `seeked`, pas de timeupdate).
    await act(async () => void fireEvent.click(screen.getByText("saut:600")));
    rebuildOn(2);
    await act(async () => void fireEvent.click(screen.getByText(/^audio:Anglais/)));

    await waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[1].startSeconds).toBeCloseTo(600, 1);
  });

  it("écrit chaque saut au journal : d'où, vers où, déjà chargé ou non, et combien de temps", async () => {
    // 22/09/2026 : des sauts jugés lents sur un réseau d'entreprise, et aucun chiffre pour dire
    // si c'était le réseau ou le lecteur.
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const element = videoElement(120);
    await act(async () => void fireEvent(element, new Event("timeupdate")));
    await act(async () => void fireEvent.click(screen.getByText("saut:600")));
    element.currentTime = 600;
    await act(async () => void fireEvent(element, new Event("seeked")));

    const seeks = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === "/api/player/log")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
      .filter((entry) => entry.kind === "seek");
    expect(seeks).toHaveLength(1);
    expect(seeks[0].fields).toMatchObject({ from: 120, to: 600, buffered: false, path: "remux" });
    expect(typeof seeks[0].fields.tookMs).toBe("number");
  });

  it("garde les commandes pendant une reconstruction, estompées et sans clavier", async () => {
    // 22/09/2026 : elles disparaissaient puis réapparaissaient d'un coup à chaque changement de
    // piste. Elles restent là, s'effacent, et ne répondent plus le temps de la reconstruction.
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ drawImage: vi.fn() })) as never;
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    const element = videoElement(120);
    Object.defineProperty(element, "readyState", { value: 4, configurable: true });
    Object.defineProperty(element, "videoWidth", { value: 1920, configurable: true });
    Object.defineProperty(element, "videoHeight", { value: 1080, configurable: true });

    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const rebuilt = fakeRemux({ currentAudioTrack: 2 });
    nextProbe = () => ({ path: "remux", start: async () => (await gate, rebuilt), discard: vi.fn() });
    await act(async () => void fireEvent.click(screen.getByText(/^audio:Anglais/)));
    await waitFor(() => expect(probes).toHaveLength(2));

    // Pendant la reconstruction : toujours là, mais suspendues.
    expect(screen.getByTestId("controls").dataset.suspended).toBe("true");
    await act(async () => void open());
    await waitFor(() => expect(screen.getByTestId("controls").dataset.suspended).toBe("false"));
  });
});

