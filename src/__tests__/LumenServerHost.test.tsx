// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

/**
 * L'hôte de Lumen serveur (DECISIONS.md §180), monté avec ses vraies pièces de séance et des doublures pour ce qui
 * n'est pas le sien (commandes, ouverture animée, panneau, rapport à Jellyfin) : l'ouverture par `#t=`, les sauts,
 * le changement de piste par `audioTracks` ou par réouverture dans la page (§185), le repli avant et après la première image, le
 * redémarrage du serveur (attente, puis réouverture) et le 410 d'une version changée, la fin, l'épisode suivant.
 */
const lines: { kind: string; fields: Record<string, unknown> }[] = [];
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: (kind: string, fields: Record<string, unknown>) => lines.push({ kind, fields }) }));
const playback = { mode: "full", close: vi.fn(), minimize: vi.fn(), expand: vi.fn(), advance: vi.fn() };
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => playback, PLAYER_RELOAD_INTENT_KEY: "cine:player-reload-intent" }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));
type Controls = { dialogue?: { onChange: (mode: "off" | "on" | "strong") => void }; subtitleGeneration?: { targets: { code: string }[]; onGenerate: (code: string) => void }; onChangeAudio: (id: number) => void; onClose: () => void; onAdvance: () => void; onCastRequest?: () => void; audioTracks: { id: number; label: string }[]; currentAudioId: number | null; subtitleTracks: { id: number }[]; currentSubtitleId: number | null };
let controls: Controls | null = null;
vi.mock("@/components/PlayerControls", () => ({
  PlayerControls: (props: Controls) => {
    controls = props;
    return null;
  },
}));
vi.mock("@/components/MiniPlayer", () => ({ MiniPlayerChrome: () => null, useMiniPlayerDrag: () => ({ pos: { x: 0, y: 0 }, size: { width: 0, height: 0 }, isDragging: false, handlers: {} }) }));
vi.mock("@/components/PlaybackInfoPanel", () => ({ PlaybackInfoPanel: () => null }));
vi.mock("@/components/player/server/ServerPlayerIntro", () => ({ ServerPlayerIntro: () => null }));
vi.mock("@/components/player/server/ServerPlayerScreens", () => ({ ServerWaitPill: () => null }));
const subtitleLines: (string | null)[] = [];
vi.mock("@/components/player/SubtitleLayer", () => ({ SubtitleLayer: (props: { primary: string | null }) => (subtitleLines.push(props.primary), null) }));
vi.mock("@/lib/playerHistory", () => ({ usePlayerBackClose: () => {} }));
vi.mock("@/lib/usePlayerFocus", () => ({ usePlayerFocus: () => {} }));
vi.mock("@/lib/useWakeLock", () => ({ useWakeLock: () => {} }));
vi.mock("@/lib/useSleepTimer", () => ({ useSleepTimer: () => ({ holdAtEnd: () => false, blocksAdvance: false }) }));
vi.mock("@/components/player/server/useServerTimeline", () => ({ useServerTimeline: () => {} }));
const stopReporting = vi.fn(async () => {});
vi.mock("@/lib/usePlaybackSession", () => ({ usePlaybackSession: () => ({ stop: stopReporting, resume: vi.fn(), savePaused: vi.fn(), reportNow: vi.fn() }) }));
vi.mock("@/lib/sceneMode", () => ({ useSceneMode: () => ({ active: false, isScene: () => false, logFields: () => ({}) }), sceneCarryOf: () => undefined }));
vi.mock("@/lib/resumeRewind", async (orig) => ({ ...(await orig<typeof import("@/lib/resumeRewind")>()), openingPosition: (_id: string, p: number) => p }));
vi.mock("@/lib/noteSeriesLanguage", () => ({ noteSeriesLanguage: vi.fn() }));
vi.mock("@/lib/lumenSheetPrepare", () => ({ readLumenPrepared: () => null }));
const declineLumen = vi.fn();
vi.mock("@/lib/lumenServerChoice", () => ({ declineLumen: (id: string) => declineLumen(id) }));
const reloadServerPage = vi.fn((_intent: () => unknown, _video: unknown) => true);
vi.mock("@/components/player/server/serverElement", async (orig) => ({
  ...(await orig<typeof import("@/components/player/server/serverElement")>()),
  reloadServerPage: (intent: () => unknown, video: unknown) => reloadServerPage(intent, video),
  releaseHlsElement: () => {},
}));
let state: { resumeSeconds: number; preferences: null; positionUnknown?: boolean } = { resumeSeconds: 600, preferences: null };
vi.mock("@/lib/playbackPrefetch", () => ({ takePrefetchedPlaybackState: () => null, fetchPlaybackState: async () => state, forgetPrefetchedPlaybackState: () => {} }));
const info = {
  title: "Ghosted",
  container: "mkv",
  video: { codec: "hevc", width: 3840, height: 2160, rangeType: "DOVI" },
  audio: [
    { index: 1, codec: "eac3", language: "fre", displayTitle: null, channels: 6, isDefault: true, profile: null },
    { index: 2, codec: "eac3", language: "eng", displayTitle: null, channels: 6, isDefault: false, profile: null },
    { index: 3, codec: "aac", language: "eng", displayTitle: null, channels: 2, isDefault: false, profile: null },
    { index: 4, codec: "dts", language: "eng", displayTitle: null, channels: 6, isDefault: false, profile: null },
  ],
  introSkip: null,
  recapSkip: null,
  creditsStart: null,
  originalLanguage: null,
  logoUrl: null,
};
vi.mock("@/lib/directInfo", () => ({ directInfoForOpening: async () => info }));

