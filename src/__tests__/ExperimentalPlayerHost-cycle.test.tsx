// @vitest-environment jsdom
// Hôte natif — ce qu'un découpage en hooks (audit du lecteur, 22/10/2026, étapes 4 à 7) déplacerait
// et qu'aucun test ne tenait : l'ordre des trois écouteurs `visibilitychange` (la durée d'absence
// est calculée par le premier, lue par la reconstruction du second), la fin d'une séance par chacune
// de ses portes (une seule ligne `stop`, la bonne raison, la copie de secours effacée, plus rien
// ensuite), l'ordre du démontage (la ligne `stop` avant l'arrêt chez Jellyfin, avec sa chronologie),
// et les deux voies de sous-titres là où elles touchent au réseau (un fichier en vol, abandonné ou
// gardé à travers une reconstruction).
//
// Le harnais reprend celui de ExperimentalPlayerHost.test.tsx, réduit : tout ce qui est sous l'hôte
// est simulé, et ce qu'on lit est ce que l'hôte produit — lignes envoyées au journal, appels à ses
// voisins, DOM.
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
    // Rien de retenu au départ (`MseSource.openingHold`) : l'hôte lance aussitôt, comme avant.
    openingHold: vi.fn(() => null),
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

describe("arrière-plan puis retour : l'ordre des trois écouteurs", () => {
  /**
   * La durée d'absence d'une ligne `rebuild` est calculée par l'écouteur du bilan (`tally.shown`) et
   * lue par celui de la source perdue (`tally.lastBackgroundMs`). L'ordre tient parce que le premier
   * est inscrit au montage et ne se réinscrit jamais : réinscrit après le second, la ligne porterait
   * l'absence du retour d'avant (audit du lecteur, §2.6). Deux absences de durées différentes, et la
   * lecture qui démarre entre-temps, le disent.
   */
  it("deux absences : la reconstruction porte la durée de la seconde, et le bilan les compte toutes les deux", async () => {
    const { unmount } = mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    await ready();
    const element = videoElement(1200);
    // La lecture démarre : l'état « en lecture » change, après que la source perdue a posé son écouteur.
    await act(async () => void fireEvent(element, new Event("play")));
    let t = 5_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);

    act(() => setVisibility("hidden"));
    t += 90_000;
    act(() => setVisibility("visible"));
    t += 10_000;
    act(() => setVisibility("hidden"));
    t += 30_000;
    remux.lost = true;
    remux.position = 1200;
    act(() => setVisibility("visible"));

    await waitFor(() => expect(probes).toHaveLength(2), { timeout: 3000 });
    expect(logged("rebuild")).toHaveLength(1);
    expect(logged("rebuild")[0].fields).toMatchObject({ reason: "source fermée en arrière-plan", hiddenMs: 30_000 });

    unmount();
    expect(logged("stop")[0].fields).toMatchObject({ backgrounds: 2, backgroundMs: 120_000, backgroundRebuilds: 1 });
  });

  it("au retour : l'absence est notée d'abord, la reconstruction ensuite — au départ, la trace puis la copie exacte", async () => {
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    await ready();
    await act(async () => void fireEvent(videoElement(800), new Event("play")));
    let t = 5_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);

    events.length = 0;
    act(() => setVisibility("hidden"));
    // Au départ : la trace dit l'arrière-plan, et la copie de secours est déjà là, exacte, avec ce départ compté.
    expect(events.some((e) => e.startsWith("trace:arrière-plan —"))).toBe(true);
    expect(kept()).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(kept()[0])!).fields).toMatchObject({ why: "lost", backgrounds: 1 });

    t += 45_000;
    remux.lost = true;
    remux.position = 800;
    act(() => setVisibility("visible"));
    await waitFor(() => expect(probes).toHaveLength(2), { timeout: 3000 });

    const back = events.findIndex((e) => e.startsWith("trace:retour au premier plan après 45.0 s"));
    const rebuildLine = events.indexOf("log:rebuild");
    const restart = events.findIndex((e) => e.startsWith("trace:reprise : la plateforme a fermé la source"));
    expect(back).toBeGreaterThanOrEqual(0);
    expect(rebuildLine).toBeGreaterThan(back);
    expect(restart).toBeGreaterThan(rebuildLine);
  });

  it("relit la source 400 ms après le retour : une fermeture qu'iOS ne montre pas tout de suite reconstruit quand même", async () => {
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    await ready();
    let t = 5_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => t);
    act(() => setVisibility("hidden"));
    t += 60_000;
    act(() => setVisibility("visible"));
    // Au retour même, la source semble encore ouverte ; la fermeture se voit un instant après.
    expect(probes).toHaveLength(1);
    remux.lost = true;
    remux.position = 300;
    await waitFor(() => expect(probes).toHaveLength(2), { timeout: 3000 });
    expect(probes[1].startSeconds).toBeCloseTo(300, 1);
    expect(logged("rebuild")[0].fields).toMatchObject({ reason: "source fermée en arrière-plan", hiddenMs: 60_000 });
  });

  it("un retour ne reconstruit qu'une fois, même relu deux fois", async () => {
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    await ready();
    act(() => setVisibility("hidden"));
    remux.lost = true;
    remux.position = 300;
    act(() => setVisibility("visible"));
    await waitFor(() => expect(probes).toHaveLength(2), { timeout: 3000 });
    // La seconde lecture (400 ms) passe sur la source neuve.
    await act(async () => void (await new Promise((r) => setTimeout(r, 600))));
    expect(probes).toHaveLength(2);
    expect(logged("rebuild")).toHaveLength(1);
  });

  it("le lecteur fermé, un passage en arrière-plan n'écrit plus rien, et un retour ne reconstruit rien", async () => {
    const { unmount } = mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    await ready();
    unmount();
    expect(kept()).toHaveLength(0);
    const linesBefore = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    act(() => setVisibility("hidden"));
    remux.lost = true;
    act(() => setVisibility("visible"));
    await act(async () => void (await new Promise((r) => setTimeout(r, 600))));
    expect(kept()).toHaveLength(0);
    expect(probes).toHaveLength(1);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(linesBefore);
  });
});

