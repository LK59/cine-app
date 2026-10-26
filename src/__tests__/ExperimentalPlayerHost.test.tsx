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
/** Ce que la trace rend quand on lui demande ses dernières étapes — vide, sauf pour qui le dit. */
let recentSteps: string[] = [];
vi.mock("@/lib/webcodecs/trace", () => ({ trace: vi.fn(), traceKeepAcrossReset: vi.fn(), traceRecent: () => recentSteps }));
vi.mock("@/lib/webcodecs/pathSelector", () => ({ NATIVE_PATH: "raison du choix" }));
/** WebKit en HLS natif ? Faux par défaut (jsdom) — les tests de la zone illisible (§93) le changent. */
let nativeHlsHere = false;
vi.mock("@/lib/webkitEngine", async (original) => ({
  ...(await original<typeof import("@/lib/webkitEngine")>()),
  playsHlsNatively: () => nativeHlsHere,
}));
/**
 * Le préchauffage de la version allégée (§78), simulé : chaque lancement est noté, et le test dit quand
 * il est prêt (`settle`). Le module réel a ses propres tests (`lighterPrewarm.test.ts`).
 */
type FakePrewarm = { state: string; startSeconds: number; step: { targetBps: number; tier: number }; ready: Promise<boolean>; startedAt: number; readyAt: number | null };
const prewarms: { options: { itemId: string; step: { targetBps: number; tier: number }; startSeconds: number }; prewarm: FakePrewarm; settle: (ok: boolean) => void }[] = [];
const cancelPrewarmSpy = vi.fn((p?: FakePrewarm | null) => {
  if (p) p.state = "cancelled";
});
vi.mock("@/lib/lighterPrewarm", async (original) => ({
  prewarmStatusOf: (await original<typeof import("@/lib/lighterPrewarm")>()).prewarmStatusOf,
  prewarmGone: (await original<typeof import("@/lib/lighterPrewarm")>()).prewarmGone,
  startPrewarm: (options: { itemId: string; step: { targetBps: number; tier: number }; startSeconds: number }) => {
    let resolve: (ok: boolean) => void = () => {};
    const prewarm: FakePrewarm = { ...options, state: "running", startedAt: 0, readyAt: null, ready: new Promise<boolean>((r) => (resolve = r)) };
    prewarms.push({
      options,
      prewarm,
      settle: (ok) => {
        prewarm.state = ok ? "ready" : "failed";
        prewarm.readyAt = ok ? 1500 : null;
        resolve(ok);
      },
    });
    return prewarm;
  },
  cancelPrewarm: (p?: FakePrewarm | null) => cancelPrewarmSpy(p),
  prewarmFields: () => ({ mbps: 1.5 }),
}));
/**
 * Le diagnostic de la séance (§78) : réel, sauf ce que les tests des saccades et des sauts imposent —
 * la classe de l'attente en cours ou finie, et le lien mesuré sur une fenêtre.
 */
const diagMock: {
  currentWait: { verdict: string; ms: number } | null;
  waitEnded: { verdict: string; ms: number } | null;
  link: { bytes: number; receivingMs: number } | null;
} = { currentWait: null, waitEnded: null, link: null };
/** Chaque bilan calculé, et s'il l'a été exact — voir « ne réécrit le bilan que s'il a changé ». */
const sessionFactsCalls: ({ exact?: boolean } | undefined)[] = [];
vi.mock("@/lib/webcodecs/playbackDiagnosis", async (original) => {
  const real = await original<typeof import("@/lib/webcodecs/playbackDiagnosis")>();
  return {
    ...real,
    diagSessionFacts: (options?: { exact?: boolean }) => {
      sessionFactsCalls.push(options);
      return real.diagSessionFacts(options);
    },
    diagCurrentWait: () => diagMock.currentWait ?? real.diagCurrentWait(),
    diagWaitEnded: (counted?: boolean) => {
      const result = real.diagWaitEnded(counted);
      return counted === false ? result : diagMock.waitEnded ?? result;
    },
    diagLinkMeasure: (windowMs?: number) => diagMock.link ?? real.diagLinkMeasure(windowMs),
  };
});
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

const stopPlaybackNow = vi.fn();
const resumePlaybackSession = vi.fn();
/** Ce que le lecteur annonce à Jellyfin, rendu après rendu : `null` veut dire « pas de séance ». */
const announcedSessions: unknown[] = [];
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: (_position: unknown, session: unknown) => {
    announcedSessions.push(session);
    return { stop: stopPlaybackNow, reportNow: () => {}, resume: resumePlaybackSession };
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
    subtitleTracks: { id: number; label: string; detail?: string }[];
    currentSubtitleId?: number | null;
    onChangeAudio: (id: number) => void;
    onChangeSubtitle: (id: number | null) => void;
    onSeekRequest?: (seconds: number) => void;
    // « Générer des sous-titres » (DECISIONS.md §70) : une ligne par langue proposée, une par reprise.
    subtitleGeneration?: {
      targets: { code: string; label: string }[];
      onGenerate: (code: string) => void;
      resumable: { code: string; label: string }[];
      onResume: (code: string) => void;
    };
    suspended?: boolean;
    subtitleOffset?: { seconds: number; onShift: (delta: number) => void };
    // « Deux sous-titres » (DECISIONS.md §87) : une ligne par second possible, « aucun », la génération.
    secondSubtitle?: {
      currentId: number | null;
      onChange: (id: number | null) => void;
      tracks?: { id: number; label: string }[];
      offset?: { seconds: number; onShift: (delta: number) => void };
      generation?: { targets: { code: string; label: string }[]; onGenerate: (code: string) => void };
    };
    hdrCap?: { current: string | number; autoNits: number | null; onPick: (choice: string | number) => void };
    onClose?: () => void;
    chromecast?: { active: boolean; onRequest: () => void };
  }) => (
    <div
      data-testid="controls"
      data-loading={String(props.loading)}
      data-suspended={String(!!props.suspended)}
      data-current-subtitle={String(props.currentSubtitleId ?? "")}
      data-current-second={String(props.secondSubtitle?.currentId ?? "")}
    >
      {props.onClose && <button onClick={props.onClose}>fermer</button>}
      {/* Le bouton où le focus doit entrer à l'ouverture — voir `usePlayerFocus`. */}
      <button data-player-nav="playpause">lecture/pause</button>
      {props.chromecast && <button onClick={props.chromecast.onRequest}>chromecast</button>}
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
      {props.subtitleOffset && (
        <button onClick={() => props.subtitleOffset!.onShift(0.5)}>{`décalage:${props.subtitleOffset.seconds}`}</button>
      )}
      {props.hdrCap && <button onClick={() => props.hdrCap!.onPick(150)}>{`hdr:${props.hdrCap.current}:${props.hdrCap.autoNits}`}</button>}
      {props.audioTracks.map((track) => (
        <button key={track.id} onClick={() => props.onChangeAudio(track.id)}>{`audio:${track.label}`}</button>
      ))}
      {props.subtitleTracks.map((track) => (
        <button key={track.id} data-detail={track.detail} onClick={() => props.onChangeSubtitle(track.id)}>{`st:${track.label}`}</button>
      ))}
      {props.subtitleGeneration?.targets.map((target) => (
        <button key={target.code} onClick={() => props.subtitleGeneration!.onGenerate(target.code)}>{`gen:${target.code}`}</button>
      ))}
      {props.subtitleGeneration?.resumable.map((entry) => (
        <button key={entry.code} onClick={() => props.subtitleGeneration!.onResume(entry.code)}>{`reprendre:${entry.code}`}</button>
      ))}
      <button onClick={() => props.onChangeSubtitle(null)}>st:aucun</button>
      {props.secondSubtitle &&
        (props.secondSubtitle.tracks ?? props.subtitleTracks)
          .filter((track) => track.id !== props.currentSubtitleId)
          .map((track) => (
            <button key={`2:${track.id}`} onClick={() => props.secondSubtitle!.onChange(track.id)}>{`st2:${track.label}`}</button>
          ))}
      {props.secondSubtitle && <button onClick={() => props.secondSubtitle!.onChange(null)}>st2:aucun</button>}
      {props.secondSubtitle?.generation?.targets.map((target) => (
        <button key={`g2:${target.code}`} onClick={() => props.secondSubtitle!.generation!.onGenerate(target.code)}>{`gen2:${target.code}`}</button>
      ))}
      {props.secondSubtitle?.offset && (
        <button onClick={() => props.secondSubtitle!.offset!.onShift(0.5)}>{`décalage2:${props.secondSubtitle.offset.seconds}`}</button>
      )}
    </div>
  ),
}));

// --- the file's description, as the route gives it -------------------------------------------

type Info = Record<string, unknown>;
let swr: { data: Info | undefined; error: unknown };
/** Le compte (`/api/auth/me`, lu par `useRole`) — inconnu par défaut, comme avant la réponse. */
let me: { data: { role: "admin" | "user" } | undefined; error: unknown } = { data: undefined, error: undefined };
vi.mock("swr", () => ({ default: (key: unknown) => (key === "/api/auth/me" ? me : swr) }));
// La relecture des vues après une fermeture : hors de ce qui est examiné ici, et bâtie sur le
// `mutate` global que ce double de SWR n'a pas — les tests qui ferment le lecteur la laissaient
// échouer en arrière-plan.
vi.mock("@/lib/swr", async (original) => ({
  ...(await original<typeof import("@/lib/swr")>()),
  refreshAfterPlayback: vi.fn(async () => {}),
}));

/**
 * Y a-t-il un lecteur serveur derrière ? `undefined` par défaut, comme pendant l'attente réelle.
 *
 * C'est ce qui décide du sens de « renoncer » : céder la main, ou s'arrêter en le disant.
 */
let serverFallback: boolean | undefined;
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => serverFallback }));
// La réserve d'avance en mémoire (28/09/2026) : examinée par quand elle démarre et s'arrête.
const reserveStop = vi.fn(() => ({}));
const reserveStart = vi.fn((..._args: unknown[]) => ({ stop: reserveStop }));
vi.mock("@/lib/webcodecs/memoryReserve", () => ({ reservePlanFacts: () => ({}), MemoryReserve: { start: (...args: unknown[]) => reserveStart(...args) } }));
// Ce que l'arrêt garde sur l'appareil (28/09/2026) : examiné par ce qui lui est transmis.
const keepOnStop = vi.fn(async () => 0);
vi.mock("@/lib/resumeCache/keepOnStop", () => ({ keepOnStop: (...args: unknown[]) => keepOnStop(...(args as [])) }));

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
    externalSubtitles: [],
    video: { codec: "hevc", width: 1920, height: 1080, bitDepth: 10, isHdr: false, rangeType: "SDR" },
    introSkip: null,
    creditsStart: null,
    ...over,
  };
}

// --- the pipelines ----------------------------------------------------------------------------

