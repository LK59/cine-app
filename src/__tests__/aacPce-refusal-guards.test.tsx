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
    subtitleTracks: { id: number; label: string }[];
    onChangeAudio: (id: number) => void;
    onChangeSubtitle: (id: number | null) => void;
    onSeekRequest?: (seconds: number) => void;
    suspended?: boolean;
    subtitleOffset?: { seconds: number; onShift: (delta: number) => void };
    hdrCap?: { current: string | number; autoNits: number | null; onPick: (choice: string | number) => void };
    onClose?: () => void;
    chromecast?: { active: boolean; onRequest: () => void };
  }) => (
    <div data-testid="controls" data-loading={String(props.loading)} data-suspended={String(!!props.suspended)}>
      {props.onClose && <button onClick={props.onClose}>fermer</button>}
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
        <button key={track.id} onClick={() => props.onChangeSubtitle(track.id)}>{`st:${track.label}`}</button>
      ))}
      <button onClick={() => props.onChangeSubtitle(null)}>st:aucun</button>
    </div>
  ),
}));

// --- the file's description, as the route gives it -------------------------------------------

type Info = Record<string, unknown>;
let swr: { data: Info | undefined; error: unknown };
vi.mock("swr", () => ({ default: () => swr }));
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
  onError: (message: string, kind?: "network" | "playback") => void;
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

import { noteWatching } from "@/lib/resumeRewind";
import { resetIntroClocks } from "@/lib/playbackIntro";
import { ExperimentalPlayerHost } from "@/components/ExperimentalPlayerHost";

const onFallback = vi.fn();