import { LumenServerHost } from "@/components/player/lumen/LumenServerHost";

const audioFacts = [
  { number: 2, codec: "A_EAC3", language: "fre", name: null, channels: 6, hlsChannels: "6", isDefault: true, servable: true, refusal: null, repairs: [] },
  { number: 3, codec: "A_EAC3", language: "eng", name: null, channels: 6, hlsChannels: "6", isDefault: false, servable: true, refusal: null, repairs: [] },
  { number: 4, codec: "A_AAC", language: "eng", name: null, channels: 2, hlsChannels: "2", isDefault: false, servable: true, refusal: null, repairs: [] },
  { number: 5, codec: "A_DTS", language: "eng", name: null, channels: 6, hlsChannels: null, isDefault: false, servable: false, refusal: "son-codec", repairs: [] },
];
const verdictOf = (version: string, audio = 2) => ({ ok: true, version, master: `/api/lumen/g1/${version}/S/master.m3u8?audio=${audio}`, audioTrack: audio, audio: audioFacts, segments: 400, durationS: 6000, targetS: 5 });
const MASTER = [
  "#EXTM3U",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-ec-3",LANGUAGE="fr",NAME="FR",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="6",URI="a2.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-ec-3",LANGUAGE="en",NAME="EN",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="6",URI="a3.m3u8"',
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-mp4a",LANGUAGE="en",NAME="EN 2.0",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="a4.m3u8"',
].join("\n");

let genOptions: object = { enabled: false };
/** Le serveur : la séquence des verdicts (`eligibility`), la liste des sous-titres, la liste maître. */
let verdicts: (object | "down")[] = [];
const fetchMock = vi.fn(async (url: string) => {
  if (url.includes("/eligibility")) {
    const next = verdicts.length > 1 ? verdicts.shift()! : verdicts[0];
    if (next === "down") throw new TypeError("Load failed");
    return new Response(JSON.stringify(next), { status: 200 });
  }
  if (url.includes("/pistes")) return new Response(JSON.stringify({ mediaSourceId: "g1", subtitleTracks: [] }), { status: 200 });
  if (url.includes("master.m3u8")) return new Response(MASTER, { status: 200 });
  if (url.includes("/api/subtitle-gen/options")) return new Response(JSON.stringify(genOptions), { status: 200 });
  if (url.endsWith("/api/subtitle-gen/jobs")) return new Response(JSON.stringify({ jobId: "job1", status: "running" }), { status: 200 });
  if (url.includes("/api/subtitle-gen/jobs/job1/poll")) return new Response(JSON.stringify({ status: "running", rev: 1, done: 1, total: 10, cues: [{ i: 0, start: 599, end: 606, text: "Bonjour." }] }), { status: 200 });
  return new Response("{}", { status: 200 });
});

