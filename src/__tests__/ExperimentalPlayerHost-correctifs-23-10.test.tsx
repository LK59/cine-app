// @vitest-environment jsdom
// Hôte natif — les dérives relevées par l'audit des fusions du 23/10/2026 (DECISIONS.md §116),
// chacune prouvée par un test qui échouait avant son correctif. Harnais de
// ExperimentalPlayerHost-cycle.test.tsx, repris tel quel : tout ce qui est sous l'hôte est simulé, et
// ce qu'on lit est ce que l'hôte produit — lignes envoyées au journal, trace, DOM.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, act, waitFor, fireEvent } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({
  // Le dernier segment de la clé : les étiquettes de pistes en deviennent lisibles.
  useT: () => (key: string) => key.split(".").pop() ?? key,
  useLocale: () => ({ locale: "fr", setLocale: () => {} }),
}));
vi.mock("@/lib/useViewportResizing", () => ({ useViewportResizing: () => false }));

/**
 * Le fil de ce qui arrive, dans l'ordre : la trace locale (`trace:…`), les lignes du journal
 * (`log:<kind>`) et l'arrêt chez Jellyfin (`jellyfin:stop`). C'est l'ordre qu'on examine.
 */
const events = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/webcodecs/trace", () => ({
  trace: (message: string) => void events.push(`trace:${message}`),
  traceKeepAcrossReset: () => {},
  traceRecent: () => [],
}));
vi.mock("@/lib/webcodecs/pathSelector", () => ({ NATIVE_PATH: "raison du choix" }));
vi.mock("@/lib/webcodecs/capabilities", () => ({ probeCapabilities: async () => ({}), describeCapabilities: () => ({}) }));
vi.mock("@/components/ExperimentalPlayerReport", () => ({ ExperimentalPlayerReport: () => <div data-testid="report" /> }));
vi.mock("@/components/MiniPlayer", () => ({
  MiniPlayerChrome: () => <div data-testid="mini" />,
  useMiniPlayerDrag: () => ({ pos: { x: 0, y: 0 }, size: { width: 1, height: 1 }, isDragging: false, handlers: {} }),
}));

/**
 * L'arrêt chez Jellyfin, tel que `usePlaybackSession` l'envoie : au nettoyage d'un effet posé à la
 * place où l'hôte appelle le hook. Le double garde cette place — c'est elle qu'on examine au démontage.
 */
const stopPlaybackNow = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/usePlaybackSession", async () => {
  const React = await import("react");
  return {
    usePlaybackSession: () => {
      React.useEffect(() => () => void events.push("jellyfin:stop"), []);
      return { stop: stopPlaybackNow, reportNow: () => {}, resume: vi.fn(), savePaused: vi.fn() };
    },
  };
});
vi.mock("@/components/player/PlayerEndScreen", () => ({ PlayerEndScreen: () => null }));

const advance = vi.hoisted(() => vi.fn());
const close = vi.hoisted(() => vi.fn());
vi.mock("@/components/PlaybackProvider", () => ({
  usePlayback: () => ({ close, minimize: vi.fn(), expand: vi.fn(), advance, session: null }),
}));

// Les commandes, réduites à ce que l'hôte leur donne et qu'on actionne ici.
vi.mock("@/components/PlayerControls", () => ({
  VOLUME_STORAGE_KEY: "cine:player-volume",
  PlayerControls: (props: {
    loading: boolean;
    subtitleTracks: { id: number; label: string }[];
    currentSubtitleId?: number | null;
    onChangeSubtitle: (id: number | null) => void;
    subtitleOffset?: { seconds: number; onShift: (delta: number) => void };
    secondSubtitle?: { currentId: number | null; onChange: (id: number | null) => void };
    onClose?: () => void;
    onAdvance: () => void;
    onPlayEpisode?: (episode: { itemId: string; title: string; resumeAt: number }) => void;
  }) => (
    <div
      data-testid="controls"
      data-loading={String(props.loading)}
      data-current-subtitle={String(props.currentSubtitleId ?? "")}
      data-current-second={String(props.secondSubtitle?.currentId ?? "")}
    >
      {props.onClose && <button onClick={props.onClose}>fermer</button>}
      <button onClick={props.onAdvance}>suivant</button>
      {props.onPlayEpisode && (
        <>
          <button onClick={() => props.onPlayEpisode!({ itemId: "ep-5", title: "Épisode 5", resumeAt: 300 })}>épisode:5</button>
          <button onClick={() => props.onPlayEpisode!({ itemId: "ep-1", title: "Épisode 1", resumeAt: 0 })}>épisode:courant</button>
        </>
      )}
      {props.subtitleTracks.map((track) => (
        <button key={track.id} onClick={() => props.onChangeSubtitle(track.id)}>{`st:${track.label}`}</button>
      ))}
      <button onClick={() => props.onChangeSubtitle(null)}>st:aucun</button>
      {props.subtitleOffset && (
        <button onClick={() => props.subtitleOffset!.onShift(0.5)}>{`décalage:${props.subtitleOffset.seconds}`}</button>
      )}
      {props.secondSubtitle &&
        props.subtitleTracks.map((track) => (
          <button key={`2:${track.id}`} onClick={() => props.secondSubtitle!.onChange(track.id)}>{`st2:${track.label}`}</button>
        ))}
    </div>
  ),
}));