function player(over: Partial<{ resumeAt: number; itemId: string; mode: "full" | "mini"; startPaused: boolean }> = {}) {
  return (
    <ExperimentalPlayerHost
      session={
        {
          itemId: over.itemId ?? "item-1",
          title: "Un film",
          resumeAt: over.resumeAt ?? null,
          ...(over.startPaused ? { startPaused: true } : {}),
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

function mount(over: Partial<{ resumeAt: number; itemId: string; mode: "full" | "mini"; startPaused: boolean }> = {}) {
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
  // Le titre des tests vient d'être joué sur cet appareil : pas de recul à l'ouverture, ce que
  // tous les tests d'avant ce réglage supposent. Ceux qui l'éprouvent vident ce souvenir.
  window.localStorage.removeItem("cine:last-watched");
  noteWatching("item-1");
  recentSteps = [];
  serverFallback = undefined;
  probes = [];
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
// GARDE-FOUS DU REPLI AAC À PCE (DECISIONS §62) — quatre défauts trouvés par la chasse du 11/10/2026
// et corrigés : B1 boucle quand le stockage refuse d'écrire le refus, B2 boucle sur Chromium dont la
// sonde a dit « accepté », B3 piste à PCE choisie au menu et refusée jamais essayée décodée, B4 panne
// vidéo prise pour un refus du PCE. Harnais recopié de ExperimentalPlayerHost.test.tsx (1–308).
// ----------------------------------------------------------------------------------------------
import * as pce from "@/lib/webcodecs/aacPceProbe";

const REFUSED = "Le navigateur a refusé une opération sur le tampon. (MediaSource closed, élément code 4, readyState 0, réseau 3)";

/** Ce que fait le vrai remultiplexeur : il copie le PCE tant que la réponse effective le permet, et le navigateur refuse. */
function pceOpening() {
  let opened = 0;
  nextProbe = () => {
    // Plafond de sûreté du test seulement : au-delà de 12 ouvertures, la boucle est prouvée, et le
    // harnais rend un pipeline sain pour que l'assertion se lise au lieu d'un dépassement de temps.
    if (++opened <= 12 && pce.effectivePceAnswer(pce.PROBE_ASC) !== false) {
      pce.notePceDecision("copy", true, pce.PROBE_ASC);
      throw new Error(REFUSED);
    }
    return { path: "remux", start: async () => remux, discard: vi.fn() };
  };
}

async function extraTurns(n: number) {
  for (let i = 0; i < n; i++) await act(async () => {});
}

describe("garde-fous — refus de copie d'un AAC à PCE", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
    pce.__testing.reset();
  });

  it("[témoin] stockage sain : refus → une reconstruction décodée, deux ouvertures en tout", async () => {
    pce.__testing.reset();
    serverFallback = true;
    pceOpening();
    mount();
    await untilSettled(() => expect(probes.length).toBeGreaterThanOrEqual(2));
    await extraTurns(60);
    expect(probes.length).toBe(2);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("[B1] stockage local en écriture refusée : une seule reconstruction, pas une boucle", async () => {
    pce.__testing.reset();
    serverFallback = true;
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === pce.__testing.REFUSALS_KEY) throw new DOMException("quota", "QuotaExceededError");
      return original.call(this, key, value);
    });
    pceOpening();
    mount();
    await untilSettled(() => expect(probes.length).toBeGreaterThanOrEqual(2));
    await extraTurns(60);
    // Refus → une reconstruction décodée (2 ouvertures en tout) : le refus est gardé en mémoire
    // même quand le stockage refuse de l'écrire.
    expect(probes.length).toBe(2);
  });

  it("[B2] Chromium dont la sonde a répondu « accepté » : un refus réel ne boucle pas", async () => {
    pce.__testing.reset();
    serverFallback = true;
    const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(CHROME);
    window.localStorage.setItem(pce.__testing.STORAGE_KEY, JSON.stringify({ ua: CHROME, ok: true }));
    pceOpening();
    mount();
    await untilSettled(() => expect(probes.length).toBeGreaterThanOrEqual(2));
    await extraTurns(60);
    // Le refus par forme prime sur la sonde, sur Chromium aussi.
    expect(probes.length).toBe(2);
  });

  it("[B4] une panne de décodage VIDÉO avant la première image n'est pas retenue comme refus du PCE", async () => {
    pce.__testing.reset();
    serverFallback = true;
    let attempt = 0;
    nextProbe = () => {
      attempt++;
      if (attempt === 1) {
        // Le PCE est copié (WebKit, comme Forrest Gump EN 7.1, que Safari ACCEPTE), puis l'image
        // HEVC échoue au décodage — rien à voir avec le son.
        pce.notePceDecision("copy", true, pce.PROBE_ASC);
        throw new Error("Le navigateur n'a pas pu décoder la vidéo. (Media failed to decode, élément code 3, readyState 0, réseau 2)");
      }
      return { path: "remux", start: async () => remux, discard: vi.fn() };
    };
    mount();
    await untilSettled(() => expect(probes.length + onFallback.mock.calls.length).toBeGreaterThanOrEqual(2));
    await extraTurns(20);
    // Un code 3 ne dit rien du son : la forme reste copiée.
    expect(pce.effectivePceAnswer(pce.PROBE_ASC)).toBe(true);
  });

  it("[B3] changement de piste vers une piste à PCE dont la copie est refusée : décodée, pas abandonnée", async () => {
    pce.__testing.reset();
    serverFallback = true;
    mount();
    // Le premier pipeline a ouvert : `declareReady` est passé, `everReadyRef` est vrai.
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    let attempt = 0;
    nextProbe = () => {
      attempt++;
      if (attempt === 1) {
        // La piste anglaise est un AAC à PCE copié tel quel (WebKit), et Safari le refuse.
        pce.notePceDecision("copy", true, pce.PROBE_ASC);
        throw new Error(REFUSED);
      }
      // Le pipeline ouvre sur la piste qu'on lui demande, comme le vrai.
      const asked = (probes[probes.length - 1] as unknown as { audioTrackNumber?: number }).audioTrackNumber ?? 1;
      return { path: "remux", start: async () => fakeRemux({ currentAudioTrack: asked }), discard: vi.fn() };
    };
    await act(async () => void fireEvent.click(screen.getByText(/^audio:Anglais/)));
    await untilSettled(() => expect(probes.length + onFallback.mock.calls.length).toBeGreaterThanOrEqual(3));
    // Le refus est retenu pour cette forme et la piste 2 est rouverte, décodée — pas la piste
    // d'avant rétablie sans essai.
    expect(probes[2]).toMatchObject({ audioTrackNumber: 2 });
    expect(pce.effectivePceAnswer(pce.PROBE_ASC)).toBe(false);
  });
  it("une reconstruction de récupération en cours de film qui échoue n'est pas un refus du PCE", async () => {
    // Le film joue (PCE copié, accepté) ; une perte du lecteur en cours de séance — retour
    // d'arrière-plan, coupure — reconstruit, et ce pipeline-là échoue avant son image. Ce n'est pas
    // ce navigateur qui refuse le PCE : retenu, la piste serait décodée pour toujours au lieu d'être
    // copiée (relecture du correctif B3, 11/10/2026).
    pce.__testing.reset();
    serverFallback = true;
    mount();
    await waitFor(() => expect(screen.getByText(/^audio:Anglais/)).toBeTruthy());
    let attempt = 0;
    nextProbe = () => {
      if (++attempt === 1) {
        pce.notePceDecision("copy", true, pce.PROBE_ASC);
        throw new Error(REFUSED);
      }
      return { path: "remux", start: async () => fakeRemux(), discard: vi.fn() };
    };
    // Une source perdue en cours de séance (iOS l'a fermée en arrière-plan) : l'hôte reconstruit.
    remux.lost = true;
    await act(async () => probes[0].onError(REFUSED, "playback"));
    await untilSettled(() => expect(attempt + onFallback.mock.calls.length).toBeGreaterThanOrEqual(1));
    await extraTurns(30);
    expect(pce.effectivePceAnswer(pce.PROBE_ASC)).not.toBe(false);
  });
});

describe("garde-fous — ce qui compte comme refus du PCE", () => {
  it("refus de source ou d'envoi : oui ; panne de décodage ou délai : non", () => {
    expect(pce.isPceRefusalMessage(REFUSED)).toBe(true);
    expect(pce.isPceRefusalMessage("Le navigateur a refusé une opération sur le tampon. (MediaSource closed, readyState 0, réseau 3)")).toBe(true);
    expect(pce.isPceRefusalMessage("Le navigateur a refusé une opération sur le tampon. (MediaSource open, élément code 3 « Media failed to decode », readyState 1, réseau 2)")).toBe(false);
    expect(pce.isPceRefusalMessage("Le tampon n'a pas répondu en 10 s. (MediaSource open, readyState 0, réseau 2)")).toBe(false);
    expect(pce.isPceRefusalMessage("Failed to fetch")).toBe(false);
  });
});