type Callbacks = {
  onError: (message: string, kind?: "network" | "playback", facts?: Record<string, unknown>) => void;
  onUnreadableZone?: (event: unknown) => void;
  onWarning: (warning: { code: string; detail?: string }) => void;
  onStarting: (at: number | null) => void;
  onStall?: (facts: Record<string, unknown>) => void;
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
    // Rien de retenu au départ (`MseSource.openingHold`) : l'hôte lance aussitôt, comme avant.
    openingHold: vi.fn(() => null),
    // Tout changement de piste reconstruit le lecteur ; seul un fichier sans index en cours de
    // film le refuse, et les tests qui l'examinent le disent eux-mêmes.
    requestAudioTrack: vi.fn((id: number): "rebuild" | "refused" | null => (id === fake.currentAudioTrack ? null : "rebuild")),
    selectSubtitleTrack: vi.fn(),
    subtitleAt: vi.fn(() => null),
    diagnostics: {},
    destroy: vi.fn(),
    lost: false,
    lossReport: vi.fn(() => ({ videoBuffered: "10.00–14.00", steps: "+0 ms l'élément a échoué" })),
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

// La lecture a-t-elle déjà montré une image ? Le vrai signal (`useIntroPlaybackStarted`), que
// jsdom ne fait jamais lever seul ; un test de panne « en cours de film » le pose.
const pictureSeen = vi.hoisted(() => ({ force: false }));
vi.mock("@/lib/introEnd", async (original) => {
  const real = await original<typeof import("@/lib/introEnd")>();
  return {
    ...real,
    useIntroPlaybackStarted: (...args: Parameters<typeof real.useIntroPlaybackStarted>) => {
      const started = real.useIntroPlaybackStarted(...args);
      return pictureSeen.force || started;
    },
  };
});

import { noteWatching } from "@/lib/resumeRewind";
import { resetIntroClocks } from "@/lib/playbackIntro";
import { ExperimentalPlayerHost } from "@/components/ExperimentalPlayerHost";
import { ShareModeProvider } from "@/components/ShareMode";
import { meterOpeningRequest } from "@/lib/slowLink";
import { forgetLighterCarry } from "@/lib/playbackQuality";
import { noteFetchRetrying, noteFetchSettled, resetNetworkTrouble } from "@/lib/networkTrouble";
import { writePlaybackQuality } from "@/lib/playbackQuality";

const onFallback = vi.fn();

function player(over: Partial<{ resumeAt: number; itemId: string; mode: "full" | "mini"; startPaused: boolean; bench: boolean }> = {}) {
  return (
    <ExperimentalPlayerHost
      session={
        {
          itemId: over.itemId ?? "item-1",
          title: "Un film",
          resumeAt: over.resumeAt ?? null,
          ...(over.startPaused ? { startPaused: true } : {}),
          ...(over.bench ? { bench: true } : {}),
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

/**
 * Attend une condition en tours de boucle, pas en millisecondes.
 *
 * L'ouverture simulée n'est faite que de promesses : elle aboutit en un nombre de tours borné, quel
 * que soit le temps que la machine y met. `waitFor` et sa seconde par défaut supposaient une machine
 * libre — sous la charge de plusieurs suites en parallèle, 250 ms en devenaient plus d'une, et le
 * test échouait sans que rien n'ait changé dans le code (10/10/2026).
 */
async function untilSettled(check: () => void, turns = 200): Promise<void> {
  for (let i = 0; i < turns; i++) {
    try {
      check();
      return;
    } catch {
      await act(async () => {});
    }
  }
  check();
}

function mount(over: Partial<{ resumeAt: number; itemId: string; mode: "full" | "mini"; startPaused: boolean; bench: boolean }> = {}) {
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
  pictureSeen.force = false;
  // Le titre des tests vient d'être joué sur cet appareil : pas de recul à l'ouverture, ce que
  // tous les tests d'avant ce réglage supposent. Ceux qui l'éprouvent vident ce souvenir.
  window.localStorage.removeItem("cine:last-watched");
  noteWatching("item-1");
  recentSteps = [];
  nativeHlsHere = false;
  prewarms.length = 0;
  serverFallback = undefined;
  probes = [];
  announcedSessions.length = 0;
  swr = { data: info(), error: undefined };
  me = { data: undefined, error: undefined };
  window.localStorage.removeItem("cine-dialogue");
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
    await untilSettled(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());

    act(() => void screen.getByText(/^audio:Anglais/).click());

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0]).toContain("A_TRUEHD");
    // Et surtout : pas de reconstruction sur une piste que ce chemin refuserait. Le verdict était
    // connu d'avance.
    expect(remux.requestAudioTrack).not.toHaveBeenCalled();
    expect(probes).toHaveLength(1);
  });

  /**
   * Relu le 23/09/2026 : la langue du compte, enfermée dans un codec que ce chemin ne porte pas.
   *
   * Le lecteur voulait s'ouvrir sur elle, se reconstruisait dessus, échouait, repartait sur la
   * piste du fichier, la voulait de nouveau… Le verdict était connu d'avance : c'est le lecteur
   * serveur qui la porte, dès l'ouverture, à la position d'ouverture.
   */
  it("confie dès l'ouverture la langue du compte au lecteur serveur", async () => {
    swr = { data: info({ audio: [{ index: 1 }, { index: 2 }] }), error: undefined };
    viewerState = {
      resumeSeconds: 0,
      preferences: { audioLanguage: "eng", subtitleLanguage: null, subtitleMode: "Default", playDefaultAudioTrack: false },
    };
    mount();
    await waitFor(() => expect(onFallback).toHaveBeenCalledTimes(1));
    expect(onFallback.mock.calls[0][1]).toMatchObject({ audioStreamIndex: 2 });
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
    await untilSettled(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());

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
    await untilSettled(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());

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

  it("fait entrer le focus dans le lecteur, sur lecture/pause, au lieu de le laisser sur la fiche dessous", async () => {
    // Chasse aux défauts du 13/10/2026 : seul le lecteur serveur déplaçait le focus. Dans le lecteur
    // natif, il restait sur le bouton « Lecture » de la fiche, montée sous le film — et Entrée (le centre
    // d'une télécommande), que le clavier du lecteur laisse au bouton focalisé, l'actionnait.
    const underneath = document.createElement("button");
    underneath.textContent = "Lecture (fiche)";
    document.body.appendChild(underneath);
    underneath.focus();
    try {
      mount();
      await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
      await waitFor(() => expect((document.activeElement as HTMLElement | null)?.dataset.playerNav).toBe("playpause"));
    } finally {
      underneath.remove();
    }
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

  it("ne pose pas le rapport « le chargement n'aboutit pas » sur l'écran de coupure", async () => {
    // Chasse aux défauts du 13/10/2026 : la coupure pendant l'ouverture laisse l'horloge de
    // l'ouverture courir, et passé vingt secondes le rapport d'attente (« Échec : aucun message, et
    // le chargement n'aboutit pas ») montait en bas de l'écran, par-dessus « Connexion perdue » et ses
    // boutons — deux messages contraires à la fois, ce que la roue s'était déjà vu interdire.
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    const offline = Object.assign(new Error("Failed to fetch"), { network: true });
    nextProbe = () => {
      throw offline;
    };
    vi.useFakeTimers();
    mount();
    await act(async () => {});
    expect(screen.getByText("connectionLost")).toBeTruthy();

    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(screen.getByText("connectionLost")).toBeTruthy();
    expect(screen.queryByTestId("report")).toBeNull();
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
  /**
   * Relu le 23/09/2026 : iOS ferme la source d'une page restée en arrière-plan. La reconstruction
   * au retour n'était écrite que dans la trace — au journal, une ouverture de plus.
   */
  it("écrit la reconstruction au retour d'arrière-plan, avec la durée de l'absence", async () => {
    const setVisibility = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    const { unmount } = mount();
    // Le pipeline construit, et pas seulement l'écran sorti du chargement : sous la charge de la
    // suite complète, le retour d'arrière-plan tombait avant que le lecteur existe, ses deux
    // vérifications (tout de suite, puis 400 ms après) passaient à vide, et rien ne se
    // reconstruisait (24/09/2026, deux fois, dont une construction d'image).
    await waitFor(() => expect(probes).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const now = vi.spyOn(Date, "now");
    let t = 5_000_000;
    now.mockImplementation(() => t);

    act(() => setVisibility("hidden"));
    t += 90_000;
    remux.lost = true;
    remux.position = 1200;
    act(() => setVisibility("visible"));
    now.mockRestore();

    await waitFor(() => expect(probes).toHaveLength(2), { timeout: 3000 });
    expect(probes[1].startSeconds).toBeCloseTo(1200, 1);
    const logged = (kind: string) =>
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
        .filter(([url]) => url === "/api/player/log")
        .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
        .filter((entry) => entry.kind === kind);
    expect(logged("rebuild")[0].fields).toMatchObject({ reason: "source fermée en arrière-plan", at: 1200, hiddenMs: 90_000 });

    unmount();
    expect(logged("stop")[0].fields).toMatchObject({ backgrounds: 1, backgroundMs: 90_000, backgroundRebuilds: 1 });
  });

  describe("la lecture au retour d'une veille (25/09/2026)", () => {
    const setVisibility = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    /** Une vidéo qui joue, et dont on compte les mises en pause. */
    function playingVideo(at: number) {
      const element = videoElement(at);
      Object.defineProperty(element, "paused", { value: false, configurable: true });
      const pause = vi.fn(() => Object.defineProperty(element, "paused", { value: true, configurable: true }));
      Object.defineProperty(element, "pause", { value: pause, configurable: true });
      return { element, pause };
    }
    afterEach(() => {
      vi.restoreAllMocks();
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    });

    it("attend en pause un peu avant, refuse la relance de WebKit, puis obéit au spectateur", async () => {
      mount();
      await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
      const { element, pause } = playingVideo(4115);
      let t = 5_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => t);

      act(() => setVisibility("hidden"));
      t += 60_000;
      act(() => setVisibility("visible"));
      expect(pause).toHaveBeenCalledTimes(1);
      expect(element.currentTime).toBe(4112);

      // WebKit relance de lui-même un instant après le déverrouillage : refusé.
      t += 300;
      Object.defineProperty(element, "paused", { value: false, configurable: true });
      await act(async () => void fireEvent(element, new Event("play")));
      expect(pause).toHaveBeenCalledTimes(2);

      // Le spectateur appuie sur lecture : la lecture repart.
      t += 500;
      fireEvent.pointerDown(document.body);
      Object.defineProperty(element, "paused", { value: false, configurable: true });
      await act(async () => void fireEvent(element, new Event("play")));
      expect(pause).toHaveBeenCalledTimes(2);
    });

    it("laisse reprendre après un aller-retour de quelques secondes", async () => {
      mount();
      await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
      const { pause } = playingVideo(4115);
      let t = 5_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => t);
      act(() => setVisibility("hidden"));
      t += 3_000;
      act(() => setVisibility("visible"));
      expect(pause).not.toHaveBeenCalled();
    });

    it("reconstruit en pause, un peu avant, quand iOS a fermé la source pendant la veille", async () => {
      mount();
      await waitFor(() => expect(probes).toHaveLength(1));
      await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
      playingVideo(1200);
      let t = 5_000_000;
      vi.spyOn(Date, "now").mockImplementation(() => t);
      act(() => setVisibility("hidden"));
      t += 90_000;
      remux.lost = true;
      remux.position = 1200;
      act(() => setVisibility("visible"));
      await waitFor(() => expect(probes).toHaveLength(2), { timeout: 3000 });
      expect(probes[1].startSeconds).toBeCloseTo(1197, 1);
      expect((probes[1] as unknown as { startPaused: boolean }).startPaused).toBe(true);
    });
  });

  it("reconstruit au lieu de reporter une panne", async () => {
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));

    remux.lost = true;
    remux.position = 100;
    act(() => probes[0].onError("la source est morte"));

    await waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[1].startSeconds).toBeCloseTo(100, 1);
    expect(onFallback).not.toHaveBeenCalled();
    // La ligne porte l'état relevé à la perte (23/09/2026 : trois pertes sans rien d'autre que
    // leur motif, impossibles à attribuer).
    const rebuilt = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === "/api/player/log")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
      .find((entry) => entry.kind === "rebuild");
    expect(rebuilt?.fields).toMatchObject({ reason: "la source est morte", videoBuffered: "10.00–14.00" });
    expect(String(rebuilt?.fields.steps)).toContain("l'élément a échoué");
  });

  it("page cachée, attend le retour au lieu de griller ses reconstructions (iPhone, 21/10/2026)", async () => {
    // Un réveil après 34 min d'écran verrouillé : Safari ferme la source sur un échec de décodage
    // avant que la page soit visible, et chaque reconstruction tentée là échoue aussitôt — trois en
    // 20 ms, puis le lecteur serveur pour rien.
    const setVisibility = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    try {
      mount();
      await waitFor(() => expect(probes).toHaveLength(1));
      await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));

      act(() => setVisibility("hidden"));
      remux.lost = true;
      remux.position = 2774;
      for (let i = 0; i < 6; i++) act(() => probes[0].onError("Media failed to decode"));
      await act(async () => {});
      expect(probes).toHaveLength(1);
      expect(onFallback).not.toHaveBeenCalled();

      act(() => setVisibility("visible"));
      await waitFor(() => expect(probes).toHaveLength(2), { timeout: 3000 });
      expect(probes[1].startSeconds).toBeCloseTo(2774, 1);
      expect(onFallback).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    }
  });

  it("reprend au-delà du passage qui vient d'échouer plutôt que de le relire", async () => {
    // Reading the identical bytes again is a guaranteed way to die again — the record showed
    // three rebuilds each losing the source on the same segment. En cours de film : la lecture a
    // déjà montré une image.
    pictureSeen.force = true;
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

  it("avant la première image, rouvre au même endroit au lieu de sauter 12 s (Eras Tour, iPad, 20/10/2026)", async () => {
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));

    remux.lost = true;
    remux.position = 0.41;
    act(() => probes[0].onError("fermée avant une image"));
    await waitFor(() => expect(probes).toHaveLength(2));
    act(() => probes[1].onError("fermée encore"));

    await waitFor(() => expect(probes).toHaveLength(3));
    expect(probes[2].startSeconds).toBeCloseTo(0.41, 1);
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

  // 14/10/2026 : la ligne qui clôt une suite de pertes porte le même relevé que `rebuild`.
  const fallbackLine = () =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === "/api/player/log")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
      .find((entry) => entry.kind === "fallback");

  it("porte le relevé de la perte sur la ligne `fallback` d'un renoncement", async () => {
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    remux.lost = true;
    remux.lossReport = vi.fn(() => ({
      videoBuffered: "illisible (source fermée)",
      lastBuffered: "vidéo 52.00–60.00 · audio 52.01–60.02 — après envoi vidéo, 40 ms avant",
      videoQuality: "total 120 · perdues 0 · corrompues 1",
      lastFragment: "n°31 (4e depuis le saut) dts 58.000 pts 58.042 · tête -1.20 s · envoyé 40 ms avant",
      steps: "+0 ms l'élément a échoué",
    }));
    for (let attempt = 0; attempt < 4; attempt++) {
      const at = probes.length;
      act(() => probes[at - 1].onError("morte"));
      await act(async () => {});
    }
    expect(onFallback).toHaveBeenCalledWith("morte", expect.anything());
    expect(fallbackLine()?.fields).toMatchObject({
      reason: "morte",
      lastBuffered: expect.stringContaining("52.00–60.00"),
      videoQuality: "total 120 · perdues 0 · corrompues 1",
      lastFragment: expect.stringContaining("n°31"),
    });
  });

  it("cède la main pareil quand le relevé lève", async () => {
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    remux.lost = true;
    for (let attempt = 0; attempt < 4; attempt++) {
      const at = probes.length;
      // Les reconstructions gardent leur relevé ; seul celui du renoncement lève.
      if (attempt === 3) {
        remux.lossReport = vi.fn(() => {
          throw new Error("relevé impossible");
        });
      }
      act(() => probes[at - 1].onError("morte"));
      await act(async () => {});
    }
    expect(onFallback).toHaveBeenCalledWith("morte", expect.anything());
    expect(fallbackLine()?.fields).toMatchObject({ reason: "morte" });
    expect(fallbackLine()?.fields.lastBuffered).toBeUndefined();
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

  // Boucle (a)3 du registre des tentatives (DECISIONS §67) : la reconstruction « sur la piste voulue,
  // autre que celle ouverte » ne consomme pas le budget. Un pipeline qui rouvre toujours sur une autre
  // piste la rejoue sans fin. Prouvée et non corrigée (étape 2 : observation seulement) — à basculer en
  // `it` quand le registre sera activé sur ce chemin.
  it.fails("un pipeline qui rouvre toujours sur une autre piste n'est pas reconstruit sans fin", async () => {
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    // Chaque pipeline suivant ouvre sur la piste 1, quelle que soit celle demandée.
    nextProbe = () => ({ path: "remux", start: async () => fakeRemux(), discard: vi.fn() });
    await act(async () => void fireEvent.click(screen.getByText(/^audio:Anglais/)));
    // Mesuré le 11/10/2026 : près de 2 900 pipelines en 300 tours, sans fin ni passage au serveur.
    for (let i = 0; i < 40; i++) await act(async () => {});
    expect(probes.length).toBeLessThanOrEqual(4);
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

  it("revient d'une diffusion arrêtée d'elle-même en pause, sans relancer le film", async () => {
    // 24/09/2026 : la télé éteinte en fin de film, le lecteur natif repartait sur le téléphone
    // que personne ne regardait — et le journal écrivait un blocage.
    mount({ resumeAt: 6382, startPaused: true });
    await waitFor(() => expect(probes).toHaveLength(1));
    expect(probes[0]).toMatchObject({ startPaused: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it("revient à la piste d'avant quand la nouvelle n'ouvre pas par le lecteur natif", async () => {
    // Relu le 22/09/2026 : module TrueHD injoignable, encodeur qui refuse — la reconstruction
    // tombait sur un autre lecteur, et un film qui jouait était perdu pour un choix de langue.
    // Avant la livraison par piste, un changement raté laissait l'ancienne jouer.
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());

    const back = fakeRemux({ currentAudioTrack: 1 });
    let attempt = 0;
    nextProbe = () =>
      ++attempt === 1
        ? (() => {
            throw new Error("Aucun chemin de lecture disponible pour ce fichier. remux : module TrueHD injoignable");
          })()
        : { path: "remux", start: async () => back, discard: vi.fn() };
    await act(async () => void fireEvent.click(screen.getByText(/^audio:Anglais/)));

    await waitFor(() => expect(probes).toHaveLength(3));
    expect(probes[1]).toMatchObject({ audioTrackNumber: 2 });
    expect(probes[2]).toMatchObject({ audioTrackNumber: 1 });
    // Pas de lecteur serveur : le film continue sur la piste qui jouait.
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

  // Relu le 24/09/2026 : éteindre les sous-titres remettait `wantedSubtitleRef` à `null`, soit
  // « jamais choisi » — et chaque reconstruction réappliquait ceux du compte.
  it("n'allume pas à nouveau des sous-titres que le spectateur a éteints, après une reconstruction", async () => {
    viewerState = { resumeSeconds: 0, preferences: { ...preferences, subtitleMode: "Always" } };
    mount();
    await waitFor(() => expect(remux.selectSubtitleTrack).toHaveBeenCalledWith(5));
    await act(async () => void fireEvent.click(screen.getByText("st:aucun")));
    expect(remux.selectSubtitleTrack).toHaveBeenLastCalledWith(null);

    const rebuilt = fakeRemux();
    nextProbe = () => ({ path: "remux", start: async () => rebuilt, discard: vi.fn() });
    remux.lost = true;
    act(() => probes[0].onError("morte"));
    await waitFor(() => expect(probes).toHaveLength(2));
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    expect(rebuilt.selectSubtitleTrack).not.toHaveBeenCalledWith(5);
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

/**
 * « Deux sous-titres » (DECISIONS.md §87), vu du lecteur natif : chaque piste garde ses lignes et son
 * horloge, le second se lit dans les lignes déjà recueillies (une autre piste, pas un autre filtre du
 * pipeline), il a son propre décalage, et le choix est retenu pour le film suivant.
 */
describe("deux sous-titres à la fois", () => {
  beforeEach(() => {
    window.localStorage.removeItem("cine:dual-subtitles");
    remux = fakeRemux({
      subtitleTracks: [
        { number: 5, codecId: "S_TEXT/UTF8", language: "fre", name: null, isDefault: false, isForced: false },
        { number: 6, codecId: "S_TEXT/UTF8", language: "eng", name: null, isDefault: false, isForced: false },
      ],
      // Le principal se lit sur la piste choisie (pas de piste donnée), le second sur la sienne.
      subtitleAt: vi.fn((at: number, track?: number) => (track === 6 ? (at < 20 ? "Hello." : null) : track === undefined ? "Bonjour." : null)),
    });
  });

  const controls = () => screen.getByTestId("controls").dataset;

  async function twoSubtitles() {
    mount();
    await waitFor(() => expect(screen.getByText(/^st:Français/)).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText(/^st:Français/)));
    await act(async () => void fireEvent.click(screen.getByText(/^st2:Anglais/)));
  }

  it("les deux répliques en même temps, le second au-dessus ; un seul quand l'autre se tait", async () => {
    await twoSubtitles();
    expect(controls().currentSubtitle).toBe("5");
    expect(controls().currentSecond).toBe("6");
    // Le pipeline ne filtre que le principal : le second ne lui est jamais demandé comme piste choisie.
    expect(remux.selectSubtitleTrack).not.toHaveBeenCalledWith(6);
    await act(async () => void fireEvent(videoElement(10), new Event("timeupdate")));
    const row = document.querySelector('[data-subtitle-row="bottom"]')!;
    expect([...row.children].map((el) => el.textContent)).toEqual(["Hello.", "Bonjour."]);
    expect(row.lastElementChild!.hasAttribute("data-subtitle-primary")).toBe(true);

    // Le second se tait : le principal reste seul, à sa place, sans second.
    await act(async () => void fireEvent(videoElement(30), new Event("timeupdate")));
    expect(document.querySelector("[data-subtitle-second]")).toBeNull();
    expect(document.querySelector("[data-subtitle-primary]")?.textContent).toBe("Bonjour.");
  });

  it("le décalage du second ne touche qu'à lui", async () => {
    await twoSubtitles();
    await act(async () => void fireEvent.click(screen.getByText("décalage2:0")));
    expect(screen.getByText("décalage2:0.5")).toBeTruthy();
    // Le principal garde son décalage à zéro.
    expect(screen.getByText("décalage:0")).toBeTruthy();
    remux.subtitleAt.mockClear();
    await act(async () => void fireEvent(videoElement(10), new Event("timeupdate")));
    expect(remux.subtitleAt).toHaveBeenCalledWith(9.5, 6);
    expect(remux.subtitleAt).toHaveBeenCalledWith(10, undefined);
  });

  it("le second venu d'un fichier à côté du film : téléchargé au choix, sur l'horloge du fichier", async () => {
    swr = { data: info({ externalSubtitles: [{ id: -1, language: "spa", title: null, url: "/es.vtt" }] }), error: undefined };
    stubFetch((url) => (url === "/es.vtt" ? { ok: true, text: async () => "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHola." } : { ok: true, text: async () => "" }));
    mount();
    await waitFor(() => expect(screen.getByText(/^st:Français/)).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText(/^st:Français/)));
    await act(async () => void fireEvent.click(screen.getByText(/^st2:Espagnol/)));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/es.vtt", expect.anything()));
    // Le principal, piste du fichier, reste filtré par le pipeline.
    expect(remux.selectSubtitleTrack).not.toHaveBeenCalledWith(null);
    await act(async () => void fireEvent(videoElement(2), new Event("timeupdate")));
    await waitFor(() => expect(document.querySelector("[data-subtitle-second]")?.textContent).toBe("Hola."));
    expect(document.querySelector("[data-subtitle-primary]")?.textContent).toBe("Bonjour.");
  });

  it("éteindre le principal éteint aussi le second ; « aucun » revient à un seul", async () => {
    await twoSubtitles();
    await act(async () => void fireEvent.click(screen.getByText("st2:aucun")));
    expect(controls().currentSecond).toBe("");
    expect(controls().currentSubtitle).toBe("5");
    await act(async () => void fireEvent.click(screen.getByText(/^st2:Anglais/)));
    await act(async () => void fireEvent.click(screen.getByText("st:aucun")));
    expect(controls().currentSecond).toBe("");
    expect(controls().currentSubtitle).toBe("");
    await act(async () => void fireEvent(videoElement(10), new Event("timeupdate")));
    expect(document.querySelector("[data-subtitle-second]")).toBeNull();
  });

  it("retenu sur l'appareil, réappliqué au film suivant si les langues y sont — sinon un seul", async () => {
    await twoSubtitles();
    expect(JSON.parse(window.localStorage.getItem("cine:dual-subtitles")!)).toMatchObject({ primary: "fr", second: "en" });
    cleanup();

    // Le film suivant, sans préférence de compte : les deux reviennent.
    mount({ itemId: "item-2" });
    await untilSettled(() => expect(controls().currentSecond).toBe("6"));
    expect(controls().currentSubtitle).toBe("5");
    expect(remux.selectSubtitleTrack).toHaveBeenCalledWith(5);
    cleanup();

    // Un film sans piste anglaise : un seul sous-titre, et le choix reste retenu pour la suite.
    remux = fakeRemux({ subtitleTracks: [{ number: 5, codecId: "S_TEXT/UTF8", language: "fre", name: null, isDefault: false, isForced: false }] });
    mount({ itemId: "item-3" });
    await untilSettled(() => expect(controls().loading).toBe("false"));
    expect(controls().currentSecond).toBe("");
    expect(window.localStorage.getItem("cine:dual-subtitles")).not.toBeNull();
  });
});

/**
 * « Générer des sous-titres » (DECISIONS.md §70), vu de l'hôte : l'entrée temporaire, les messages
 * d'état dessinés comme des sous-titres, la bascule vers la piste finale — et aucun de ses échecs ne
 * touche à la lecture.
 */
describe("générer des sous-titres", () => {
  type Json = Record<string, unknown>;
  let gen: {
    options: Json;
    create: { status: number; body: unknown };
    polls: Json[];
    pollBodies: Json[];
    createBodies: Json[];
    externals: Json[];
  };

  function genServer() {
    gen = {
      options: { enabled: true, targets: ["fr", "en"], existing: [], jobs: [], quota: { used: 0, limit: 30 } },
      create: { status: 200, body: { jobId: "j1", status: "preparing" } },
      polls: [],
      pollBodies: [],
      createBodies: [],
      externals: [],
    };
    const json = (status: number, body: unknown) => ({ ok: status < 300, status, json: async () => body, text: async (): Promise<string> => "" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("/api/jellyfin/playback-state/")) return { ok: true, json: async () => viewerState };
        if (url.startsWith("/api/subtitle-gen/options")) return json(200, gen.options);
        if (url === "/api/subtitle-gen/jobs") {
          gen.createBodies.push(JSON.parse(String(init?.body)) as Json);
          return json(gen.create.status, gen.create.body);
        }
        if (/\/api\/subtitle-gen\/jobs\/[^/]+\/poll$/.test(url)) {
          gen.pollBodies.push({ url, ...(JSON.parse(String(init?.body)) as Json) });
          const next = gen.polls.length > 1 ? gen.polls.shift()! : gen.polls[0];
          return json(200, next ?? { status: "preparing", rev: 0, done: 0, total: 0, cues: [] });
        }
        if (url.startsWith("/api/jellyfin/direct/")) return json(200, { externalSubtitles: gen.externals });
        if (url === "/genere.vtt") return { ok: true, status: 200, text: async (): Promise<string> => "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nfichier final" };
        return { ok: true, status: 200, text: async (): Promise<string> => "", json: async (): Promise<unknown> => ({}) };
      })
    );
  }

  const logged = () =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === "/api/player/log")
      .map(([, init]) => JSON.parse((init as { body: string }).body) as { kind: string; fields: Record<string, unknown> });
  const overlay = () => document.querySelector("p[style]") as HTMLElement | null;

  beforeEach(() => genServer());

  it("propose les langues absentes, et rien quand la fonction est coupée", async () => {
    gen.options = { ...gen.options, existing: ["en"] };
    mount();
    await waitFor(() => expect(screen.getByText("gen:fr")).toBeTruthy());
    expect(screen.queryByText("gen:en")).toBeNull();
    cleanup();

    genServer();
    gen.options = { ...gen.options, enabled: false };
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    await settle();
    expect(screen.queryByText("gen:fr")).toBeNull();
  });

  // Un lien de partage (DECISIONS.md §112) : la porte des liens refuse `/api/subtitle-gen/*` ; le
  // lecteur ne le demande même pas — ni options au montage, ni « Générer » au menu. Le test du dessus
  // prouve que, sans le drapeau, le même montage les demande et les propose.
  it("lien de partage : la génération n'est jamais ouverte — aucune demande, aucune langue proposée", async () => {
    render(<ShareModeProvider shareMode>{player()}</ShareModeProvider>);
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    await settle();
    expect(screen.queryByText("gen:fr")).toBeNull();
    expect(screen.queryByText("gen2:fr")).toBeNull();
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => String(url));
    expect(calls.some((url) => url.startsWith("/api/subtitle-gen"))).toBe(false);
    expect(calls.some((url) => url.startsWith("/api/player/cast"))).toBe(false);
  });

  it("générer : entrée temporaire choisie, « préparation » dessinée comme un sous-titre, puis la vraie ligne à sa place", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("gen:fr")).toBeTruthy());
    videoElement(600);
    await act(async () => void fireEvent.click(screen.getByText("gen:fr")));

    await waitFor(() => expect(screen.getByText("st:Français — generating")).toBeTruthy());
    expect(gen.createBodies[0]).toMatchObject({ itemId: "item-1", target: "fr" });
    expect(typeof gen.createBodies[0].position).toBe("number");
    // La langue demandée ne se propose plus.
    expect(screen.queryByText("gen:fr")).toBeNull();
    // Choisie d'emblée : le pipeline n'affiche plus sa propre piste.
    expect(Number(screen.getByTestId("controls").dataset.currentSubtitle)).toBeLessThanOrEqual(-1_000_000);
    expect(remux.selectSubtitleTrack).toHaveBeenCalledWith(null);

    await waitFor(() => expect(gen.pollBodies.length).toBeGreaterThan(0));
    expect(gen.pollBodies[0]).toMatchObject({ since: 0 });
    expect(typeof gen.pollBodies[0].position).toBe("number");
    await waitFor(() => expect(overlay()?.textContent).toBe("preparing"));
    expect(overlay()?.hasAttribute("data-subtitle-notice")).toBe(true);

    // Une ligne arrive pour l'instant affiché : elle remplace le message, qui ne revient pas dessus.
    gen.polls = [{ status: "running", rev: 2, done: 1, total: 10, cues: [{ i: 0, start: 599, end: 602, text: "Ligne traduite" }] }];
    await act(async () => void fireEvent.click(screen.getByText("saut:600")));
    await waitFor(() => expect(overlay()?.textContent).toBe("Ligne traduite"));
    expect(overlay()?.hasAttribute("data-subtitle-notice")).toBe(false);
    await act(async () => void fireEvent(videoElement(600.5), new Event("timeupdate")));
    expect(overlay()?.textContent).toBe("Ligne traduite");

    await waitFor(() => {
      const events = logged().filter((l) => l.kind === "subtitle-gen").map((l) => l.fields.event);
      expect(events).toEqual(expect.arrayContaining(["demande", "activation", "première-ligne"]));
    });
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("en pause : le message dit pourquoi, et la reprise est dans le menu", async () => {
    gen.polls = [{ status: "paused", reason: "budget", rev: 0, done: 3, total: 10, cues: [] }];
    mount();
    await waitFor(() => expect(screen.getByText("gen:fr")).toBeTruthy());
    videoElement(10);
    await act(async () => void fireEvent.click(screen.getByText("gen:fr")));
    await waitFor(() => expect(overlay()?.textContent).toBe("paused"));
    await waitFor(() => expect(screen.getByText("reprendre:fr")).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText("reprendre:fr")));
    await waitFor(() =>
      expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => url === "/api/subtitle-gen/jobs/j1/resume")).toBe(true)
    );
  });

  it("de retour sur le film, l'entrée en cours est là ; la choisir redemande tout depuis 0", async () => {
    gen.options = { ...gen.options, jobs: [{ jobId: "j7", target: "fr", status: "running", done: 40, total: 100 }] };
    gen.polls = [{ status: "running", rev: 5, done: 41, total: 100, cues: [{ i: 0, start: 1, end: 3, text: "Déjà là" }] }];
    mount();
    await waitFor(() => expect(screen.getByText("st:Français — generating")).toBeTruthy());
    expect(screen.getByText("st:Français — generating").getAttribute("data-detail")).toBe("percent");
    videoElement(2);
    await act(async () => void fireEvent.click(screen.getByText("st:Français — generating")));
    await waitFor(() => expect(gen.pollBodies[0]).toMatchObject({ url: "/api/subtitle-gen/jobs/j7/poll", since: 0 }));
    await waitFor(() => expect(overlay()?.textContent).toBe("Déjà là"));

    // Une reconstruction ne perd pas les lignes : elles sont tenues au-dessus du pipeline.
    const rebuilt = fakeRemux();
    nextProbe = () => ({ path: "remux", start: async () => rebuilt, discard: vi.fn() });
    remux.lost = true;
    act(() => probes[0].onError("morte"));
    await waitFor(() => expect(probes).toHaveLength(2));
    await untilSettled(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    expect(rebuilt.selectSubtitleTrack).not.toHaveBeenCalledWith(expect.any(Number));
    await act(async () => void fireEvent(videoElement(2.5), new Event("timeupdate")));
    expect(overlay()?.textContent).toBe("Déjà là");
  });

  it("finie et présentée : bascule sur « généré » au même instant, l'entrée temporaire disparaît", async () => {
    gen.options = { ...gen.options, jobs: [{ jobId: "j1", target: "fr", status: "done", done: 1, total: 1, presented: false }] };
    gen.polls = [{ status: "done", rev: 1, done: 1, total: 1, cues: [{ i: 0, start: 1, end: 2, text: "en mémoire" }], presented: true }];
    gen.externals = [{ id: -3, language: "fra", title: null, url: "/genere.vtt", generated: true }];
    mount();
    await waitFor(() => expect(screen.getByText("st:Français — generating")).toBeTruthy());
    // Finie, pas encore présentée : « finalisation… » au lieu du pourcentage.
    expect(screen.getByText("st:Français — generating").getAttribute("data-detail")).toBe("finalizing");
    videoElement(1.5);
    await act(async () => void fireEvent.click(screen.getByText("st:Français — generating")));

    await waitFor(() => expect(screen.getByText("st:Français — generated")).toBeTruthy());
    expect(screen.queryByText("st:Français — generating")).toBeNull();
    expect(screen.getByTestId("controls").dataset.currentSubtitle).toBe("-3");
    // Le fichier de Jellyfin remplace les lignes en mémoire dès qu'il arrive.
    await waitFor(() => expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => url === "/genere.vtt")).toBe(true));
    await act(async () => void fireEvent(videoElement(1.5), new Event("timeupdate")));
    await waitFor(() => expect(overlay()?.textContent).toBe("fichier final"));
    await waitFor(() =>
      expect(logged().some((l) => l.kind === "subtitle-gen" && l.fields.event === "bascule" && l.fields.via === "jellyfin")).toBe(true)
    );
  });

  it.each([
    [429, "quota"],
    [402, "budget"],
    [422, "noSource"],
  ])("refus %i : un message passager « %s », la lecture continue", async (status, key) => {
    gen.create = { status, body: { error: "x" } };
    mount();
    await waitFor(() => expect(screen.getByText("gen:fr")).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText("gen:fr")));
    await waitFor(() => expect(screen.getByText(key)).toBeTruthy());
    expect(onFallback).not.toHaveBeenCalled();
    expect(remux.destroy).not.toHaveBeenCalled();
    expect(screen.getByTestId("controls").dataset.loading).toBe("false");
    // Toujours proposée : un refus n'est pas une génération en cours.
    expect(screen.getByText("gen:fr")).toBeTruthy();
    expect(screen.queryByText(/generating/)).toBeNull();
  });

  it("choisir une autre piste arrête le sondage et retire le message", async () => {
    mount();
    await waitFor(() => expect(screen.getByText("gen:fr")).toBeTruthy());
    videoElement(600);
    await act(async () => void fireEvent.click(screen.getByText("gen:fr")));
    await waitFor(() => expect(overlay()?.textContent).toBe("preparing"));
    await act(async () => void fireEvent.click(screen.getByText("st:aucun")));
    expect(overlay()).toBeNull();
    const polls = gen.pollBodies.length;
    await act(async () => void fireEvent.click(screen.getByText("saut:600")));
    await settle();
    expect(gen.pollBodies).toHaveLength(polls);
  });

  // « Deux sous-titres » (§87) : le second peut être une génération — même demande, même sondage, ses
  // messages et ses lignes à la place du second ; le principal, une piste du fichier, n'en est pas touché.
  it("générer comme second : l'entrée temporaire devient le second, le principal reste celui du fichier", async () => {
    remux.subtitleAt = vi.fn((_at: number, track?: number) => (track === undefined ? "Bonjour." : null)) as never;
    mount();
    await waitFor(() => expect(screen.getByText(/^st:Français/)).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText(/^st:Français/)));
    await waitFor(() => expect(screen.getByText("gen2:en")).toBeTruthy());
    videoElement(600);
    await act(async () => void fireEvent.click(screen.getByText("gen2:en")));
    expect(gen.createBodies[0]).toMatchObject({ itemId: "item-1", target: "en" });
    await waitFor(() => expect(Number(screen.getByTestId("controls").dataset.currentSecond)).toBeLessThanOrEqual(-1_000_000));
    expect(screen.getByTestId("controls").dataset.currentSubtitle).toBe("5");
    // Le pipeline garde sa piste : la génération ne passe jamais par lui.
    expect(remux.selectSubtitleTrack).not.toHaveBeenCalledWith(null);
    await waitFor(() => expect(gen.pollBodies.length).toBeGreaterThan(0));
    await act(async () => void fireEvent(videoElement(600), new Event("timeupdate")));
    await waitFor(() => expect(document.querySelector("[data-subtitle-second]")?.textContent).toBe("preparing"));
    expect(document.querySelector("[data-subtitle-second]")!.hasAttribute("data-subtitle-notice")).toBe(true);
    expect(document.querySelector("[data-subtitle-primary]")?.textContent).toBe("Bonjour.");

    gen.polls = [{ status: "running", rev: 2, done: 1, total: 10, cues: [{ i: 0, start: 599, end: 602, text: "Translated line" }] }];
    await act(async () => void fireEvent.click(screen.getByText("saut:600")));
    await waitFor(() => expect(document.querySelector("[data-subtitle-second]")?.textContent).toBe("Translated line"));
    expect(document.querySelector("[data-subtitle-primary]")?.textContent).toBe("Bonjour.");
    // Une seule génération à la fois : le second en affiche une, le principal ne s'en voit pas imposer.
    expect(screen.getByTestId("controls").dataset.currentSubtitle).toBe("5");
    expect(onFallback).not.toHaveBeenCalled();
  });
});