type Info = Record<string, unknown>;
let swr: { data: Info | undefined; error: unknown };
vi.mock("swr", () => ({ default: (key: unknown) => (key === "/api/auth/me" ? { data: undefined, error: undefined } : swr) }));
vi.mock("@/lib/swr", async (original) => ({
  ...(await original<typeof import("@/lib/swr")>()),
  refreshAfterPlayback: vi.fn(async () => {}),
}));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));
vi.mock("@/lib/webcodecs/memoryReserve", () => ({ reservePlanFacts: () => ({}), MemoryReserve: { start: () => ({ stop: vi.fn(() => ({})) }) } }));
vi.mock("@/lib/resumeCache/keepOnStop", () => ({ keepOnStop: vi.fn(async () => 0) }));

type Probe = { startSeconds: number; onError: (message: string) => void };
let probes: Probe[] = [];
let nextProbe: () => unknown;

function fakeRemux(over: Record<string, unknown> = {}) {
  return {
    audioTracks: [{ number: 1, codecId: "A_AAC", language: "fre", name: null, isDefault: true, isForced: false }],
    subtitleTracks: [
      { number: 5, codecId: "S_TEXT/UTF8", language: "fre", name: null, isDefault: false, isForced: false },
      { number: 6, codecId: "S_TEXT/UTF8", language: "eng", name: null, isDefault: false, isForced: false },
    ],
    currentAudioTrack: 1,
    canCarryAudio: vi.fn(() => true),
    requestAudioTrack: vi.fn(() => null),
    selectSubtitleTrack: vi.fn(),
    // Le principal (pas de piste donnée) dit « Ligne du fichier. », le second (piste 6) « Line. ».
    subtitleAt: vi.fn((_at: number, track?: number) => (track === 6 ? "Line." : track === undefined ? "Ligne du fichier." : null)),
    diagnostics: {},
    destroy: vi.fn(),
    lost: false,
    lossReport: vi.fn(() => ({})),
    position: 0,
    ...over,
  };
}
let remux: ReturnType<typeof fakeRemux>;
/** Une reconstruction ouvre un pipeline neuf (une source ouverte), pas celui qui vient de se perdre. */
function rebuildsOnFreshSource() {
  let first = true;
  nextProbe = () => {
    const opened = first ? remux : fakeRemux();
    first = false;
    return { path: "remux", start: async () => opened, discard: vi.fn() };
  };
}
vi.mock("@/lib/webcodecs/remuxPlayback", () => ({
  probePlaybackPath: vi.fn(async (options: Probe) => {
    probes.push(options);
    return nextProbe();
  }),
}));

import { noteWatching } from "@/lib/resumeRewind";
import { ExperimentalPlayerHost } from "@/components/ExperimentalPlayerHost";

function info(over: Info = {}): Info {
  return {
    streamUrl: "/stream.mkv",
    container: "mkv",
    refusedReason: null,
    externalSubtitles: [],
    video: { codec: "hevc", width: 1920, height: 1080, bitDepth: 10, isHdr: false, rangeType: "SDR" },
    introSkip: null,
    creditsStart: null,
    ...over,
  };
}

/** Le `fetch` du harnais : l'état du spectateur, le journal (noté au fil), le reste au test. */
let rest: (url: string, init?: RequestInit) => unknown = () => ({ ok: true, text: async () => "" });
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.startsWith("/api/jellyfin/playback-state/")) {
        return { ok: true, json: async () => ({ resumeSeconds: 0, preferences: null }) };
      }
      if (url === "/api/player/log") {
        events.push(`log:${(JSON.parse(init!.body as string) as { kind: string }).kind}`);
        return { ok: true, json: async () => ({}) };
      }
      return rest(url, init);
    })
  );
}

const logged = (kind: string) =>
  (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter(([url]) => url === "/api/player/log")
    .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
    .filter((entry) => entry.kind === kind);

function mount(over: { itemId?: string; episodes?: boolean } = {}) {
  return render(
    <ExperimentalPlayerHost
      session={
        {
          itemId: over.itemId ?? "ep-1",
          title: "Épisode 1",
          resumeAt: 0,
          openId: 7,
          ...(over.episodes ? { getNextEpisode: () => ({ itemId: "ep-2", title: "Épisode 2" }) } : {}),
        } as never
      }
      mode="full"
      onFallback={() => {}}
    />
  );
}
const ready = () => waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));