const session = (extra: Record<string, unknown> = {}) => ({ itemId: "g1", title: "Ghosted", openId: 1, ...extra });
const onFallback = vi.fn();

async function mount(extra: Record<string, unknown> = {}) {
  const view = render(<LumenServerHost session={session(extra) as never} mode="full" serverFallback onFallback={onFallback} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  return view;
}

/** L'élément en place, avec ce que jsdom ne simule pas. */
function element() {
  const video = document.querySelector("video")!;
  let now = 0;
  let ready = 0;
  let error: { code: number; message: string } | null = null;
  let paused = false;
  Object.defineProperty(video, "currentTime", { get: () => now, set: (v: number) => (now = v), configurable: true });
  Object.defineProperty(video, "readyState", { get: () => ready, configurable: true });
  Object.defineProperty(video, "error", { get: () => error, configurable: true });
  Object.defineProperty(video, "paused", { get: () => paused, configurable: true });
  Object.defineProperty(video, "textTracks", { get: () => [], configurable: true });
  return {
    video,
    picture(at: number) {
      now = at;
      ready = 4;
      video.dispatchEvent(new Event("loadeddata"));
      video.dispatchEvent(new Event("playing"));
    },
    at(seconds: number) {
      now = seconds;
      video.dispatchEvent(new Event("timeupdate"));
    },
    fail(code: number) {
      error = { code, message: "segment" };
      video.dispatchEvent(new Event("error"));
    },
    pause(on: boolean) {
      paused = on;
    },
  };
}

/** Les promesses et les rendus en attente (le serveur relu est asynchrone). */
async function flush() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }
}

const kinds = () => lines.map((l) => l.kind);
const last = (kind: string) => [...lines].reverse().find((l) => l.kind === kind)?.fields;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  lines.length = 0;
  controls = null;
  state = { resumeSeconds: 600, preferences: null };
  verdicts = [verdictOf("2-aaaaaaaaaaaa")];
  genOptions = { enabled: false };
  subtitleLines.length = 0;
  [playback.close, playback.advance, declineLumen, onFallback, reloadServerPage, stopReporting, fetchMock].forEach((m) => m.mockClear());
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("l'ouverture", () => {
  it("la liste maître à la position de reprise en `#t=` (levier 2), la ligne `start` et la piste du fichier", async () => {
    await mount();
    const { video } = element();
    expect(video.getAttribute("src") ?? video.src).toContain("master.m3u8?audio=2#t=600");
    expect(video.getAttribute("preload")).toBe("auto");
    expect(video.getAttribute("x-webkit-airplay")).toBe("allow");
    // Le lecteur demande l'adresse munie du laissez-passer d'une Apple TV (§186).
    expect(String(fetchMock.mock.calls.find(([u]) => String(u).includes("/eligibility"))?.[0])).toContain("tv=1");
    expect(last("start")).toMatchObject({ player: "lumen-serveur", path: "remux-serveur", why: "open", at: 600, audioTrack: 2, audioStreamIndex: 1, resumeBy: "fragment" });
    expect(controls?.audioTracks.map((t) => t.id)).toEqual([2, 3, 4, 5]);
    expect(controls?.currentAudioId).toBe(2);
  });

  it("la première image : la ligne `opening`, aucun saut de secours quand `#t=` a été suivi", async () => {
    await mount();
    const el = element();
    act(() => el.picture(600));
    expect(last("opening")).toMatchObject({ player: "lumen-serveur", at: 600, landedAt: 600 });
    expect(el.video.currentTime).toBe(600);
  });

  it("`#t=` ignoré : le saut de secours, une fois, sans ligne `seek`", async () => {
    await mount();
    const el = element();
    act(() => el.picture(0));
    expect(el.video.currentTime).toBe(600);
    act(() => {
      el.video.dispatchEvent(new Event("seeking"));
      el.video.dispatchEvent(new Event("seeked"));
    });
    expect(kinds()).not.toContain("seek");
  });
});