// Le lecteur canevas, retiré le 24/09/2026 (docs/lecteur-canvas.md) : ce qui reste de ses tests
// vaut pour le chemin natif — un refus passe au lecteur serveur sans autre essai, et les
// avertissements du pipeline s'affichent puis s'effacent.
// « Améliorer les dialogues » (11/10/2026, bêta ; tous les comptes depuis la v2 du 12/10) : ce que
// l'ouverture demande au pipeline — le réglage retenu sur l'appareil, quel que soit le rôle ; et une
// ouverture qui échoue avec lui repart sans lui, sans passer au lecteur serveur.
describe("améliorer les dialogues — l'ouverture", () => {
  it("un compte qui n'est pas administrateur l'ouvre avec, s'il l'a retenu sur l'appareil", async () => {
    window.localStorage.setItem("cine-dialogue", "strong");
    me = { data: { role: "user" }, error: undefined };
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    expect(probes[0]).toMatchObject({ dialogue: "strong" });
  });

  it("activé, l'ouverture le demande ; désactivé, rien n'est passé", async () => {
    me = { data: { role: "admin" }, error: undefined };
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    expect(probes[0]).not.toHaveProperty("dialogue");
    cleanup();
    probes = [];
    window.localStorage.setItem("cine-dialogue", "on");
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    expect(probes[0]).toMatchObject({ dialogue: "on" });
  });

  it("une ouverture qui échoue avec lui repart une fois sans lui — jamais le lecteur serveur pour ça", async () => {
    window.localStorage.setItem("cine-dialogue", "strong");
    me = { data: { role: "admin" }, error: undefined };
    nextProbe = () => {
      if (probes.length === 1) throw new Error("Aucun chemin de lecture disponible pour ce fichier. remux : encodeur refusé");
      return { path: "remux", start: async () => remux, discard: vi.fn() };
    };
    mount();
    await waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[0]).toMatchObject({ dialogue: "strong" });
    expect(probes[1]).not.toHaveProperty("dialogue");
    expect(onFallback).not.toHaveBeenCalled();
    // Le réglage de l'appareil n'est pas effacé : le film suivant le reprend.
    expect(window.localStorage.getItem("cine-dialogue")).toBe("strong");
  });

  it("sans lui, un échec d'ouverture part au lecteur serveur comme avant", async () => {
    me = { data: { role: "admin" }, error: undefined };
    nextProbe = () => {
      throw new Error("Aucun chemin de lecture disponible pour ce fichier. remux : vidéo V_VP9 non remultiplexable");
    };
    mount();
    await waitFor(() => expect(onFallback).toHaveBeenCalledTimes(1));
    expect(probes).toHaveLength(1);
  });
});