function videoElement(at = 0) {
  const element = document.querySelector("video")!;
  Object.defineProperty(element, "currentTime", { value: at, writable: true, configurable: true });
  return element;
}
const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
};
const kept = () => Object.keys(localStorage).filter((k) => k.startsWith("cine:unsent-stop:"));

beforeEach(() => {
  vi.clearAllMocks();
  events.length = 0;
  localStorage.clear();
  // Joué récemment sur cet appareil : pas de recul de 5 s à l'ouverture.
  noteWatching("ep-1");
  probes = [];
  swr = { data: info(), error: undefined };
  rest = () => ({ ok: true, text: async () => "" });
  stubFetch();
  remux = fakeRemux();
  rebuildsOnFreshSource();
  Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
  HTMLMediaElement.prototype.play = vi.fn(async () => {});
  HTMLMediaElement.prototype.pause = vi.fn();
  HTMLMediaElement.prototype.load = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});


// ----------------------------------------------------------------------------------------------

/** La source se perd à `at` : le pipeline suivant est neuf. */
async function loseSourceAt(at: number) {
  const current = remux;
  current.lost = true;
  current.position = at;
  const rebuilt = fakeRemux();
  nextProbe = () => ({ path: "remux", start: async () => rebuilt, discard: vi.fn() });
  const count = probes.length;
  act(() => probes[count - 1].onError("la source est morte"));
  await waitFor(() => expect(probes).toHaveLength(count + 1));
  await ready();
  remux = rebuilt;
}
/** La lecture avance d'une position à l'autre, par pas d'une demi-seconde. */
async function playFrom(from: number, to: number) {
  for (let at = from; at <= to; at += 0.5) await act(async () => void fireEvent(videoElement(at), new Event("timeupdate")));
}

describe("le registre des tentatives entend la lecture du natif (F1-6, §67)", () => {
  // « Trois secondes jouées effacent les échecs » valait pour les deux lecteurs (§67), mais seul le
  // serveur nourrissait le registre (`notePosition`) : une reconstruction qui suivait des minutes de
  // lecture au même passage se comptait « tentative identique » au bilan.
  it("trois secondes jouées entre deux pertes au même passage : pas de tentative identique", async () => {
    mount();
    await ready();
    await playFrom(118, 120);
    await loseSourceAt(120);
    await playFrom(120, 125);
    await loseSourceAt(125);
    await act(async () => void fireEvent.click(screen.getByText("fermer")));
    await waitFor(() => expect(logged("stop")).toHaveLength(1));
    expect(events.filter((e) => e.startsWith("trace:tentative identique"))).toEqual([]);
    expect(logged("stop")[0].fields.identicalRetries).toBeUndefined();
  });

  it("sans lecture entre les deux, la tentative identique est toujours comptée", async () => {
    mount();
    await ready();
    await playFrom(118, 120);
    await loseSourceAt(120);
    await loseSourceAt(125);
    await act(async () => void fireEvent.click(screen.getByText("fermer")));
    await waitFor(() => expect(logged("stop")).toHaveLength(1));
    expect(logged("stop")[0].fields.identicalRetries).toBe(1);
  });
});

describe("« a renoncé » ne vaut que pour une séance qui n'a jamais joué (F1-4)", () => {
  // `gaveUpAfterMs` se lisait sur le `ready` du pipeline courant, que `restart` remet à faux : une
  // séance fermée pendant une reconstruction « avait renoncé depuis le montage » après avoir joué
  // une heure. Le serveur le lit sur l'image jouée dans la séance.
  // Les commandes sont masquées tant que rien ne joue : la séance se termine par le démontage, dont
  // le bilan (`stop "unmount"`) est construit par le même `stopFields` que celui de la croix.
  it("fermé pendant une reconstruction, après avoir joué : pas de gaveUpAfterMs", async () => {
    const { unmount } = mount();
    await ready();
    await playFrom(118, 120);
    remux.lost = true;
    remux.position = 120;
    // Le pipeline reconstruit ne s'ouvre jamais.
    nextProbe = () => ({ path: "remux", start: () => new Promise(() => {}), discard: vi.fn() });
    act(() => probes[0].onError("la source est morte"));
    await waitFor(() => expect(probes).toHaveLength(2));
    unmount();
    await waitFor(() => expect(logged("stop")).toHaveLength(1));
    expect(logged("stop")[0].fields.gaveUpAfterMs).toBeUndefined();
  });

  it("fermé avant la toute première image : gaveUpAfterMs", async () => {
    nextProbe = () => ({ path: "remux", start: () => new Promise(() => {}), discard: vi.fn() });
    const { unmount } = mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    unmount();
    await waitFor(() => expect(logged("stop")).toHaveLength(1));
    expect(typeof logged("stop")[0].fields.gaveUpAfterMs).toBe("number");
  });
});