describe("le repli avant la première image : le lecteur actuel", () => {
  it("le serveur refuse le fichier : déclin prévu, sans adresse posée", async () => {
    verdicts = [{ ok: false, reason: "index-troue", audioTrack: 2, audio: [] }];
    await mount();
    expect(declineLumen).toHaveBeenCalledWith("g1");
    expect(last("fallback")).toMatchObject({ to: "natif", planned: true, player: "lumen-serveur" });
    expect(document.querySelector("video")?.getAttribute("src")).toBeNull();
  });

  it("la langue du compte seulement sur une piste non servie (DTS) : déclin prévu", async () => {
    state = { resumeSeconds: 0, preferences: { audioLanguage: "eng", subtitleLanguage: null, subtitleMode: "Default", playDefaultAudioTrack: false } as never };
    verdicts = [verdictOf("2-aaaaaaaaaaaa"), verdictOf("2-aaaaaaaaaaaa", 3)];
    await mount();
    // L'anglais 5.1 servi passe devant le DTS : pas de déclin, la piste 3.
    expect(declineLumen).not.toHaveBeenCalled();
    expect(last("start")).toMatchObject({ audioTrack: 3 });
  });

  it("refus de l'élément (code 4) : le lecteur actuel, tout de suite", async () => {
    await mount();
    const el = element();
    act(() => el.fail(4));
    expect(declineLumen).toHaveBeenCalledWith("g1");
    expect(last("fallback")).toMatchObject({ to: "natif", planned: false, stage: "élément" });
  });

  it("20 s sans image : le lecteur actuel", async () => {
    await mount();
    element();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(declineLumen).toHaveBeenCalledWith("g1");
    expect(last("fallback")).toMatchObject({ to: "natif", stage: "image" });
  });

  it("une erreur passagère avant l'image (un segment « occupé ») : une relance, puis le lecteur actuel", async () => {
    await mount();
    let el = element();
    act(() => el.fail(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await flush();
    expect(declineLumen).not.toHaveBeenCalled();
    expect(last("start")).toMatchObject({ why: "retry" });
    el = element();
    act(() => el.fail(2));
    expect(declineLumen).toHaveBeenCalledWith("g1");
  });
});

describe("après la première image : le serveur relu, la lecture rouverte sur ce chemin", () => {
  it("un déploiement change la version (segments en 410) : la nouvelle liste à la position courante, `rebuild`, pas de repli", async () => {
    await mount();
    const el = element();
    act(() => el.picture(600));
    act(() => el.at(1234));
    verdicts = [verdictOf("3-bbbbbbbbbbbb")];
    await act(async () => {
      el.fail(2);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flush();
    expect(last("rebuild")).toMatchObject({ fromVersion: "2-aaaaaaaaaaaa", toVersion: "3-bbbbbbbbbbbb", at: 1234 });
    expect(String(last("rebuild")?.reason)).toContain("version changée");
    const video = document.querySelector("video")!;
    expect(video.getAttribute("src") ?? video.src).toContain("/3-bbbbbbbbbbbb/S/master.m3u8?audio=2#t=1234");
    expect(onFallback).not.toHaveBeenCalled();
    expect(declineLumen).not.toHaveBeenCalled();
  });

  it("le serveur redémarre : on attend qu'il revienne (borné), puis on rouvre — sans repli", async () => {
    await mount();
    const el = element();
    act(() => el.picture(600));
    act(() => el.at(700));
    verdicts = ["down", "down", "down", verdictOf("2-aaaaaaaaaaaa")];
    await act(async () => {
      el.fail(2);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(kinds()).not.toContain("rebuild");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(last("rebuild")).toMatchObject({ version: "2-aaaaaaaaaaaa", at: 700 });
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("le serveur absent au-delà de la borne : l'écran « interrompue », toujours sans repli", async () => {
    await mount();
    const el = element();
    act(() => el.picture(600));
    verdicts = ["down"];
    await act(async () => {
      el.fail(2);
      await vi.advanceTimersByTimeAsync(95_000);
    });
    expect(onFallback).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("player.playbackInterruptedCheckConnection");
  });

  it("une horloge figée 35 s : la lecture rouverte ; repartie avant, rien n'est touché", async () => {
    await mount();
    const el = element();
    act(() => el.picture(600));
    // Repartie d'elle-même à 20 s : pas de réouverture.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    act(() => el.at(601));
    expect(kinds()).toContain("stall");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(36_000);
    });
    expect(last("rebuild")).toBeDefined();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("le fichier n'est plus servi : le lecteur serveur, à la position et sur la piste", async () => {
    await mount();
    const el = element();
    act(() => el.picture(600));
    act(() => el.at(900));
    verdicts = [{ ok: false, reason: "son-codec", audioTrack: 2, audio: audioFacts }];
    await act(async () => {
      el.fail(3);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(onFallback).toHaveBeenCalledWith(expect.stringContaining("remux serveur"), expect.objectContaining({ resumeAt: 900, audioStreamIndex: 1 }), expect.any(String));
    expect(last("fallback")).toMatchObject({ to: "serveur" });
    expect(stopReporting).toHaveBeenCalled();
  });
});

describe("les sauts", () => {
  it("une ligne `seek` par saut : demande, arrivée, reprise de l'horloge", async () => {
    await mount();
    const el = element();
    act(() => el.picture(600));
    act(() => {
      el.video.currentTime = 1800;
      el.video.dispatchEvent(new Event("seeking"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    act(() => el.video.dispatchEvent(new Event("seeked")));
    act(() => el.at(1800.5));
    expect(last("seek")).toMatchObject({ player: "lumen-serveur", from: 600, to: 1800, arrived: true });
    expect(last("seek")?.tookMs).toBeGreaterThanOrEqual(600);
    expect(last("seek")).toHaveProperty("advanceMs");
  });
});

describe("les pistes son", () => {
  function withAudioTracks(video: HTMLVideoElement) {
    const tracks = [
      { label: "FR", language: "fr", enabled: true },
      { label: "EN", language: "en", enabled: false },
    ];
    Object.defineProperty(video, "audioTracks", { get: () => Object.assign([...tracks], { addEventListener() {} }), configurable: true });
    return tracks;
  }

  it("dans le groupe exposé : `audioTracks[i].enabled`, sans renégocier ; la ligne `audio` dit `applied`", async () => {
    await mount();
    const el = element();
    const tracks = withAudioTracks(el.video);
    act(() => el.picture(600));
    act(() => controls!.onChangeAudio(3));
    expect(tracks[1].enabled).toBe(true);
    expect(tracks[0].enabled).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(last("audio")).toMatchObject({ from: 2, to: 3, via: "audioTracks", applied: true });
    expect(reloadServerPage).not.toHaveBeenCalled();
  });

  it("absente d'`audioTracks` : la liste rouverte dans la page, sur le même élément, à la position, préparée avant", async () => {
    await mount();
    const el = element();
    const tracks = withAudioTracks(el.video);
    act(() => el.picture(600));
    act(() => el.at(640));
    const before = el.video;
    act(() => controls!.onChangeAudio(4));
    await flush();
    const video = document.querySelector("video")!;
    // Le même élément (les commandes et les `<track>` restent), la nouvelle piste à la position exacte.
    expect(video).toBe(before);
    expect(video.getAttribute("src") ?? video.src).toContain("/2-aaaaaaaaaaaa/S/master.m3u8?audio=4#t=640");
    const prepare = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/api/lumen/g1/prepare"));
    expect(JSON.parse(String((prepare as unknown as [string, RequestInit])[1].body))).toMatchObject({ audio: 4, position: 640 });
    expect(reloadServerPage).not.toHaveBeenCalled();
    expect(controls?.currentAudioId).toBe(4);
    // La première image de la nouvelle séance (son rendu DEFAULT allumé), puis l'horloge qui repart : la ligne `audio`.
    tracks[0].enabled = false;
    tracks.push({ label: "EN 2.0", language: "en", enabled: true });
    act(() => el.picture(640));
    act(() => el.at(640.5));
    expect(last("audio")).toMatchObject({ from: 2, to: 4, via: "réouverture", applied: true, first: "piste absente d'audioTracks" });
    expect(last("audio")).toHaveProperty("pictureMs");
    expect(kinds()).not.toContain("fallback");
  });

  it("`audioTracks` sans effet en 2 s (Safari revient à l'autre piste) : la réouverture", async () => {
    await mount();
    const el = element();
    const tracks = withAudioTracks(el.video);
    act(() => el.picture(600));
    act(() => el.at(650));
    act(() => controls!.onChangeAudio(3));
    // Safari rallume la piste d'avant.
    tracks[0].enabled = true;
    tracks[1].enabled = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await flush();
    const video = document.querySelector("video")!;
    expect(video.getAttribute("src") ?? video.src).toContain("master.m3u8?audio=3#t=650");
    act(() => el.picture(650));
    act(() => el.at(651));
    expect(last("audio")).toMatchObject({ to: 3, via: "réouverture", first: "audioTracks sans effet en 2 s" });
  });

  it("la réouverture échoue avant son image : la ligne `audio` le dit, puis un élément neuf sur la nouvelle piste", async () => {
    await mount();
    const el = element();
    withAudioTracks(el.video);
    act(() => el.picture(600));
    act(() => el.at(640));
    act(() => controls!.onChangeAudio(4));
    await flush();
    verdicts = [verdictOf("2-aaaaaaaaaaaa", 4)];
    await act(async () => {
      el.fail(2);
      await vi.advanceTimersByTimeAsync(0);
    });
    await flush();
    expect(lines.find((l) => l.kind === "audio")?.fields).toMatchObject({ to: 4, via: "réouverture", applied: false });
    expect(last("rebuild")).toBeDefined();
    const video = document.querySelector("video")!;
    expect(video.getAttribute("src") ?? video.src).toContain("master.m3u8?audio=4#t=");
  });

  it("une piste que le serveur ne sert pas (DTS) : le lecteur serveur sur cette piste", async () => {
    await mount();
    const el = element();
    act(() => el.picture(600));
    act(() => controls!.onChangeAudio(5));
    expect(onFallback).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ audioStreamIndex: 4 }), expect.any(String));
  });

  it("la page rechargée rouvre sur la piste demandée (index Jellyfin → numéro du fichier)", async () => {
    verdicts = [verdictOf("2-aaaaaaaaaaaa"), verdictOf("2-aaaaaaaaaaaa", 4)];
    await mount({ initialAudioStreamIndex: 3, fromReload: true, resumeAt: 640 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(last("start")).toMatchObject({ why: "audio-reload", audioTrack: 4, at: 640 });
  });
});

describe("« Générer des sous-titres » (§187)", () => {
  it("le menu propose la langue ; la génération devient le sous-titre choisi, ses lignes passent par le calque", async () => {
    genOptions = { enabled: true, targets: ["en"], existing: [], jobs: [], quota: { used: 0, limit: 10 } };
    await mount();
    const el = element();
    act(() => el.picture(600));
    await flush();
    expect(controls?.subtitleGeneration?.targets.map((x) => x.code)).toEqual(["en"]);
    act(() => controls!.subtitleGeneration!.onGenerate("en"));
    await flush();
    // L'entrée temporaire : un numéro de génération, choisi, dans la liste des sous-titres.
    expect(controls?.currentSubtitleId).toBeLessThanOrEqual(-1_000_000);
    expect(controls?.subtitleTracks.map((x) => x.id)).toContain(controls?.currentSubtitleId);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    act(() => el.at(601));
    await flush();
    expect(subtitleLines).toContain("Bonjour.");
  });
});

describe("« Améliorer les dialogues » (§188)", () => {
  it("choisi ici : le réglage retenu, puis le lecteur actuel à la position — un repli prévu", async () => {
    await mount();
    const el = element();
    act(() => el.picture(600));
    act(() => el.at(812));
    act(() => controls!.dialogue!.onChange("on"));
    expect(localStorage.getItem("cine-dialogue")).toBe("on");
    expect(declineLumen).toHaveBeenCalledWith("g1");
    expect(playback.advance).toHaveBeenCalledWith(expect.objectContaining({ itemId: "g1", resumeAt: 812 }));
    expect(last("fallback")).toMatchObject({ to: "natif", planned: true, stage: "lecture" });
    localStorage.removeItem("cine-dialogue");
  });
});

describe("la fin et l'épisode suivant", () => {
  it("sans épisode suivant, la fin ferme le lecteur — un seul `stop`", async () => {
    await mount();
    const el = element();
    act(() => el.picture(600));
    act(() => el.video.dispatchEvent(new Event("ended")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(playback.close).toHaveBeenCalledTimes(1);
    expect(lines.filter((l) => l.kind === "stop")).toHaveLength(1);
    expect(last("stop")).toMatchObject({ player: "lumen-serveur", why: "close" });
  });

  it("l'épisode suivant : `stop` « next », puis `advance`", async () => {
    await mount({ getNextEpisode: () => ({ itemId: "g2", title: "Suivant" }) });
    const el = element();
    act(() => el.picture(600));
    act(() => controls!.onAdvance());
    expect(last("stop")).toMatchObject({ why: "next" });
    expect(playback.advance).toHaveBeenCalledWith(expect.objectContaining({ itemId: "g2" }));
  });

  it("« Diffuser » avec l'adresse munie du laissez-passer : le sélecteur AirPlay de l'élément, sans changer de lecteur (§186)", async () => {
    const tokenized = (version: string, audio = 2) => ({ ...verdictOf(version, audio), master: `/api/lumen/g1/${version}/S/tv.aaa.bbb/master.m3u8?audio=${audio}` });
    verdicts = [tokenized("2-aaaaaaaaaaaa")];
    await mount();
    const el = element();
    expect(el.video.getAttribute("src") ?? el.video.src).toContain("/S/tv.aaa.bbb/master.m3u8?audio=2#t=600");
    const picker = vi.fn();
    Object.assign(el.video, { webkitShowPlaybackTargetPicker: picker });
    act(() => el.picture(600));
    act(() => controls!.onCastRequest!());
    expect(picker).toHaveBeenCalledTimes(1);
    expect(onFallback).not.toHaveBeenCalled();
    // La route établie : la ligne `cast`, et la lecture continue ici (le retour au premier plan ne met pas en pause).
    Object.assign(el.video, { webkitCurrentPlaybackTargetIsWireless: true });
    act(() => el.video.dispatchEvent(new Event("webkitcurrentplaybacktargetiswirelesschanged")));
    expect(last("cast")).toMatchObject({ player: "lumen-serveur", cast: true, path: "remux-serveur" });
  });

  it("« Diffuser » : le lecteur serveur pour diffuser, un choix et non un échec", async () => {
    await mount();
    const el = element();
    act(() => el.picture(600));
    act(() => controls!.onCastRequest!());
    expect(onFallback).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ cast: true }), expect.any(String));
    expect(last("fallback")).toMatchObject({ cast: true, planned: true });
  });
});