describe("un fichier que le chemin natif ne porte pas", () => {
  it("passe directement au lecteur serveur, avec le motif du refus", async () => {
    nextProbe = () => {
      throw new Error("Aucun chemin de lecture disponible pour ce fichier. remux : vidéo V_VP9 non remultiplexable");
    };
    mount();
    await waitFor(() =>
      expect(onFallback).toHaveBeenCalledWith("Aucun chemin de lecture disponible pour ce fichier. remux : vidéo V_VP9 non remultiplexable")
    );
    // Une seule tentative : plus de second chemin local à essayer avant.
    expect(probes).toHaveLength(1);
    // Et plus de surface à peindre : la seule toile est l'image figée d'un changement de piste.
    expect(document.querySelectorAll("canvas")).toHaveLength(1);
    expect(document.querySelector("canvas")?.getAttribute("aria-hidden")).not.toBeNull();
  });

  it("n'en fait pas une panne quand c'est le réseau qui manque", async () => {
    const { NetworkUnavailable } = await import("@/lib/webcodecs/byteSource");
    nextProbe = () => {
      throw new NetworkUnavailable("Plage inaccessible : Failed to fetch");
    };
    mount();
    await settle();
    await settle();
    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe("les avertissements du pipeline", () => {
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
    act(() => probes[0].onWarning({ code: "noIndexAudio" }));
    await act(async () => void vi.advanceTimersByTime(6100));
    expect(screen.queryByText("noIndexAudio")).toBeNull();

    act(() => probes[0].onWarning({ code: "noIndexAudio" }));
    expect(screen.getByText("noIndexAudio")).toBeTruthy();
    vi.useRealTimers();
  });

  it("n'affiche plus les avertissements du lecteur canevas, retiré", async () => {
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    act(() => probes[0].onWarning({ code: "noSound", detail: "0 bloc décodé" }));
    expect(screen.queryByText("noSound")).toBeNull();
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

  it("dit combien de fois la source a dû se reprendre sur la séance", async () => {
    // Une séance à douze reprises et une séance sans aucune se lisaient pareil au journal.
    remux = fakeRemux({ recoveryFacts: () => ({ recoveries: 7, frozenNudges: 3, escalations: 1 }) });
    const { unmount } = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));

    unmount();

    expect(logged("stop")[0].fields).toMatchObject({ recoveries: 7, frozenNudges: 3, escalations: 1 });
  });

  it("fait tourner la réserve en mémoire avec le lecteur prêt, et l'arrête avec lui", async () => {
    const context = { source: {}, file: {}, video: {}, lead: () => 30, delay: () => 0 };
    remux = fakeRemux({ reserveContext: () => context });
    const { unmount } = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    expect(reserveStart).toHaveBeenCalledTimes(1);
    // Le contexte du lecteur, plus le temps regardé de la séance — la réserve attend une minute.
    expect(reserveStart.mock.calls[0][0]).toMatchObject(context);
    expect(typeof (reserveStart.mock.calls[0][0] as { watched: () => number }).watched()).toBe("number");
    // Ses lignes partent au journal comme celles du lecteur : le fichier, la séance, le chemin.
    const report = reserveStart.mock.calls[0][1] as (fields: Record<string, unknown>) => void;
    report({ event: "point", aheadMB: 120 });
    expect(logged("reserve")[0].fields).toMatchObject({ event: "point", aheadMB: 120, itemId: "item-1", path: "remux" });
    expect(reserveStop).not.toHaveBeenCalled();

    unmount();
    expect(reserveStop).toHaveBeenCalledTimes(1);
  });

  it("garde la réserve à la fin du film — « Revoir » repart sur le même pipeline —, et l'arrête avec lui", async () => {
    // Chasse aux défauts du 28/09 : arrêtée à la fin, elle manquait à tout le second visionnage.
    remux = fakeRemux({ reserveContext: () => ({ source: {}, file: {}, video: {}, lead: () => 30, delay: () => 0 }) });
    const { unmount } = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    await act(async () => void fireEvent(videoElement(5400), new Event("ended")));
    expect(reserveStop).not.toHaveBeenCalled();
    unmount();
    // Arrêtée une fois, avec le pipeline, ses morceaux laissés à la source pour une reconstruction.
    expect(reserveStop).toHaveBeenCalledTimes(1);
    expect(reserveStop).toHaveBeenCalledWith("fin du pipeline", true);
  });

  it("fermé pendant un saut encore en chargement : la position est la cible, pas celle d'avant", async () => {
    // Enquête du 28/09 : la ligne `stop` et Jellyfin recevaient la position d'avant le saut.
    remux = fakeRemux();
    const { unmount } = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const element = videoElement(5400);
    await act(async () => void screen.getByText("saut:600").click());
    Object.defineProperty(element, "seeking", { value: true, configurable: true });
    act(() => void element.dispatchEvent(new Event("seeking")));
    unmount();
    expect(logged("stop")[0].fields.at).toBe(600);
  });

  it("la ligne `stop` d'une fermeture porte ses mesures d'approvisionnement", async () => {
    // Chasse aux défauts du 28/09 : `diagEnd` passait avant l'arrêt au démontage, et la ligne partait sans `diag`.
    remux = fakeRemux();
    const { unmount } = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    unmount();
    expect(logged("stop")[0].fields.diag).toMatchObject({ netMB: expect.any(Number), req: expect.any(Number) });
  });

  it("sans contexte de réserve, pas de réserve — et rien ne casse", async () => {
    remux = fakeRemux();
    const { unmount } = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    expect(reserveStart).not.toHaveBeenCalled();
    unmount();
    expect(logged("stop")).toHaveLength(1);
  });

  it("garde à l'arrêt ce que le lecteur tient en mémoire, pour ce fichier-là", async () => {
    // 28/09/2026 : l'arrêt oubliait tout, et la reprise retéléchargeait plus tard ce qui était là.
    const held = { size: 5e9, lastModified: null, chunks: new Map([[7, new Uint8Array(1)]]) };
    remux = fakeRemux({ heldBytes: () => held });
    swr = { data: info({ sizeBytes: 5e9, fileVersion: "etag-1" }), error: undefined };
    const { unmount } = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));

    unmount();

    expect(keepOnStop).toHaveBeenCalledTimes(1);
    // Sans index du fichier (ce faux lecteur n'en a pas), rien ne dit où est la reprise : `null`.
    expect(keepOnStop).toHaveBeenCalledWith({ itemId: "item-1", streamUrl: "/stream.mkv", size: 5e9, fileVersion: "etag-1" }, held, null);
  });

  it("ne garde rien d'un film fini, et l'arrêt se fait même si la sauvegarde lève", async () => {
    remux = fakeRemux({ heldBytes: () => { throw new Error("mémoire illisible"); } });
    swr = { data: info({ sizeBytes: 5e9, fileVersion: "etag-1" }), error: undefined };
    const first = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    first.unmount();
    expect(logged("stop")).toHaveLength(1);

    remux = fakeRemux({ heldBytes: () => ({ size: 5e9, lastModified: null, chunks: new Map() }) });
    keepOnStop.mockClear();
    const second = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    await act(async () => void fireEvent(videoElement(5400), new Event("ended")));
    second.unmount();
    expect(keepOnStop).not.toHaveBeenCalled();
  });

  it("écrit un blocage que la source signale, avec le fichier et le chemin", async () => {
    // 22/09/2026 : une horloge figée dix-neuf secondes après un saut arrière, et au journal rien
    // d'autre que la ligne `seek` qui l'avait précédée.
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));

    act(() => probes[0].onStall?.({ position: 166.4, recoveries: 3, steps: "+0 ms saut demandé" }));

    const stalls = logged("stall");
    expect(stalls).toHaveLength(1);
    expect(stalls[0].fields).toMatchObject({
      itemId: "item-1",
      path: "remux",
      position: 166.4,
      recoveries: 3,
      steps: "+0 ms saut demandé",
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

  // Une page rendue depuis le cache du navigateur (retour arrière) reprend le film : son arrêt réel,
  // plus tard, doit être noté lui aussi (23/09/2026).
  it("en écrit une seconde quand la page revient du cache du navigateur, puis s'en va", async () => {
    const { unmount } = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));

    act(() => void window.dispatchEvent(new Event("pagehide")));
    const shown = Object.assign(new Event("pageshow"), { persisted: true });
    act(() => void window.dispatchEvent(shown));
    unmount();

    expect(logged("stop").map((line) => line.fields.why)).toEqual(["page", "unmount"]);
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

  /**
   * Le bilan de la séance (23/09/2026) : les attentes d'une à quatre secondes, que la ligne
   * `stall` (cinq secondes) ne voyait pas, les sauts et les changements de piste — et un
   * identifiant de séance sur chaque ligne, pour les recoller sans deviner.
   */
  it("fait le bilan des attentes en pleine lecture, sans compter ni l'ouverture ni les sauts", async () => {
    const { unmount } = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const element = videoElement(600);
    const now = vi.spyOn(Date, "now");
    let t = 1_000_000;
    now.mockImplementation(() => t);

    // Avant la première image : c'est l'ouverture, pas une attente.
    act(() => void element.dispatchEvent(new Event("waiting")));
    t += 3000;
    act(() => void element.dispatchEvent(new Event("playing")));
    // Une vraie attente en pleine lecture : 1,5 s.
    act(() => void element.dispatchEvent(new Event("waiting")));
    t += 1500;
    act(() => void element.dispatchEvent(new Event("playing")));
    // Une attente trop brève pour se voir.
    act(() => void element.dispatchEvent(new Event("waiting")));
    t += 100;
    act(() => void element.dispatchEvent(new Event("playing")));
    // Un saut : son attente est la sienne.
    Object.defineProperty(element, "seeking", { value: true, configurable: true });
    act(() => void element.dispatchEvent(new Event("seeking")));
    act(() => void element.dispatchEvent(new Event("waiting")));
    t += 2000;
    Object.defineProperty(element, "seeking", { value: false, configurable: true });
    act(() => void element.dispatchEvent(new Event("playing")));

    unmount();
    now.mockRestore();

    const stop = logged("stop")[0].fields;
    expect(stop).toMatchObject({ waits: 1, waitedMs: 1500, longestWaitMs: 1500, audioSwitches: 0 });
    expect(typeof stop.session).toBe("string");
    // La même séance sur la ligne d'ouverture.
    expect(logged("start")[0].fields.session).toBe(stop.session);
  });

  /**
   * Le filet d'une page tuée par iOS : le bilan attend sur l'appareil, et s'efface quand l'arrêt
   * part normalement.
   */
  it("garde le bilan sur l'appareil pendant la séance, et l'efface quand l'arrêt part", async () => {
    localStorage.clear();
    const { unmount } = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const kept = () => Object.keys(localStorage).filter((k) => k.startsWith("cine:unsent-stop:"));
    act(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(kept()).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(kept()[0])!).fields.why).toBe("lost");

    unmount();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    expect(kept()).toHaveLength(0);
    expect(logged("stop")).toHaveLength(1);
  });

  it("ne réécrit le bilan que s'il a changé ; caché, il l'écrit exact et entier (13/10/2026)", async () => {
    // Relevé du 13/10/2026 : ~2 Ko et un tri médiane/p90 toutes les 30 s, pour une copie presque
    // jamais lue. En lecture calme : un signe de vie seulement ; au passage en arrière-plan — le
    // dernier instant d'une page qu'iOS va tuer — le bilan exact.
    localStorage.clear();
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    const { unmount } = mount();
    for (let i = 0; i < 50 && screen.queryByTestId("controls")?.dataset.loading !== "false"; i++) {
      await act(async () => void (await vi.advanceTimersByTimeAsync(100)));
    }
    expect(screen.getByTestId("controls").dataset.loading).toBe("false");
    const key = () => Object.keys(localStorage).find((k) => k.startsWith("cine:unsent-stop:"))!;
    const alive = () => Object.keys(localStorage).find((k) => k.startsWith("cine:unsent-stop-alive:"));
    expect(localStorage.getItem(key())).not.toBeNull();
    // Le premier tour réécrit : le lecteur est devenu prêt depuis la copie du montage — un vrai
    // changement, écrit avec des centiles approchés.
    act(() => void vi.advanceTimersByTime(30_000));
    expect(sessionFactsCalls.at(-1)).toEqual({ exact: false });
    const firstWrite = localStorage.getItem(key());
    sessionFactsCalls.length = 0;

    // Rien ne change : deux tours de 30 s, aucun bilan recalculé ni réécrit, un signe de vie posé.
    act(() => void vi.advanceTimersByTime(60_000));
    expect(sessionFactsCalls).toEqual([]);
    expect(localStorage.getItem(key())).toBe(firstWrite);
    expect(alive()).toBeDefined();

    // Arrière-plan : écrit tout de suite, exact, entier.
    act(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(sessionFactsCalls).toEqual([{ exact: true }]);
    const hidden = JSON.parse(localStorage.getItem(key())!).fields;
    expect(hidden).toMatchObject({ why: "lost", session: expect.any(String), backgrounds: 1 });
    expect(typeof hidden.diag).toBe("object");

    // De retour cinq secondes plus tard : le bilan a changé (l'absence est finie) — réécrit au tour
    // suivant, avec des centiles approchés.
    act(() => void vi.advanceTimersByTime(5_000));
    act(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    act(() => void vi.advanceTimersByTime(30_000));
    expect(sessionFactsCalls.at(-1)).toEqual({ exact: false });
    expect(JSON.parse(localStorage.getItem(key())!).fields).toMatchObject({ why: "lost", backgrounds: 1, backgroundMs: 5_000 });

    unmount();
    vi.useRealTimers();
    expect(Object.keys(localStorage).filter((k) => k.startsWith("cine:unsent-stop"))).toEqual([]);
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

describe("relu le 22/09/2026", () => {
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

  /**
   * Relu le 23/09/2026 : sous l'écran de fin, le clavier se tait.
   *
   * La barre d'espace y relançait le film par-dessous sans rouvrir la séance que la fin avait
   * close ; « Revoir » le fait, et c'est le seul chemin.
   */
  it("suspend le clavier sous l'écran de fin, et « Revoir » rouvre la séance", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    await act(async () => void fireEvent(videoElement(10), new Event("play")));
    expect(screen.getByTestId("controls").dataset.suspended).toBe("false");
    await act(async () => void fireEvent(videoElement(5400), new Event("ended")));
    await waitFor(() => expect(screen.getByTestId("controls").dataset.suspended).toBe("true"));

    await act(async () => void fireEvent.click(screen.getByText("revoir")));
    expect(resumePlaybackSession).toHaveBeenCalled();
  });

  it("« Revoir » rejoue le film depuis le début", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    await act(async () => void fireEvent(videoElement(5400), new Event("ended")));
    const element = videoElement(5400);
    (HTMLMediaElement.prototype.play as ReturnType<typeof vi.fn>).mockClear();

    await act(async () => void fireEvent.click(screen.getByText("revoir")));

    expect(element.currentTime).toBe(0);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
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
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    // Hors du type exprès : c'est ce qui arriverait d'une version plus ancienne du pipeline.
    act(() => probes[0].onWarning("une phrase nue d'une ancienne version" as never));
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

  it("oublie la cible demandée quand la source dit le saut arrivé, même ailleurs qu'elle", async () => {
    // Audit du 22/09/2026 : la source peut poser la tête plus loin que la cible — sur le premier
    // média, sur l'image clé suivante. La cible de l'hôte restait alors en mémoire, et un
    // changement de piste vingt minutes plus tard reconstruisait le lecteur à l'ancienne cible.
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    Object.assign(remux, { seekPending: false });
    const element = videoElement(120);
    await act(async () => void fireEvent(element, new Event("timeupdate")));
    await act(async () => void fireEvent.click(screen.getByText("saut:600")));
    // Posée 12 s plus loin que demandé, et la source considère le saut arrivé.
    element.currentTime = 612;
    await act(async () => void fireEvent(element, new Event("seeked")));
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    element.currentTime = 1800;
    await act(async () => void fireEvent(element, new Event("timeupdate")));

    rebuildOn(2);
    await act(async () => void fireEvent.click(screen.getByText(/^audio:Anglais/)));
    await waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[1].startSeconds).toBeCloseTo(1800, 1);
  });

  it("écrit un saut remplacé par le suivant comme remplacé, et arrivé s'il était à sa cible", async () => {
    // Une rafale remplace chaque saut 30 ms plus tard : 125 lignes sur 128 « jamais arrivé » à
    // tort le 22/09/2026, et le banc comptait ces films comme éprouvés.
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const element = videoElement(120);
    await act(async () => void fireEvent(element, new Event("timeupdate")));
    await act(async () => void fireEvent.click(screen.getByText("saut:600")));
    element.currentTime = 600;
    await act(async () => void fireEvent.click(screen.getByText("saut:600")));

    const seeks = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === "/api/player/log")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
      .filter((entry) => entry.kind === "seek");
    expect(seeks[0].fields).toMatchObject({ to: 600, arrived: true, superseded: true });
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

  /** Un navigateur et un écran : ce qui décide si le réglage de luminosité HDR a un sens. */
  const onScreen = (userAgent: string, hdrDisplay: boolean) => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("dynamic-range") ? hdrDisplay : false }));
  };
  const CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  const HDR_FILM = { video: { codec: "hevc", width: 3840, height: 1600, bitDepth: 10, isHdr: true, rangeType: "HDR10" } };

  it("propose la luminosité HDR sur Chrome Windows écran SDR, en Auto à 203 nits, et un choix rouvre au même endroit", async () => {
    // 22/09/2026 : 203 nits, le blanc de référence de Chrome sur écran SDR, s'est montré le plus
    // fidèle à l'œil ; il devient la valeur d'office, le menu restant là pour comparer.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    onScreen(CHROME_WINDOWS, false);
    swr = { data: info(HDR_FILM), error: undefined };
    mount();
    await waitFor(() => expect(screen.getByText("hdr:auto:203")).toBeTruthy());
    await act(async () => void fireEvent(videoElement(420), new Event("timeupdate")));

    rebuildOn(1);
    await act(async () => void fireEvent.click(screen.getByText("hdr:auto:203")));
    await waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[1].startSeconds).toBeCloseTo(420, 1);
    expect(store.get("cine.hdrLightCap")).toBe("150");
    await waitFor(() => expect(screen.getByText("hdr:150:203")).toBeTruthy());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("garde la pause quand on change la luminosité HDR d'un film à l'arrêt", async () => {
    // Chasse aux bugs du 22/09/2026 : changer le plafond reconstruisait le lecteur sans dire que le
    // film était en pause — il repartait tout seul, sur un écran passé au noir.
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    onScreen(CHROME_WINDOWS, false);
    swr = { data: info(HDR_FILM), error: undefined };
    mount();
    await waitFor(() => expect(screen.getByText("hdr:auto:203")).toBeTruthy());
    const element = videoElement(420);
    Object.defineProperty(element, "paused", { value: true, configurable: true });
    await act(async () => void fireEvent(element, new Event("timeupdate")));

    rebuildOn(1);
    await act(async () => void fireEvent.click(screen.getByText("hdr:auto:203")));
    await waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[1]).toMatchObject({ startPaused: true });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("ne propose pas la luminosité HDR sous WebKit ni sur un écran HDR", async () => {
    swr = { data: info(HDR_FILM), error: undefined };
    onScreen("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1", false);
    const first = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    expect(screen.queryByText(/^hdr:/)).toBeNull();
    first.unmount();

    onScreen(CHROME_WINDOWS, true);
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    expect(screen.queryByText(/^hdr:/)).toBeNull();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("ne propose pas de plafond HDR sur un film SDR", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    expect(screen.queryByText(/^hdr:/)).toBeNull();
  });

  it("écrit aussi le saut qui n'est jamais arrivé, quand un autre le remplace", async () => {
    // 22/09/2026, 2012 sur iPhone : un saut à 2141 s, puis vingt-sept secondes plus tard une
    // tête à 1681 s dont rien au journal ne disait comment elle y était venue. Un saut qui
    // n'atteignait jamais sa cible n'était tout simplement pas écrit.
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const element = videoElement(120);
    await act(async () => void fireEvent(element, new Event("timeupdate")));
    await act(async () => void fireEvent.click(screen.getByText("saut:600")));
    // Arrivé ailleurs.
    element.currentTime = 480;
    await act(async () => void fireEvent(element, new Event("seeked")));
    await act(async () => void fireEvent(element, new Event("timeupdate")));
    await act(async () => void fireEvent.click(screen.getByText("saut:600")));

    const seeks = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === "/api/player/log")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
      .filter((entry) => entry.kind === "seek");
    expect(seeks).toHaveLength(1);
    expect(seeks[0].fields).toMatchObject({ from: 120, to: 600, arrived: false, landedAt: 480 });
  });

  it("joint au saut ce que la source a fait pour le servir", async () => {
    // 22/09/2026 : « de 176 à 166 en 900 ms », puis un blocage — et rien pour dire comment le saut
    // avait été servi. La ligne porte désormais les étapes de la trace depuis la demande.
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const element = videoElement(120);
    await act(async () => void fireEvent(element, new Event("timeupdate")));
    await act(async () => void fireEvent.click(screen.getByText("saut:600")));
    recentSteps = ["+0 ms saut demandé vers 600.0 s", "+412 ms segment 1 construit"];
    element.currentTime = 600;
    await act(async () => void fireEvent(element, new Event("seeked")));

    const seek = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === "/api/player/log")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
      .find((entry) => entry.kind === "seek");
    expect(seek?.fields.steps).toBe("+0 ms saut demandé vers 600.0 s | +412 ms segment 1 construit");
  });

  it("ne dit pas arrivé ou non un saut remplacé pendant que l'élément cherche encore", async () => {
    // Pendant `seeking`, currentTime vaut déjà la cible : « arrivé » n'y voulait rien dire, et un
    // saut remplacé en plein chargement se lisait arrivé. L'endroit reste, le verdict part.
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const element = videoElement(120);
    await act(async () => void fireEvent(element, new Event("timeupdate")));
    await act(async () => void fireEvent.click(screen.getByText("saut:600")));
    element.currentTime = 600;
    Object.defineProperty(element, "seeking", { value: true, configurable: true });
    await act(async () => void fireEvent.click(screen.getByText("saut:600")));

    const seeks = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === "/api/player/log")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
      .filter((entry) => entry.kind === "seek");
    expect(seeks).toHaveLength(1);
    expect(seeks[0].fields).toMatchObject({ to: 600, superseded: true, landedAt: 600 });
    expect(seeks[0].fields).not.toHaveProperty("arrived");
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

describe("ce que la fiche a préparé avant Lire", () => {
  beforeEach(async () => {
    const { forgetPrefetchedPlaybackState } = await import("@/lib/playbackPrefetch");
    forgetPrefetchedPlaybackState();
  });

  const playbackStateCalls = () =>
    (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      ([url]) => typeof url === "string" && url.startsWith("/api/jellyfin/playback-state/")
    ).length;

  it("ouvre le flux avec la taille que la description du fichier porte déjà", async () => {
    // Sans elle, l'ouverture demandait la taille par un HEAD : un aller-retour entier avant la
    // première plage, depuis un serveur lointain.
    swr = { data: info({ sizeBytes: 7_340_032 }), error: undefined };
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    expect(probes[0]).toMatchObject({ knownSize: 7_340_032 });
  });

  it("prend l'état du spectateur que la fiche a demandé, sans le redemander", async () => {
    const { prefetchPlaybackState } = await import("@/lib/playbackPrefetch");
    viewerState = { resumeSeconds: 42, preferences: null };
    prefetchPlaybackState("item-1");
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    expect(probes[0].startSeconds).toBe(42);
    expect(playbackStateCalls()).toBe(1);
  });

  // Relecture du 14/10/2026 (§92) : la route répondait 0 quand Jellyfin était injoignable, le film
  // s'ouvrait au début, et ses rapports effaçaient la reprise. Un 502 nommé = position inconnue.
  it("position inconnue (Jellyfin muet) et rien d'affirmé : n'ouvre pas au début, le dit", async () => {
    const unknownState = () => ({ ok: false, status: 502, json: async () => ({ code: "upstream_unreachable" }) });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => (typeof url === "string" && url.startsWith("/api/jellyfin/playback-state/") ? unknownState() : { ok: true, text: async () => "" }))
    );
    mount();
    await waitFor(() => expect(screen.getByText("libraryUnreachable")).toBeTruthy());
    expect(probes).toHaveLength(0);
  });

  it("position inconnue mais affirmée par l'appelant : ouvre là où il l'a dit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        typeof url === "string" && url.startsWith("/api/jellyfin/playback-state/")
          ? { ok: false, status: 502, json: async () => ({ code: "upstream_unreachable" }) }
          : { ok: true, text: async () => "" }
      )
    );
    mount({ resumeAt: 30 });
    await waitFor(() => expect(probes).toHaveLength(1));
    expect(probes[0].startSeconds).toBe(30);
  });

  it("repose la question pour un autre titre que celui de la fiche", async () => {
    const { prefetchPlaybackState } = await import("@/lib/playbackPrefetch");
    prefetchPlaybackState("item-2");
    mount({ itemId: "item-1" });
    await waitFor(() => expect(probes).toHaveLength(1));
    expect(playbackStateCalls()).toBe(2);
  });
});

// Chasse aux bugs du 24/09/2026 : la fin d'une lecture, et ce qui vient après.
describe("après la fin", () => {
  // Un épisode reste jouable après sa fin (la carte de l'épisode suivant écartée) : la seconde
  // lecture doit rouvrir la séance que la fin avait close, sans quoi rien n'était plus enregistré.
  it("rouvre la séance quand la lecture reprend après la fin", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    await act(async () => void fireEvent(videoElement(10), new Event("play")));
    expect(resumePlaybackSession).not.toHaveBeenCalled();

    await act(async () => void fireEvent(videoElement(5400), new Event("ended")));
    expect(stopPlaybackNow).toHaveBeenCalled();
    await act(async () => void fireEvent(videoElement(0), new Event("play")));
    expect(resumePlaybackSession).toHaveBeenCalledTimes(1);
    // Une fois : une pause puis une reprise ne rouvrent rien de plus.
    await act(async () => void fireEvent(videoElement(20), new Event("play")));
    expect(resumePlaybackSession).toHaveBeenCalledTimes(1);
  });
});

// L'ancien fichier restait affiché pendant le chargement du nouveau, et pour de bon si celui-ci
// échouait — du français sous un menu qui disait anglais.
describe("passer d'un fichier de sous-titres à un autre", () => {
  it("retire le premier sans attendre le second", async () => {
    swr = {
      data: info({
        externalSubtitles: [
          { id: -1, language: "fra", title: "Français", url: "/fr.vtt" },
          { id: -2, language: "eng", title: "English", url: "/en.vtt" },
        ],
      }),
      error: undefined,
    };
    stubFetch((url) =>
      url === "/fr.vtt" ? { ok: true, text: async () => "WEBVTT\n\n00:00:01.000 --> 00:00:09.000\nBonjour." } : { ok: false, status: 404 }
    );
    mount();
    await waitFor(() => expect(screen.getByText(/^st:Français.*\(external\)/)).toBeTruthy());
    await act(async () => void fireEvent.click(screen.getByText(/^st:Français.*\(external\)/)));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/fr.vtt", expect.anything()));
    await act(async () => void fireEvent(videoElement(2), new Event("timeupdate")));
    await waitFor(() => expect(screen.getByText("Bonjour.")).toBeTruthy());

    // Seule du fichier dans sa langue, son étiquette ne porte pas de précision (voir trackLabel).
    await act(async () => void fireEvent.click(screen.getByText(/^st:Anglais/)));
    await waitFor(() => expect(screen.getByText("externalSubtitlesUnavailable")).toBeTruthy());
    await act(async () => void fireEvent(videoElement(3), new Event("timeupdate")));
    expect(screen.queryByText("Bonjour.")).toBeNull();
    vi.unstubAllGlobals();
  });
});

// Un film fini dont iOS ferme la source en arrière-plan : au retour, il ne rejoue pas sa fin.
describe("retour d'arrière-plan sur l'écran de fin", () => {
  it("reconstruit à l'arrêt", async () => {
    const setVisibility = (state: "visible" | "hidden") => {
      Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    await act(async () => void fireEvent(videoElement(5400), new Event("ended")));
    act(() => setVisibility("hidden"));
    remux.lost = true;
    remux.position = 5400;
    act(() => setVisibility("visible"));
    await waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[1]).toMatchObject({ startPaused: true });
  });
});

// Reprendre quelques secondes avant (24/09/2026) : le lendemain, ou après une longue pause.
describe("reprendre quelques secondes avant", () => {
  it("recule de 5 s un titre qu'on n'a pas joué récemment sur cet appareil", async () => {
    window.localStorage.removeItem("cine:last-watched");
    mount({ resumeAt: 1200 });
    await waitFor(() => expect(probes).toHaveLength(1));
    expect(probes[0].startSeconds).toBe(1195);
  });

  it("ne recule pas un relais, arrivé juste après la dernière image", async () => {
    mount({ resumeAt: 1200 });
    await waitFor(() => expect(probes).toHaveLength(1));
    expect(probes[0].startSeconds).toBe(1200);
  });

  it("ne recule ni « depuis le début », ni une reconstruction", async () => {
    window.localStorage.removeItem("cine:last-watched");
    mount({ resumeAt: 0 });
    await waitFor(() => expect(probes).toHaveLength(1));
    expect(probes[0].startSeconds).toBe(0);
    await act(async () => void fireEvent(videoElement(600), new Event("timeupdate")));
    remux.lost = true;
    remux.position = 600;
    act(() => probes[0].onError("morte"));
    await waitFor(() => expect(probes).toHaveLength(2));
    expect(probes[1].startSeconds).toBeCloseTo(600, 1);
  });

  it("recule de 5 s après une pause de plus de dix minutes", async () => {
    mount({ resumeAt: 1200 });
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const now = vi.spyOn(Date, "now");
    let t = 7_000_000;
    now.mockImplementation(() => t);
    const element = videoElement(1300);
    await act(async () => void fireEvent(element, new Event("pause")));
    t += 11 * 60_000;
    await act(async () => void fireEvent(element, new Event("play")));
    now.mockRestore();
    expect(element.currentTime).toBe(1295);
  });

  it("ne recule pas après une courte pause", async () => {
    mount({ resumeAt: 1200 });
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const element = videoElement(1300);
    await act(async () => void fireEvent(element, new Event("pause")));
    await act(async () => void fireEvent(element, new Event("play")));
    expect(element.currentTime).toBe(1300);
  });
});


// Relus le 24/09/2026 au soir.
describe("une reconstruction et ce qu'elle doit garder", () => {
  const playerLines = (kind: string) =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === "/api/player/log")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
      .filter((entry) => entry.kind === kind);

  it("ne relance pas un film que le spectateur avait mis en pause", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    await act(async () => void fireEvent(videoElement(300), new Event("play")));
    await act(async () => void fireEvent(videoElement(300), new Event("pause")));
    remux.lost = true;
    act(() => probes[0].onError("morte"));
    await waitFor(() => expect(probes).toHaveLength(2));
    expect((probes[1] as unknown as { startPaused: boolean }).startPaused).toBe(true);
  });

  it("relance un film qui jouait", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    await act(async () => void fireEvent(videoElement(300), new Event("play")));
    remux.lost = true;
    act(() => probes[0].onError("morte"));
    await waitFor(() => expect(probes).toHaveLength(2));
    expect((probes[1] as unknown as { startPaused: boolean }).startPaused).toBe(false);
  });

  it("écrit le chemin sur chaque reconstruction", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    remux.lost = true;
    act(() => probes[0].onError("morte"));
    await waitFor(() => expect(playerLines("rebuild")).toHaveLength(1));
    expect(playerLines("rebuild")[0].fields.path).toBe("remux");
  });

  it("suspend le clavier sous l'écran « connexion perdue »", async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.suspended).toBe("false"));
    act(() => probes[0].onError("Plage inaccessible", "network"));
    await waitFor(() => expect(screen.getByTestId("controls").dataset.suspended).toBe("true"));
  });
});