describe("la fin d'une séance, par chacune de ses portes", () => {
  it("l'épisode suivant : une ligne `stop` « next », la copie de secours effacée tout de suite, rien de plus au démontage", async () => {
    const { unmount } = mount({ episodes: true });
    await ready();
    expect(kept()).toHaveLength(1);
    act(() => void fireEvent.click(screen.getByText("suivant")));
    expect(advance).toHaveBeenCalledWith({ itemId: "ep-2", title: "Épisode 2" });
    expect(stopPlaybackNow).toHaveBeenCalledTimes(1);
    expect(logged("stop").map((line) => line.fields.why)).toEqual(["next"]);
    expect(kept()).toHaveLength(0);

    // Un second appui (le décompte qui arrive à zéro) ne renvoie pas d'arrêt.
    act(() => void fireEvent.click(screen.getByText("suivant")));
    unmount();
    expect(logged("stop").map((line) => line.fields.why)).toEqual(["next"]);
    expect(kept()).toHaveLength(0);
  });

  it("un épisode choisi dans le menu : « next » aussi, l'épisode et sa position passés tels quels ; l'épisode en cours ne fait rien", async () => {
    const { unmount } = mount({ episodes: true });
    await ready();
    act(() => void fireEvent.click(screen.getByText("épisode:courant")));
    expect(advance).not.toHaveBeenCalled();
    expect(logged("stop")).toHaveLength(0);

    act(() => void fireEvent.click(screen.getByText("épisode:5")));
    expect(advance).toHaveBeenCalledWith({ itemId: "ep-5", title: "Épisode 5", resumeAt: 300 });
    expect(logged("stop").map((line) => line.fields.why)).toEqual(["next"]);
    unmount();
    expect(logged("stop")).toHaveLength(1);
  });

  it("sans épisode suivant, « suivant » ne ferme rien", async () => {
    const { unmount } = mount();
    await ready();
    act(() => void fireEvent.click(screen.getByText("suivant")));
    expect(advance).not.toHaveBeenCalled();
    expect(logged("stop")).toHaveLength(0);
    unmount();
    expect(logged("stop").map((line) => line.fields.why)).toEqual(["unmount"]);
  });

  it("la croix : la copie de secours part avec l'arrêt ; la page qui s'en va ou se cache ensuite n'écrit plus rien", async () => {
    const { unmount } = mount();
    await ready();
    act(() => void fireEvent.click(screen.getByText("fermer")));
    expect(logged("stop").map((line) => line.fields.why)).toEqual(["close"]);
    expect(kept()).toHaveLength(0);

    act(() => void window.dispatchEvent(new Event("pagehide")));
    act(() => setVisibility("hidden"));
    expect(kept()).toHaveLength(0);
    unmount();
    expect(logged("stop")).toHaveLength(1);
    expect(kept()).toHaveLength(0);
  });

  it("après le démontage, plus aucune ligne ni copie : les minuteurs de la séance meurent avec elle", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const { unmount } = mount();
    for (let i = 0; i < 50 && screen.queryByTestId("controls")?.dataset.loading !== "false"; i++) {
      await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
    }
    expect(screen.getByTestId("controls").dataset.loading).toBe("false");
    unmount();
    const sent = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    await act(async () => void (await vi.advanceTimersByTimeAsync(120_000)));
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sent);
    expect(Object.keys(localStorage).filter((k) => k.startsWith("cine:unsent-stop"))).toEqual([]);
  });

  /**
   * L'ordre du démontage (audit, §2.6) : la ligne `stop` part avant l'arrêt chez Jellyfin, et avant
   * que la chronologie et les mesures d'approvisionnement de la séance soient défaites — elle les porte.
   */
  it("au démontage : la ligne `stop` d'abord, avec sa chronologie et ses mesures ; l'arrêt chez Jellyfin ensuite", async () => {
    const { unmount } = mount();
    await ready();
    await act(async () => void fireEvent(videoElement(600), new Event("timeupdate")));
    events.length = 0;
    unmount();
    const stops = logged("stop");
    expect(stops).toHaveLength(1);
    expect(stops[0].fields.why).toBe("unmount");
    expect(typeof stops[0].fields.timeline).toBe("string");
    expect(stops[0].fields.diag).toMatchObject({ netMB: expect.any(Number) });
    expect(events.indexOf("log:stop")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("jellyfin:stop")).toBeGreaterThan(events.indexOf("log:stop"));
  });
});