// ------------------------------------------------------------------------------------------------
// Le cycle de vie, figé tel qu'il est (docs/cycle-de-vie-lecteur.md).
//
// Ces tests décrivent ce que fait l'hôte aujourd'hui aux croisements que la carte relève — y
// compris là où ce n'est pas ce qu'on voudrait. Ils sont le filet du découpage en machine à états :
// déplacer une décision sans en changer le comportement doit les laisser verts. Ceux qui décrivent
// un point fragile le disent (« comportement actuel, point n ») : le jour où ce point est corrigé,
// le test est inversé exprès, dans le même commit que la correction.
// ------------------------------------------------------------------------------------------------

describe("cycle de vie — comportement figé", () => {
  const logged = (kind: string) =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === "/api/player/log")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
      .filter((entry) => entry.kind === kind);
  const setVisibility = (state: "visible" | "hidden") => {
    Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  const ready = () => waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));

  it("ne passe la main qu'une fois, même pour deux pannes", async () => {
    serverFallback = true;
    mount();
    await ready();
    act(() => probes[0].onError("première panne"));
    act(() => probes[0].onError("seconde panne"));
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0]).toBe("première panne");
    expect(logged("fallback")).toHaveLength(1);
  });

  it("une reconstruction ratée faute de réseau rouvre, au nouvel essai, là où elle devait rouvrir", async () => {
    mount();
    await ready();
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    remux.lost = true;
    remux.position = 1500;
    // La reconstruction ne s'ouvre pas : le réseau manque.
    nextProbe = () => {
      throw Object.assign(new Error("Failed to fetch"), { network: true });
    };
    act(() => probes[0].onError("source perdue"));
    await waitFor(() => expect(screen.getByText("connectionLost")).toBeTruthy());

    remux = fakeRemux();
    nextProbe = () => ({ path: "remux", start: async () => remux, discard: vi.fn() });
    Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /retry/ })));
    await waitFor(() => expect(probes).toHaveLength(3));
    expect(probes[2].startSeconds).toBeCloseTo(1500, 1);
  });

  // Point 2, corrigé : le retour d'arrière-plan sur l'écran de fin reconstruisait déjà à l'arrêt
  // (test « retour d'arrière-plan sur l'écran de fin ») ; une source perdue *sans* passage en
  // arrière-plan, sur ce même écran, était reconstruite en lecture — le film rejouait sa fin.
  it("point 2 : une source perdue sur l'écran de fin reconstruit à l'arrêt", async () => {
    mount();
    await ready();
    await act(async () => void fireEvent(videoElement(5400), new Event("ended")));
    remux.lost = true;
    remux.position = 5400;
    act(() => probes[0].onError("source perdue"));
    await waitFor(() => expect(probes).toHaveLength(2));
    expect((probes[1] as unknown as { startPaused?: boolean }).startPaused).toBe(true);
  });

  // Point 4, corrigé : sans lecteur serveur, un abandon affiche son erreur — et un retour
  // d'arrière-plan qui trouvait la source fermée reconstruisait quand même, effaçant l'erreur et
  // relançant un film abandonné.
  it("point 4 : sans lecteur serveur, un abandon reste un abandon au retour d'arrière-plan", async () => {
    serverFallback = false;
    mount();
    await ready();
    act(() => probes[0].onError("panne du décodeur"));
    await waitFor(() => expect(screen.getByText(/panne du décodeur/)).toBeTruthy());
    expect(onFallback).not.toHaveBeenCalled();

    act(() => setVisibility("hidden"));
    remux.lost = true;
    remux.position = 300;
    act(() => setVisibility("visible"));
    // Les deux vérifications du retour (tout de suite, puis 400 ms après) : aucune ne reconstruit.
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 500))));
    expect(probes).toHaveLength(1);
    expect(screen.getByText(/panne du décodeur/)).toBeTruthy();
  });

  // Point 5, corrigé : une panne qui tombait dans les 200 ms du fondu passait encore la main au
  // lecteur serveur, après la ligne `stop` — et rangeait le film parmi ceux que le natif ne lit pas.
  it("point 5 : une panne pendant le fondu de fermeture ne passe plus la main", async () => {
    serverFallback = true;
    mount();
    await ready();
    act(() => void fireEvent.click(screen.getByText("fermer")));
    expect(logged("stop")).toHaveLength(1);
    act(() => probes[0].onError("panne tardive"));
    expect(onFallback).not.toHaveBeenCalled();
    expect(logged("fallback")).toHaveLength(0);
    // Ni reconstruction : la source perdue pendant le fondu n'a plus de lecteur à relancer.
    remux.lost = true;
    act(() => probes[0].onError("source perdue pendant le fondu"));
    expect(probes).toHaveLength(1);
  });

  // Voulu (ex-point 14) : une coupure réseau signalée pendant l'attache, puis l'attache qui aboutit
  // quand même — l'écran « connexion perdue » reste, et c'est juste. Le moteur ne signale une
  // coupure qu'une fois sa boucle de lecture arrêtée : le lecteur « prêt » ne lira plus rien, et
  // c'est cet écran qui programme le nouvel essai. L'effacer figeait le film sans écran ni relance
  // (relevé par la relecture du 27/09/2026).
  it("une coupure signalée pendant l'attache garde son écran, ne joue pas derrière, et relance au retour du réseau", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    nextProbe = () => ({
      path: "remux",
      start: async () => {
        probes[probes.length - 1].onError("coupure pendant l'attache", "network");
        return remux;
      },
      discard: vi.fn(),
    });
    mount({ resumeAt: 600 });
    await waitFor(() => expect(logged("start")).toHaveLength(1));
    expect(screen.getByText("connectionLost")).toBeTruthy();
    // Ce qui est en tampon ne joue pas derrière l'écran : le nouvel essai rouvrira à 600 s, et ces
    // secondes seraient entendues deux fois.
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();

    remux = fakeRemux();
    nextProbe = () => ({ path: "remux", start: async () => remux, discard: vi.fn() });
    Object.defineProperty(navigator, "onLine", { value: true, writable: true, configurable: true });
    act(() => void window.dispatchEvent(new Event("online")));
    await waitFor(() => expect(probes).toHaveLength(2), { timeout: 3000 });
    expect(probes[1].startSeconds).toBeCloseTo(600, 1);
  });

  // Sans lecteur serveur, un abandon pendant l'écran de coupure : l'erreur remplace l'écran, qui
  // promettait sinon une reprise qui ne viendrait plus.
  it("un abandon pendant l'écran de coupure montre l'erreur, sans lecteur serveur", async () => {
    serverFallback = false;
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    mount();
    await ready();
    act(() => probes[0].onError("plus de réseau", "network"));
    expect(screen.getByText("connectionLost")).toBeTruthy();
    act(() => probes[0].onError("panne du décodeur"));
    await waitFor(() => expect(screen.getByText(/panne du décodeur/)).toBeTruthy());
    expect(screen.queryByText("connectionLost")).toBeNull();
  });

  // Un pipeline lent qui aboutit après l'abandon, sans lecteur serveur : il se déclarait prêt et
  // lançait le son sous l'écran d'erreur.
  it("un pipeline qui aboutit après l'abandon est jeté, sans jouer", async () => {
    serverFallback = false;
    let open: () => void = () => {};
    const late = fakeRemux();
    nextProbe = () => ({ path: "remux", start: () => new Promise((resolve) => (open = () => resolve(late))), discard: vi.fn() });
    mount();
    await waitFor(() => expect(probes).toHaveLength(1));
    act(() => probes[0].onError("panne avant la première image"));
    await act(async () => open());
    expect(late.destroy).toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(logged("start")).toHaveLength(0);
  });

  // Relu le 27/09/2026 : le contrôle ne se faisait qu'en armant le nouvel essai. Armé avant la
  // fermeture, il partait quand même pendant le fondu et reconstruisait un lecteur qui se fermait.
  it("un nouvel essai réseau armé avant la fermeture ne relance rien pendant le fondu", async () => {
    vi.useFakeTimers();
    mount();
    await act(async () => {});
    act(() => probes[0].onError("plus de réseau", "network"));
    // En ligne : l'essai est armé (0,8 s).
    act(() => void window.dispatchEvent(new Event("online")));
    act(() => void fireEvent.click(screen.getByText("fermer")));
    await act(async () => void vi.advanceTimersByTime(2_000));
    expect(probes).toHaveLength(1);
    vi.useRealTimers();
  });

  it("la fermeture rapporte l'arrêt une fois, à Jellyfin et au journal, puis se referme", async () => {
    mount();
    await ready();
    await act(async () => void fireEvent(videoElement(900), new Event("timeupdate")));
    act(() => void fireEvent.click(screen.getByText("fermer")));
    act(() => void fireEvent.click(screen.getByText("fermer")));
    expect(logged("stop")).toHaveLength(1);
    expect(logged("stop")[0].fields).toMatchObject({ why: "close", at: 900 });
    expect(stopPlaybackNow).toHaveBeenCalled();
  });

  // Les temps d'une ouverture qui n'aboutit pas : « chargement », puis à 8 s le mot qui dit qu'on
  // cherche encore, à 20 s la proposition de signaler, et la main passée à 35 s.
  it("une ouverture sans image : le mot à 8 s, le signalement à 20 s, la main passée à 35 s", async () => {
    vi.useFakeTimers();
    serverFallback = true;
    nextProbe = () => new Promise(() => {}) as never;
    mount();
    await act(async () => void vi.advanceTimersByTime(7_000));
    expect(screen.queryByText(/stillWorking/)).toBeNull();
    expect(screen.queryByTestId("report")).toBeNull();
    await act(async () => void vi.advanceTimersByTime(2_000));
    expect(screen.getByText(/stillWorking/)).toBeTruthy();
    expect(screen.queryByTestId("report")).toBeNull();
    await act(async () => void vi.advanceTimersByTime(12_000));
    expect(screen.getByTestId("report")).toBeTruthy();
    expect(onFallback).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(15_000));
    expect(onFallback).toHaveBeenCalledWith(expect.stringContaining("aucune image"));
    vi.useRealTimers();
  });

  // Point 13 : l'effet du pipeline dépend de dix-sept identités censées rester stables après leur
  // première valeur. Une seule qui change reconstruit tout le lecteur, sans passer par `restart`.
  // Le parent se redessine pour mille raisons — un nouveau rappel à chaque fois, comme le fait
  // `player()` — et le lecteur ne doit jamais s'en apercevoir.
  it("se redessiner avec la même séance ne reconstruit rien, ni ne réécrit de ligne `start`", async () => {
    const { rerender } = mount();
    await ready();
    for (let i = 0; i < 5; i++) rerender(player());
    await settle();
    expect(probes).toHaveLength(1);
    expect(logged("start")).toHaveLength(1);
    expect(logged("stop")).toHaveLength(0);
  });

  // Le croisement « changement de piste pendant une reconstruction » existe dans le code
  // (`wantedAudioRef` le garde pour le pipeline suivant), mais l'écran ne le permet pas : le menu
  // des pistes n'est plus proposé tant que le lecteur se reconstruit. Seuls le banc ou une touche
  // média pourraient y arriver.
  it("pendant une reconstruction, le menu des pistes n'est plus proposé ; il revient avec le lecteur", async () => {
    swr = { data: info({ audio: [{ index: 1 }, { index: 2 }] }), error: undefined };
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    let open: () => void = () => {};
    const rebuilt = fakeRemux();
    nextProbe = () => ({
      path: "remux",
      start: () => new Promise((resolve) => (open = () => resolve(rebuilt))),
      discard: vi.fn(),
    });
    remux.lost = true;
    remux.position = 200;
    act(() => probes[0].onError("source perdue"));
    await waitFor(() => expect(probes).toHaveLength(2));
    expect(screen.queryByText(/^audio:Anglais/)).toBeNull();

    await act(async () => open());
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
  });
});

describe("l'ouverture de la lecture : entière dès l'appui (DECISIONS §60)", () => {
  const layer = () => document.querySelector("[data-playback-intro]");
  // L'horloge vit hors de React, par `${openId}:${itemId}` — la même clé pour tous les tests de ce
  // fichier, que les précédents ont close.
  beforeEach(() => resetIntroClocks());

  it("couvre le lecteur dès le premier rendu, logo et ligne de chargement compris", () => {
    // Vu par Louis le 10/10/2026 : « un micro instant le player » avant l'ouverture ; puis, sous le
    // seuil de 300 ms, une couverture immobile qui se lisait comme une image figée (8.31.2).
    mount();
    expect(layer()?.getAttribute("data-playback-intro")).toBe("intro");
    expect(document.querySelector("[data-playback-intro-line]")).not.toBeNull();
  });

  it("une image décodée qui ne part pas : l'ouverture tient, puis s'efface au bout de la garde, et ne reparaît pas", async () => {
    // jsdom ne joue rien : l'horloge ne part jamais. La première image (`announced`) ne retire pas
    // l'ouverture — elle tient jusqu'au film qui bouge —, mais une image figée au-delà de
    // `COVER_HOLD_MS` est un vrai blocage qui doit se voir.
    // Sur une horloge factice : la garde (1,2 s), le fondu et la vérification d'après, attendus en
    // temps réel, faisaient près de deux secondes d'attente — au-delà des 5 s sous la charge de
    // plusieurs suites en parallèle (10/10/2026).
    // Avancée par pas : chaque étape (image montrée, garde, fondu) arme la suivante au rendu d'après.
    vi.useFakeTimers();
    const advance = async (ms: number) => {
      for (let t = 0; t < ms; t += 50) await act(async () => void vi.advanceTimersByTime(50));
    };
    try {
      mount();
      await advance(50);
      expect(screen.getByTestId("controls")).toBeTruthy();
      expect(layer()?.getAttribute("data-playback-intro")).toBe("intro");
      await advance(2_500);
      expect(layer()).toBeNull();
      await advance(400);
      expect(layer()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("un AAC à PCE refusé pendant l'ouverture", () => {
  // L'iPhone de Louis, 11/10/2026 (« Elle s'appelle Ruby », `path: "non décidé"`) : le segment
  // d'initialisation à PCE copié tel quel est refusé pendant le choix du chemin, avant tout pipeline.
  // Le refus n'arrivait jamais au `onError` : le film partait au lecteur serveur sans la reconstruction
  // décodée prévue (DECISIONS.md §62).
  it("reconstruit une fois en décodant, au lieu de passer au lecteur serveur", async () => {
    const { notePceDecision, PROBE_ASC, __testing } = await import("@/lib/webcodecs/aacPceProbe");
    __testing.reset();
    serverFallback = true;
    let attempts = 0;
    nextProbe = () => {
      attempts++;
      if (attempts === 1) {
        // Le remultiplexeur a noté la copie telle quelle, puis l'envoi a été refusé.
        notePceDecision("copy", true, PROBE_ASC);
        throw new Error("Le navigateur a refusé une opération sur le tampon. (MediaSource closed, élément code 4, readyState 0, réseau 3)");
      }
      return { path: "remux", start: async () => remux, discard: vi.fn() };
    };
    mount();
    await untilSettled(() => expect(probes.length).toBe(2));
    expect(onFallback).not.toHaveBeenCalled();
    window.localStorage.clear();
    __testing.reset();
  });

  it("une erreur d'ouverture ordinaire passe toujours au lecteur serveur, sans reconstruction", async () => {
    const { __testing } = await import("@/lib/webcodecs/aacPceProbe");
    __testing.reset();
    serverFallback = true;
    nextProbe = () => {
      throw new Error("Aucun chemin de lecture disponible pour ce fichier. remux : Vidéo non prise en charge");
    };
    mount();
    await untilSettled(() => expect(onFallback).toHaveBeenCalled());
    expect(probes.length).toBe(1);
  });
});

/**
 * Le Chromecast (DECISIONS.md §64), sur un kit simulé : le bouton n'existe que pour un navigateur
 * qui sait émettre et un compte qui y a droit, et le choix d'un récepteur passe la main comme une
 * diffusion AirPlay — `cast: true` —, marquée `castTarget: "chromecast"`.
 */
describe("le Chromecast", () => {
  const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  const castAnswer = (allowed: boolean) => (url: string) =>
    url === "/api/player/cast" ? { ok: true, json: async () => ({ allowed, receiverAppId: "CC1AD845" }) } : { ok: true, text: async () => "" };

  beforeEach(async () => {
    const { resetChromecastForTests } = await import("@/lib/chromecast/framework");
    resetChromecastForTests();
    serverFallback = true;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as { cast?: unknown }).cast;
    delete (window as unknown as { chrome?: unknown }).chrome;
  });

  it("hors Chrome (ici jsdom) : aucun bouton, et rien n'est demandé à l'installation", async () => {
    stubFetch(castAnswer(true));
    mount();
    await untilSettled(() => expect(screen.getByTestId("controls")).toBeTruthy());
    expect(screen.queryByText("chromecast")).toBeNull();
    const asked = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0]);
    expect(asked).not.toContain("/api/player/cast");
  });

  it("Chrome, compte autorisé, un récepteur : le choix dans la liste passe la main au Chromecast", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(CHROME);
    stubFetch(castAnswer(true));
    const { createFakeCast } = await import("./helpers/fakeCast");
    const fake = createFakeCast();
    fake.install();
    mount();
    await untilSettled(() => expect(screen.getByText("chromecast")).toBeTruthy());
    act(() => void screen.getByText("chromecast").click());
    await untilSettled(() =>
      expect(onFallback).toHaveBeenCalledWith("diffusion demandée", expect.objectContaining({ cast: true, castTarget: "chromecast" }))
    );
    expect(fake.ended).toEqual([]);
  });

  it("la liste fermée sans choix : rien ne se passe", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(CHROME);
    stubFetch(castAnswer(true));
    const { createFakeCast } = await import("./helpers/fakeCast");
    const fake = createFakeCast();
    fake.install();
    fake.requestSession.next = () => Promise.reject("cancel");
    mount();
    await untilSettled(() => expect(screen.getByText("chromecast")).toBeTruthy());
    act(() => void screen.getByText("chromecast").click());
    await settle();
    await settle();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("Chrome, compte non autorisé : pas de bouton, et le kit de Google n'est jamais chargé", async () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(CHROME);
    stubFetch(castAnswer(false));
    mount();
    await untilSettled(() => expect(screen.getByTestId("controls")).toBeTruthy());
    await settle();
    expect(screen.queryByText("chromecast")).toBeNull();
    expect(document.head.querySelector('script[src*="gstatic"]')).toBeNull();
  });

  it("sans lecteur serveur sur l'installation : pas de bouton", async () => {
    serverFallback = false;
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(CHROME);
    stubFetch(castAnswer(true));
    mount();
    await untilSettled(() => expect(screen.getByTestId("controls")).toBeTruthy());
    await settle();
    expect(screen.queryByText("chromecast")).toBeNull();
  });
});

/**
 * « Connexion trop lente » (DECISIONS.md §77) — 12/10/2026, Edge d'Augustine : ~40 Ko/s pour un
 * épisode qui demande ~3,9 Mbit/s, « aucune image après 35 s » puis trois échecs du lecteur serveur.
 * Le minuteur d'abandon regarde maintenant ce que le lien a livré ; sans preuve, rien ne change.
 */
describe("une ouverture qui traîne : le lien, mesuré (§78)", () => {
  // 3,9 Mbit/s demandés : 1,17 Go pour 40 minutes.
  const slowInfo = (over: Info = {}) => info({ sizeBytes: 1_170_000_000, runtimeSeconds: 2400, ...over });
  const logged = (kind: string) =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === "/api/player/log")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
      .filter((entry) => entry.kind === kind);

  /** Le mot sous la ligne de chargement de l'ouverture (§60), s'il y en a un. */
  const introNote = () => document.querySelector("[data-playback-intro-note]")?.textContent ?? null;
  /** L'écran « Lecture impossible : la connexion est trop lente. ». */
  const slowScreen = () => document.querySelector<HTMLElement>("[data-slow-link-screen]");
  const screenButtons = () => Array.from(slowScreen()?.querySelectorAll("button") ?? []).map((b) => b.textContent);
  let request: ReturnType<typeof meterOpeningRequest> = null;
  async function more(rate: number, seconds: number) {
    for (let t = 0; t < seconds; t++) {
      await act(async () => void vi.advanceTimersByTime(1000));
      if (rate > 0) request?.received(rate);
    }
  }

  /** Une ouverture qui ne finit jamais, et un lien qui livre `rate` octets par seconde. */
  async function openOver(rate: number | ((t: number) => number), seconds = 36, probe?: () => unknown) {
    vi.useFakeTimers();
    nextProbe = probe ?? ((() => new Promise(() => {})) as never);
    mount();
    await act(async () => void vi.advanceTimersByTime(500));
    request = meterOpeningRequest();
    expect(request).not.toBeNull();
    request!.headers();
    const seen: (string | null)[] = [];
    for (let t = 0; t < seconds; t++) {
      await act(async () => void vi.advanceTimersByTime(1000));
      const bytes = typeof rate === "function" ? rate(t) : rate;
      if (bytes > 0) request!.received(bytes);
      seen.push(slowScreen() ? "screen" : introNote());
    }
    return seen;
  }

  beforeEach(() => {
    forgetLighterCarry();
    resetNetworkTrouble();
    prewarms.length = 0;
    cancelPrewarmSpy.mockClear();
    writePlaybackQuality("auto");
    diagMock.currentWait = null;
    diagMock.waitEnded = null;
    diagMock.link = null;
    // L'ouverture (§60) doit être là pour porter l'indice : son horloge vit hors de React.
    resetIntroClocks();
  });

  it("bon réseau : strictement l'ancien comportement — ni indice, ni préchauffage, aucune requête de plus, le même renoncement", async () => {
    serverFallback = true;
    swr = { data: slowInfo(), error: undefined };
    const calls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const seen = await openOver(2_000_000, 34);
    expect(seen).not.toContain("hint");
    expect(seen[10]).toBe("stillWorking");
    expect(prewarms).toHaveLength(0);
    const before = calls();
    await act(async () => void vi.advanceTimersByTime(2000));
    expect(onFallback).toHaveBeenCalledWith("aucune image après 35 s");
    expect(calls() - before).toBe(1);
    const line = logged("fallback")[0].fields;
    expect(line.reason).toBe("aucune image après 35 s");
    expect(line.slowLink).toBeUndefined();
    expect(onFallback.mock.calls[0][1]).toBeUndefined();
  });

  it("très lente (≈0,3 Mbit/s) : l'indice dès 5 s, le préchauffage à 8 s, la bascule dès qu'il est prêt (≥ 10 s), par la reconstruction habituelle", async () => {
    serverFallback = true;
    swr = { data: slowInfo(), error: undefined };
    const seen = await openOver(40_000, 9);
    expect(seen.slice(0, 4)).not.toContain("hint");
    expect(seen[5]).toBe("hint");
    expect(prewarms).toHaveLength(1);
    expect(prewarms[0].options).toMatchObject({ itemId: "item-1", step: { targetBps: 1_500_000, tier: 1 }, startSeconds: 0 });
    // À 10 s le préchauffage tourne encore : on l'attend.
    await more(40_000, 3);
    expect(onFallback).not.toHaveBeenCalled();
    act(() => prewarms[0].settle(true));
    await more(40_000, 1);
    expect(onFallback).toHaveBeenCalledTimes(1);
    const [reason, takeover] = onFallback.mock.calls[0];
    expect(reason).toBe("connexion trop lente (version allégée demandée)");
    expect(takeover).toMatchObject({ lighter: { targetBps: 1_500_000, tier: 1 }, resumeAt: 0, subtitleStreamIndex: null });
    const line = logged("fallback")[0].fields;
    expect(line).toMatchObject({ lighterMbps: 1.5, lighterTier: 1, quality: "auto", needMbps: 3.9 });
    expect(line.slowLink).toContain("préchauffage (ouverture)");
    expect(line.slowLink).toContain("bascule (ouverture)");
    expect(cancelPrewarmSpy).not.toHaveBeenCalled();
  });

  it("moyenne (≈35 %) : préchauffage à 8 s, pas de bascule avant 20 s, bascule à 20 s", async () => {
    serverFallback = true;
    swr = { data: slowInfo(), error: undefined };
    await openOver(170_000, 9);
    expect(prewarms).toHaveLength(1);
    act(() => prewarms[0].settle(true));
    await more(170_000, 9);
    expect(onFallback).not.toHaveBeenCalled();
    await more(170_000, 3);
    expect(onFallback).toHaveBeenCalledWith("connexion trop lente (version allégée demandée)", expect.objectContaining({ lighter: { targetBps: 1_500_000, tier: 1 } }));
  });

  it("la première image arrive : le préchauffage est annulé (transcodage arrêté), le film part en natif", async () => {
    serverFallback = true;
    swr = { data: slowInfo(), error: undefined };
    let open: (value: unknown) => void = () => {};
    await openOver(40_000, 9, () => new Promise((resolve) => (open = resolve)));
    expect(prewarms).toHaveLength(1);
    await act(async () => open({ path: "remux", start: async () => remux, discard: vi.fn() }));
    await untilSettled(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    expect(cancelPrewarmSpy).toHaveBeenCalledWith(prewarms[0].prewarm);
    act(() => prewarms[0].settle(true));
    await act(async () => void vi.advanceTimersByTime(40_000));
    expect(onFallback).not.toHaveBeenCalled();
    expect(logged("error")).toHaveLength(0);
  });

  it("« Originale » : jamais de préchauffage ni de bascule — l'indice, puis à 35 s l'écran final (Réessayer · Fermer)", async () => {
    serverFallback = true;
    writePlaybackQuality("original");
    swr = { data: slowInfo(), error: undefined };
    const seen = await openOver(40_000, 36);
    expect(prewarms).toHaveLength(0);
    expect(seen.slice(0, 34)).not.toContain("screen");
    expect(slowScreen()!.textContent).toContain("failed");
    expect(slowScreen()!.textContent).not.toMatch(/\d/);
    expect(screenButtons()).toEqual(["retry", "close"]);
    expect(onFallback).not.toHaveBeenCalled();
    expect(logged("error")[0].fields).toMatchObject({ reason: "connexion trop lente", quality: "original" });
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: /retry/ })));
    await act(async () => void vi.advanceTimersByTime(10));
    expect(probes).toHaveLength(2);
    expect(slowScreen()).toBeNull();
  });

  it("version allégée non permise (transcodage refusé au compte, ou pas de lecteur serveur) : comme « Originale »", async () => {
    serverFallback = true;
    swr = { data: slowInfo({ lighterAllowed: false }), error: undefined };
    await openOver(40_000, 36);
    expect(prewarms).toHaveLength(0);
    expect(screenButtons()).toEqual(["retry", "close"]);
    cleanup();
    vi.useRealTimers();
    serverFallback = false;
    swr = { data: slowInfo(), error: undefined };
    await openOver(40_000, 36);
    expect(prewarms).toHaveLength(0);
    expect(screenButtons()).toEqual(["retry", "close"]);
  });

  it("renoncement sans lenteur prouvée (rien reçu, durée inconnue) : l'ancien renoncement et l'ancien motif", async () => {
    serverFallback = true;
    swr = { data: slowInfo(), error: undefined };
    await openOver(0);
    expect(onFallback).toHaveBeenCalledWith("aucune image après 35 s");
    cleanup();
    vi.useRealTimers();
    swr = { data: info(), error: undefined };
    await openOver(40_000);
    expect(onFallback).toHaveBeenLastCalledWith("aucune image après 35 s");
  });

  it("C : des tentatives qui échouent — « Connexion perdue ou instable… », jamais d'indice ni de préchauffage ; le renoncement attend leur issue", async () => {
    serverFallback = true;
    swr = { data: slowInfo(), error: undefined };
    await openOver(40_000, 6);
    expect(introNote()).toBe("hint");
    act(() => noteFetchRetrying());
    await more(0, 1);
    expect(introNote()).toBe("unstable");
    await more(40_000, 40);
    expect(prewarms).toHaveLength(0);
    expect(slowScreen()).toBeNull();
    expect(onFallback).not.toHaveBeenCalled();
    act(() => noteFetchSettled());
    await more(40_000, 1);
    expect(introNote()).not.toBe("unstable");
  });

  it("C : toutes les tentatives échouent — l'écran « connexion perdue », Réessayer et Fermer seulement, jamais de bascule", async () => {
    serverFallback = true;
    swr = { data: slowInfo(), error: undefined };
    await openOver(40_000, 6);
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    act(() => probes[0].onError("plus de réseau", "network"));
    await act(async () => void vi.advanceTimersByTime(60_000));
    expect(screen.getByText("connectionLost")).toBeTruthy();
    expect(prewarms).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("5 : une ouverture passée en arrière-plan repart de zéro pour sa mesure au retour — aucun verdict sur l'arrière-plan", async () => {
    serverFallback = true;
    swr = { data: slowInfo(), error: undefined };
    await openOver(40_000, 6);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    await more(40_000, 20);
    expect(prewarms).toHaveLength(0);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    request = meterOpeningRequest();
    request!.headers();
    await more(40_000, 4);
    expect(prewarms).toHaveLength(0);
    await more(40_000, 6);
    expect(prewarms).toHaveLength(1);
    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe("pendant la lecture : les saccades (§78)", () => {
  const slowLinkNow = { bytes: 300_000 * 20, receivingMs: 20_000 }; // ≈2,4 Mbit/s pour 3,9
  const fastLinkNow = { bytes: 2_000_000 * 20, receivingMs: 20_000 };

  async function playing() {
    vi.useFakeTimers();
    serverFallback = true;
    swr = { data: info({ sizeBytes: 1_170_000_000, runtimeSeconds: 2400 }), error: undefined };
    mount();
    await untilSettled(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const element = videoElement(600);
    // Un film qui joue : jsdom laisse l'élément « en pause » à jamais.
    Object.defineProperty(element, "paused", { value: false, configurable: true });
    await act(async () => void fireEvent(element, new Event("playing")));
    return element;
  }
  async function stall(element: HTMLVideoElement, ms: number) {
    await act(async () => void fireEvent(element, new Event("waiting")));
    await act(async () => void vi.advanceTimersByTime(ms));
  }

  beforeEach(() => {
    resetNetworkTrouble();
    prewarms.length = 0;
    cancelPrewarmSpy.mockClear();
    writePlaybackQuality("auto");
    diagMock.currentWait = null;
    diagMock.waitEnded = null;
    diagMock.link = null;
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  });

  it("un blocage réseau de plus de 5 s : préchauffage à la position courante, puis bascule dès qu'il est prêt — aucune fenêtre, aucune erreur", async () => {
    const element = await playing();
    diagMock.currentWait = { verdict: "réseau", ms: 5000 };
    diagMock.link = slowLinkNow;
    await stall(element, 5100);
    expect(prewarms).toHaveLength(1);
    expect(prewarms[0].options.startSeconds).toBe(600);
    expect(onFallback).not.toHaveBeenCalled();
    await act(async () => prewarms[0].settle(true));
    const [reason, takeover] = onFallback.mock.calls[0];
    expect(reason).toBe("connexion trop lente (saccades, version allégée demandée)");
    expect(takeover).toMatchObject({ lighter: expect.objectContaining({ tier: 1 }), subtitleStreamIndex: null });
    expect(Math.abs((takeover as { resumeAt: number }).resumeAt - 600)).toBeLessThanOrEqual(5);
  });

  // La règle de Louis (15/10/2026, §78) : une mesure seule n'agit jamais — seul un blocage réel le peut.
  it("un lien mesuré très lent sans aucun blocage : ni préchauffage ni bascule, même deux minutes durant", async () => {
    await playing();
    diagMock.link = slowLinkNow;
    await act(async () => void vi.advanceTimersByTime(120_000));
    expect(prewarms).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("une attente de calcul ou de décodeur, un lien qui suffit, ou « Originale » : rien, jamais", async () => {
    const element = await playing();
    diagMock.currentWait = { verdict: "calcul", ms: 5000 };
    diagMock.link = slowLinkNow;
    await stall(element, 6000);
    diagMock.currentWait = { verdict: "réseau", ms: 5000 };
    diagMock.link = fastLinkNow;
    await act(async () => void fireEvent(element, new Event("playing")));
    await stall(element, 6000);
    writePlaybackQuality("original");
    diagMock.link = slowLinkNow;
    await act(async () => void fireEvent(element, new Event("playing")));
    await stall(element, 6000);
    expect(prewarms).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("le 2e blocage de plus d'1 s, réseau : le préchauffage, sans bascule ; le 3e : la bascule sur le préchauffage déjà prêt", async () => {
    const element = await playing();
    diagMock.link = slowLinkNow;
    diagMock.waitEnded = { verdict: "réseau", ms: 1500 };
    await stall(element, 1500);
    await act(async () => void fireEvent(element, new Event("playing")));
    expect(prewarms).toHaveLength(0);
    await stall(element, 1500);
    await act(async () => void fireEvent(element, new Event("playing")));
    expect(prewarms).toHaveLength(1);
    // Prêt : il attend la règle de bascule.
    await act(async () => prewarms[0].settle(true));
    expect(onFallback).not.toHaveBeenCalled();
    await stall(element, 1500);
    await act(async () => void fireEvent(element, new Event("playing")));
    // Le même préchauffage, pas un second : la bascule part tout de suite.
    expect(prewarms).toHaveLength(1);
    expect(onFallback).toHaveBeenCalledWith("connexion trop lente (saccades, version allégée demandée)", expect.objectContaining({ lighter: expect.objectContaining({ tier: 1 }) }));
  });

  it("le 2e blocage sans 3e dans la minute : le préchauffage est annulé, aucune bascule", async () => {
    const element = await playing();
    diagMock.link = slowLinkNow;
    diagMock.waitEnded = { verdict: "réseau", ms: 1500 };
    for (let i = 0; i < 2; i++) {
      await stall(element, 1500);
      await act(async () => void fireEvent(element, new Event("playing")));
    }
    expect(prewarms).toHaveLength(1);
    await act(async () => prewarms[0].settle(true));
    expect(cancelPrewarmSpy).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(61_000));
    expect(cancelPrewarmSpy).toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("les attentes après un saut ne comptent jamais", async () => {
    const element = await playing();
    diagMock.link = slowLinkNow;
    diagMock.currentWait = { verdict: "réseau", ms: 6000 };
    Object.defineProperty(element, "seeking", { value: true, configurable: true });
    await act(async () => void fireEvent(element, new Event("seeking")));
    await stall(element, 6000);
    expect(prewarms).toHaveLength(0);
  });

  it("un saut sans image depuis plus de 10 s sur un lien très lent : traité comme une ouverture (préchauffage puis bascule)", async () => {
    const element = await playing();
    diagMock.link = { bytes: 40_000 * 12, receivingMs: 12_000 };
    await act(async () => void fireEvent(element, new Event("seeking")));
    await act(async () => void vi.advanceTimersByTime(9_000));
    expect(prewarms).toHaveLength(0);
    await act(async () => void vi.advanceTimersByTime(2_000));
    expect(prewarms).toHaveLength(1);
    expect(prewarms[0].options.step).toEqual({ targetBps: 1_500_000, tier: 1 });
    act(() => prewarms[0].settle(true));
    await act(async () => void vi.advanceTimersByTime(1_100));
    expect(onFallback).toHaveBeenCalledWith("connexion trop lente (version allégée demandée)", expect.objectContaining({ lighter: { targetBps: 1_500_000, tier: 1 } }));
  });

  it("l'image revient après le saut : le préchauffage est annulé", async () => {
    const element = await playing();
    diagMock.link = { bytes: 40_000 * 12, receivingMs: 12_000 };
    await act(async () => void fireEvent(element, new Event("seeking")));
    await act(async () => void vi.advanceTimersByTime(11_000));
    expect(prewarms).toHaveLength(1);
    await act(async () => void fireEvent(element, new Event("playing")));
    await act(async () => void vi.advanceTimersByTime(1_100));
    expect(cancelPrewarmSpy).toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("un saut fait en pause n'est jamais traité comme une ouverture — ni préchauffage, ni bascule, ni indice", async () => {
    const element = await playing();
    diagMock.link = { bytes: 40_000 * 12, receivingMs: 12_000 };
    Object.defineProperty(element, "paused", { value: true, configurable: true });
    await act(async () => void fireEvent(element, new Event("pause")));
    await act(async () => void fireEvent(element, new Event("seeking")));
    await act(async () => void fireEvent(element, new Event("seeked")));
    await act(async () => void vi.advanceTimersByTime(40_000));
    expect(prewarms).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
    const errors = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url, init]) => url === "/api/player/log" && JSON.parse((init as RequestInit).body as string).kind === "error"
    );
    expect(errors).toHaveLength(0);
  });

  it("un blocage en cours quand le lecteur se ferme : son minuteur de 5 s meurt avec lui — rien n'est préchauffé après coup", async () => {
    const element = await playing();
    diagMock.currentWait = { verdict: "réseau", ms: 5000 };
    diagMock.link = slowLinkNow;
    await act(async () => void fireEvent(element, new Event("waiting")));
    await act(async () => void vi.advanceTimersByTime(2_000));
    cleanup();
    await act(async () => void vi.advanceTimersByTime(6_000));
    expect(prewarms).toHaveLength(0);
  });

  it("banc d'essai : ni préchauffage ni bascule — il mesure ce lecteur-ci", async () => {
    vi.useFakeTimers();
    serverFallback = true;
    swr = { data: info({ sizeBytes: 1_170_000_000, runtimeSeconds: 2400 }), error: undefined };
    mount({ bench: true });
    await untilSettled(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const element = videoElement(600);
    await act(async () => void fireEvent(element, new Event("playing")));
    diagMock.currentWait = { verdict: "réseau", ms: 5000 };
    diagMock.link = slowLinkNow;
    await stall(element, 6000);
    diagMock.link = { bytes: 40_000 * 12, receivingMs: 12_000 };
    await act(async () => void fireEvent(element, new Event("seeking")));
    await act(async () => void vi.advanceTimersByTime(20_000));
    expect(prewarms).toHaveLength(0);
    expect(onFallback).not.toHaveBeenCalled();
  });
});

// ----------------------------------------------------------------------------------------------
// Une zone illisible dans le fichier (DECISIONS.md §93) : le relais préparé, puis passé à la tête.
// ----------------------------------------------------------------------------------------------

describe("zone illisible (§93)", () => {
  const MESSAGE = "zone illisible dans le fichier vers 234,9 s (octet 169510505)";
  const ZONE = { message: MESSAGE, byteOffset: 169510505, zoneSeconds: 234.9, switchAt: 228.5, resumeAfter: 240 };
  const held = { kind: "held", zone: ZONE };
  const arrival = { unreadableZone: true, zoneByte: 169510505, zoneSeconds: 234.9, resumeAt: 228.5, at: 228.6, resumeAfter: 240 };
  const logLines = () =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === "/api/player/log")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> });

  /** Le lecteur, prêt, la tête à 200 s et l'élément en lecture. */
  async function playing() {
    swr = { data: info({ audio: [{ index: 1 }, { index: 2 }] }), error: undefined };
    const view = mount();
    await untilSettled(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    const element = videoElement(200);
    Object.defineProperty(element, "paused", { value: false, writable: true, configurable: true });
    await act(async () => void fireEvent(element, new Event("timeupdate")));
    return { view, element };
  }

  beforeEach(() => {
    serverFallback = true;
  });

  it("préchauffe le lecteur serveur au point du relais, en négociation ordinaire, puis le lui passe à la tête", async () => {
    await playing();
    act(() => probes[0].onUnreadableZone!(held));
    expect(prewarms).toHaveLength(1);
    expect(prewarms[0].options).toMatchObject({ itemId: "item-1", step: null, startSeconds: 228.5, audioStreamIndex: 1 });
    // Rien n'est passé tant que la tête n'est pas au relais : la lecture native continue.
    expect(onFallback).not.toHaveBeenCalled();

    act(() => probes[0].onError(MESSAGE, "playback", arrival));
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0]).toBe(MESSAGE);
    expect(onFallback.mock.calls[0][1]).toMatchObject({ resumeAt: 228.5, audioStreamIndex: 1 });
    expect(typeof onFallback.mock.calls[0][1].switchedAt).toBe("number");
    // Le préchauffage passe au lecteur serveur : ni arrêté au relais, ni à la fermeture qui suit.
    cleanup();
    expect(cancelPrewarmSpy).not.toHaveBeenCalled();
    const line = logLines().find((l) => l.kind === "fallback");
    expect(line?.fields).toMatchObject({ reason: MESSAGE, zoneByte: 169510505, zoneSeconds: 234.9, resumeAt: 228.5, at: 228.6, prewarm: { mbps: 1.5 } });
    // Aucune reconstruction : la même zone attendrait.
    expect(probes).toHaveLength(1);
  });

  it("une zone ne passe jamais par la reconstruction, même source fermée entre-temps", async () => {
    await playing();
    remux.lost = true;
    act(() => probes[0].onError(MESSAGE, "playback", arrival));
    await settle();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(probes).toHaveLength(1);
    expect(logLines().some((l) => l.kind === "rebuild")).toBe(false);
  });

  it("pause avant la zone : préparation arrêtée ; reprise : préparée de nouveau", async () => {
    const { element } = await playing();
    act(() => probes[0].onUnreadableZone!(held));
    expect(prewarms).toHaveLength(1);
    (element as unknown as { paused: boolean }).paused = true;
    act(() => void element.dispatchEvent(new Event("pause")));
    expect(cancelPrewarmSpy).toHaveBeenCalledWith(prewarms[0].prewarm);
    (element as unknown as { paused: boolean }).paused = false;
    act(() => void element.dispatchEvent(new Event("play")));
    expect(prewarms).toHaveLength(2);
    expect(prewarms[1].options.startSeconds).toBe(228.5);
  });

  it("fermé avant la zone : la préparation est arrêtée chez Jellyfin, rien ne fuit", async () => {
    await playing();
    act(() => probes[0].onUnreadableZone!(held));
    cleanup();
    expect(cancelPrewarmSpy).toHaveBeenCalledWith(prewarms[0].prewarm);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("un saut au-delà de la zone annule la préparation ; un saut un peu avant la garde", async () => {
    await playing();
    act(() => probes[0].onUnreadableZone!(held));
    act(() => probes[0].onUnreadableZone!({ kind: "left", zone: ZONE, target: 200 }));
    expect(cancelPrewarmSpy).not.toHaveBeenCalled();
    act(() => probes[0].onUnreadableZone!({ kind: "left", zone: ZONE, target: 300 }));
    expect(cancelPrewarmSpy).toHaveBeenCalledWith(prewarms[0].prewarm);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("la même zone retrouvée (une reconstruction) ne préchauffe pas deux fois", async () => {
    await playing();
    act(() => probes[0].onUnreadableZone!(held));
    act(() => probes[0].onUnreadableZone!(held));
    expect(prewarms).toHaveLength(1);
  });

  it("un saut dans la zone : le préchauffage d'ailleurs est arrêté, le relais part de la cible", async () => {
    await playing();
    act(() => probes[0].onUnreadableZone!(held));
    act(() => probes[0].onError(MESSAGE, "playback", { ...arrival, resumeAt: 236 }));
    expect(cancelPrewarmSpy).toHaveBeenCalledWith(prewarms[0].prewarm);
    expect(onFallback.mock.calls[0][1]).toMatchObject({ resumeAt: 236 });
  });

  it("WebKit en HLS natif : le relais tout de suite, à la tête, sans préchauffage", async () => {
    nativeHlsHere = true;
    await playing();
    act(() => probes[0].onUnreadableZone!(held));
    expect(prewarms).toHaveLength(0);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][1]).toMatchObject({ resumeAt: 200 });
    expect(logLines().find((l) => l.kind === "fallback")?.fields).toMatchObject({ reason: MESSAGE, immediate: true });
    // L'arrivée de la source, plus tard, ne relaie pas une seconde fois.
    act(() => probes[0].onError(MESSAGE, "playback", arrival));
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it("sans lecteur serveur : rien de préparé, une erreur propre à l'arrivée sur la zone", async () => {
    serverFallback = false;
    await playing();
    act(() => probes[0].onUnreadableZone!(held));
    expect(prewarms).toHaveLength(0);
    act(() => probes[0].onError(MESSAGE, "playback", arrival));
    expect(onFallback).not.toHaveBeenCalled();
    const line = logLines().find((l) => l.kind === "error");
    expect(line?.fields).toMatchObject({ reason: MESSAGE, zoneByte: 169510505 });
    // La phrase traduite, pas le motif technique (le double de `useT` rend la fin de la clé).
    await untilSettled(() => expect(screen.getByText("unreadableZone")).toBeTruthy());
  });

  it("le banc d'essai ne préchauffe rien", async () => {
    swr = { data: info(), error: undefined };
    mount({ bench: true });
    await untilSettled(() => expect(probes).toHaveLength(1));
    act(() => probes[0].onUnreadableZone!(held));
    expect(prewarms).toHaveLength(0);
  });
});

/**
 * Une coupure en pleine lecture (15/10/2026, LECTEUR-4) : trois séances figées sans un mot puis
 * fermées à la croix ; le bilan comptait l'image figée comme regardée.
 */
describe("une coupure en pleine lecture", () => {
  const logged = (kind: string) =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .filter(([url]) => url === "/api/player/log")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string) as { kind: string; fields: Record<string, unknown> })
      .filter((entry) => entry.kind === kind);
  const word = () => screen.queryByText("unstable");

  beforeEach(() => resetNetworkTrouble());
  afterEach(() => resetNetworkTrouble());

  it("le temps regardé s'arrête pendant l'attente et repart à l'image", async () => {
    const { unmount } = mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    const element = videoElement(600);
    const now = vi.spyOn(Date, "now");
    let t = 1_000_000;
    now.mockImplementation(() => t);
    act(() => void element.dispatchEvent(new Event("play")));
    act(() => void element.dispatchEvent(new Event("playing")));
    t += 10_000;
    // Plus rien sous la tête : deux minutes d'image figée.
    act(() => void element.dispatchEvent(new Event("waiting")));
    t += 120_000;
    act(() => void element.dispatchEvent(new Event("playing")));
    t += 5_000;
    unmount();
    now.mockRestore();
    expect(logged("stop")[0].fields.watched).toBe(15);
  });

  /** Lance un film, le fait jouer, puis l'élément attend son média ; le temps est simulé. */
  async function stalled() {
    mount();
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
    vi.useFakeTimers();
    const element = videoElement(600);
    act(() => void element.dispatchEvent(new Event("play")));
    act(() => void element.dispatchEvent(new Event("playing")));
    await act(async () => void vi.advanceTimersByTime(2000));
    act(() => void element.dispatchEvent(new Event("waiting")));
    return element;
  }

  it("dit « Connexion perdue ou instable… » sous la roue, au même délai que les autres mots, quand des tentatives échouent", async () => {
    await stalled();
    act(() => noteFetchRetrying());
    await act(async () => void vi.advanceTimersByTime(2500));
    expect(word()).toBeNull();
    await act(async () => void vi.advanceTimersByTime(1000));
    expect(word()).not.toBeNull();
  });

  it("ne clignote pas entre deux tentatives, et s'en va avec l'attente", async () => {
    const element = await stalled();
    act(() => noteFetchRetrying());
    await act(async () => void vi.advanceTimersByTime(4000));
    expect(word()).not.toBeNull();
    // Une tentative finit, la suivante n'a pas encore échoué : le mot reste.
    act(() => noteFetchSettled());
    await act(async () => void vi.advanceTimersByTime(1000));
    expect(word()).not.toBeNull();
    act(() => void element.dispatchEvent(new Event("playing")));
    await act(async () => void vi.advanceTimersByTime(200));
    expect(word()).toBeNull();
  });

  it("une attente ordinaire, sans tentative en échec, reste muette : la roue des commandes suffit", async () => {
    await stalled();
    await act(async () => void vi.advanceTimersByTime(10_000));
    expect(word()).toBeNull();
  });

  it("hors ligne, le mot vient aussi (le navigateur le dit)", async () => {
    await stalled();
    Object.defineProperty(navigator, "onLine", { value: false, writable: true, configurable: true });
    act(() => void window.dispatchEvent(new Event("offline")));
    await act(async () => void vi.advanceTimersByTime(3500));
    expect(word()).not.toBeNull();
  });
});

/**
 * Gardé jusqu'au 22/10/2026 par des lectures du texte de `ExperimentalPlayerHost.tsx`
 * (upstreamUnreachable.test.ts, player-frame-no-select.test.ts) : ici, ce que le lecteur fait.
 */
describe("un serveur média absent (description du fichier en échec)", () => {
  it("ne passe pas la main au lecteur serveur, qui a besoin du même Jellyfin, et dit la phrase partagée", async () => {
    // Céder la place refaisait la même attente avant d'afficher le même échec.
    const { withCode } = await import("@/lib/upstreamError");
    const { UPSTREAM_UNREACHABLE } = await import("@/lib/http");
    swr = { data: undefined, error: withCode(new Error("jellyfin.local ne répond pas (ECONNREFUSED)"), UPSTREAM_UNREACHABLE) };
    mount();
    // `errorMessage` (upstreamError.ts) : la même phrase que le lecteur serveur, jamais le texte brut.
    await untilSettled(() => expect(screen.getByText("libraryUnreachable")).toBeTruthy());
    await settle();
    expect(onFallback).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("ECONNREFUSED");
  });

  it("ni sur une coupure réseau, qui a son propre écran", async () => {
    swr = { data: undefined, error: Object.assign(new Error("Failed to fetch"), { network: true }) };
    mount();
    await settle();
    await settle();
    expect(onFallback).not.toHaveBeenCalled();
  });
});

describe("le cadre du lecteur natif ne sélectionne rien", () => {
  // La règle CSS est dans globals.css (player-frame-no-select.test.ts).
  it("la vidéo est dans le cadre marqué, racine du portail", async () => {
    mount();
    await settle();
    const frame = document.querySelector("video")!.closest("[data-player-frame]");
    expect(frame).not.toBeNull();
    expect(frame!.parentElement).toBe(document.body);
  });
});

describe("le départ d'une ouverture depuis le début, retenu jusqu'à la première image (26/10/2026)", () => {
  // 57 départs de 0 sur 377 restaient figés juste après `playing` : l'élément, lancé dès l'attache,
  // jouait déjà quand l'atterrissage posait la tête à 0,25 s. La source retient le départ
  // (`MseSource.openingHold`) ; l'hôte attend avant le même `play()` qu'avant.
  function held() {
    let permit = () => {};
    const promise = new Promise<void>((resolve) => {
      permit = resolve;
    });
    remux = fakeRemux({ openingHold: vi.fn(() => promise) });
    return { promise, permit };
  }
  const wait = (ms: number) => act(async () => void (await new Promise((resolve) => setTimeout(resolve, ms))));

  it("n'appelle play() qu'une fois le départ permis", async () => {
    const hold = held();
    mount({ resumeAt: 0 });
    await waitFor(() => expect(remux.openingHold).toHaveBeenCalledTimes(1));
    await wait(50);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    await act(async () => {
      hold.permit();
      await hold.promise;
    });
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));
  });

  it("les commandes restent en chargement pendant la retenue, pas sur « Lecture »", async () => {
    const hold = held();
    mount({ resumeAt: 0 });
    await waitFor(() => expect(remux.openingHold).toHaveBeenCalledTimes(1));
    await wait(20);
    expect(screen.getByTestId("controls").dataset.loading).toBe("true");
    await act(async () => {
      hold.permit();
      await hold.promise;
    });
    await waitFor(() => expect(screen.getByTestId("controls").dataset.loading).toBe("false"));
  });

  it("ne lance rien quand le lecteur est fermé pendant la retenue", async () => {
    const hold = held();
    const view = mount({ resumeAt: 0 });
    await waitFor(() => expect(remux.openingHold).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => {
      hold.permit();
      await hold.promise;
    });
    await wait(20);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it("rien de retenu (une reprise) : play() aussitôt, comme avant", async () => {
    mount({ resumeAt: 1200 });
    await waitFor(() => expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1));
    expect(remux.openingHold).toHaveBeenCalledTimes(1);
  });
});