describe("les sous-titres et le réseau", () => {
  const external = (over: Info = {}) =>
    (swr = { data: info({ externalSubtitles: [{ id: -1, language: "spa", title: null, url: "/es.vtt" }], ...over }), error: undefined });
  const controls = () => screen.getByTestId("controls").dataset;
  /**
   * Un fichier arrivé malgré tout après le changement d'avis (une réponse que l'abandon n'arrête
   * pas) : la garde « le spectateur n'a pas changé d'avis » l'empêche encore de s'afficher.
   */
  it("un fichier encore en vol quand on choisit une piste du film : arrivé trop tard, il ne s'affiche jamais", async () => {
    external();
    let requested = false;
    let deliver: () => void = () => {};
    rest = (url) => {
      if (url !== "/es.vtt") return { ok: true, text: async () => "" };
      requested = true;
      return new Promise((resolve) => (deliver = () => resolve({ ok: true, text: async () => "WEBVTT\n\n00:00:01.000 --> 00:09:00.000\nHola." })));
    };
    mount();
    await ready();
    await act(async () => void fireEvent.click(screen.getByText(/^st:Espagnol/)));
    await waitFor(() => expect(requested).toBe(true));

    await act(async () => void fireEvent.click(screen.getByText(/^st:Français/)));
    expect(remux.selectSubtitleTrack).toHaveBeenLastCalledWith(5);
    await act(async () => deliver());
    await act(async () => void fireEvent(videoElement(2), new Event("timeupdate")));
    expect(screen.getByText("Ligne du fichier.")).toBeTruthy();
    expect(screen.queryByText("Hola.")).toBeNull();
    expect(screen.getByTestId("controls").dataset.currentSubtitle).toBe("5");
  });

  /**
   * Choisir une piste du film, ou rien, abandonne un fichier encore en vol comme le fait un autre
   * fichier : seuls un autre fichier et la fermeture l'abandonnaient, et son échec tardif affichait
   * « sous-titres indisponibles » pour un fichier que le spectateur avait quitté (22/10/2026).
   */
  it.each([
    ["une piste du film", /^st:Français/],
    ["aucun sous-titre", /^st:aucun$/],
  ])("un fichier en vol quitté pour %s : abandonné, son échec tardif ne dit rien", async (_, choice) => {
    external();
    let signal: AbortSignal | undefined;
    let fail: () => void = () => {};
    rest = (url, init) => {
      if (url !== "/es.vtt") return { ok: true, text: async () => "" };
      signal = init!.signal!;
      // Un échec réseau, pas un abandon : la demande échoue d'elle-même après le changement d'avis.
      return new Promise((_, reject) => (fail = () => reject(new TypeError("Failed to fetch"))));
    };
    mount();
    await ready();
    await act(async () => void fireEvent.click(screen.getByText(/^st:Espagnol/)));
    await waitFor(() => expect(signal).toBeDefined());

    await act(async () => void fireEvent.click(screen.getByText(choice)));
    await act(async () => fail());
    await act(async () => {});
    expect(screen.queryByText("externalSubtitlesUnavailable")).toBeNull();
    expect(signal!.aborted).toBe(true);
  });

  it("un fichier en vol remplacé par un autre fichier : la première demande est abandonnée, sans avertissement", async () => {
    swr = {
      data: info({
        externalSubtitles: [
          { id: -1, language: "spa", title: null, url: "/es.vtt" },
          { id: -2, language: "ita", title: null, url: "/it.vtt" },
        ],
      }),
      error: undefined,
    };
    const signals: Record<string, AbortSignal> = {};
    rest = (url, init) => {
      if (url === "/es.vtt") {
        signals[url] = init!.signal!;
        // Une demande abandonnée rejette, comme `fetch` : c'est ce rejet qui ne doit rien dire.
        return new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      if (url === "/it.vtt") return { ok: true, text: async () => "WEBVTT\n\n00:00:01.000 --> 00:09:00.000\nCiao." };
      return { ok: true, text: async () => "" };
    };
    mount();
    await ready();
    await act(async () => void fireEvent.click(screen.getByText(/^st:Espagnol/)));
    await waitFor(() => expect(signals["/es.vtt"]).toBeDefined());
    await act(async () => void fireEvent.click(screen.getByText(/^st:Italien/)));
    expect(signals["/es.vtt"].aborted).toBe(true);
    await act(async () => void fireEvent(videoElement(2), new Event("timeupdate")));
    await waitFor(() => expect(screen.getByText("Ciao.")).toBeTruthy());
    expect(screen.queryByText("externalSubtitlesUnavailable")).toBeNull();
  });

  it("un fichier chargé survit à une reconstruction : ni redemandé, ni perdu", async () => {
    external();
    rest = (url) => (url === "/es.vtt" ? { ok: true, text: async () => "WEBVTT\n\n00:00:01.000 --> 00:09:00.000\nHola." } : { ok: true, text: async () => "" });
    mount();
    await ready();
    await act(async () => void fireEvent.click(screen.getByText(/^st:Espagnol/)));
    await act(async () => void fireEvent(videoElement(2), new Event("timeupdate")));
    await waitFor(() => expect(screen.getByText("Hola.")).toBeTruthy());

    // La source se perd en plein film : reconstruction au même endroit.
    remux.lost = true;
    remux.position = 120;
    const rebuilt = fakeRemux();
    nextProbe = () => ({ path: "remux", start: async () => rebuilt, discard: vi.fn() });
    act(() => probes[0].onError("la source est morte"));
    await waitFor(() => expect(probes).toHaveLength(2));
    await ready();
    // Le fichier reste la seule source : le pipeline neuf n'est jamais interrogé pour le principal.
    rebuilt.subtitleAt.mockClear();
    await act(async () => void fireEvent(videoElement(130), new Event("timeupdate")));
    expect(screen.getByText("Hola.")).toBeTruthy();
    expect(rebuilt.subtitleAt).not.toHaveBeenCalledWith(expect.any(Number), undefined);
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => url === "/es.vtt")).toHaveLength(1);
  });

  it("un décalage corrige une piste, pas la suivante : remis à zéro au changement, appliqué à l'horloge entre-temps", async () => {
    mount();
    await ready();
    await act(async () => void fireEvent.click(screen.getByText(/^st:Français/)));
    await act(async () => void fireEvent.click(screen.getByText("décalage:0")));
    expect(screen.getByText("décalage:0.5")).toBeTruthy();
    remux.subtitleAt.mockClear();
    await act(async () => void fireEvent(videoElement(10), new Event("timeupdate")));
    expect(remux.subtitleAt).toHaveBeenCalledWith(9.5, undefined);

    await act(async () => void fireEvent.click(screen.getByText(/^st:Anglais/)));
    expect(screen.getByText("décalage:0")).toBeTruthy();
    remux.subtitleAt.mockClear();
    await act(async () => void fireEvent(videoElement(10), new Event("timeupdate")));
    expect(remux.subtitleAt).toHaveBeenCalledWith(10, undefined);
  });

  it("deux sous-titres : le second pris comme principal disparaît ; sans principal, aucun second n'est retenu", async () => {
    mount();
    await ready();
    // Sans principal : refusé.
    await act(async () => void fireEvent.click(screen.getByText(/^st2:Anglais/)));
    expect(controls().currentSecond).toBe("");

    await act(async () => void fireEvent.click(screen.getByText(/^st:Français/)));
    await act(async () => void fireEvent.click(screen.getByText(/^st2:Anglais/)));
    expect(controls().currentSecond).toBe("6");
    // Le même que le principal : refusé, le second d'avant reste.
    await act(async () => void fireEvent.click(screen.getByText(/^st2:Français/)));
    expect(controls().currentSecond).toBe("6");

    // L'anglais devient le principal : il n'est plus le second.
    await act(async () => void fireEvent.click(screen.getByText(/^st:Anglais/)));
    expect(controls().currentSubtitle).toBe("6");
    expect(controls().currentSecond).toBe("");
    await act(async () => void fireEvent(videoElement(10), new Event("timeupdate")));
    expect(document.querySelector("[data-subtitle-second]")).toBeNull();
  });

  it("fermé avec deux fichiers en vol : les deux demandes sont abandonnées, sans avertissement", async () => {
    swr = {
      data: info({
        externalSubtitles: [
          { id: -1, language: "spa", title: null, url: "/es.vtt" },
          { id: -2, language: "ita", title: null, url: "/it.vtt" },
        ],
      }),
      error: undefined,
    };
    const signals: Record<string, AbortSignal> = {};
    rest = (url, init) => {
      if (url === "/es.vtt" || url === "/it.vtt") {
        signals[url] = init!.signal!;
        return new Promise(() => {});
      }
      return { ok: true, text: async () => "" };
    };
    const { unmount } = mount();
    await ready();
    await act(async () => void fireEvent.click(screen.getByText(/^st:Espagnol/)));
    await act(async () => void fireEvent.click(screen.getByText(/^st2:Italien/)));
    await waitFor(() => expect(Object.keys(signals)).toHaveLength(2));
    expect(signals["/es.vtt"].aborted).toBe(false);
    expect(signals["/it.vtt"].aborted).toBe(false);
    unmount();
    expect(signals["/es.vtt"].aborted).toBe(true);
    expect(signals["/it.vtt"].aborted).toBe(true);
  });
});
