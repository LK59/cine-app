// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import { useEffect } from "react";

// Le rechargement direct (DECISIONS.md §78, `serverReload.ts`) : sur WebKit, la bascule du lecteur
// natif vers le lecteur serveur recharge la page tout de suite, au lieu d'essayer le HLS natif dans
// une page qui a servi le lecteur natif — ce que WebKit refusait (12/10/2026 : code 4, trois marches
// de l'échelle audio, puis le rechargement de dernier recours ; ~10 s perdues à chaque bascule). Et
// tout rechargement emporte le palier allégé en cours, sans dépendre de la mémoire des deux minutes.
//
// Le vrai PlaybackProvider et le vrai aiguillage de PlayerHost : la première page écrit l'intention,
// la seconde (un nouveau montage) la relit — comme sur l'appareil.

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
/** Le lecteur natif simulé : on garde de quoi lui faire passer la main. */
const native: { onFallback: null | ((reason: string, takeover?: Record<string, unknown>, sessionId?: string) => void) } = { onFallback: null };
vi.mock("@/components/ExperimentalPlayerHost", () => ({
  ExperimentalPlayerHost: (props: { onFallback: typeof native.onFallback }) => {
    native.onFallback = props.onFallback;
    return <div data-testid="natif" />;
  },
}));
/** Les commandes simulées : on garde de quoi changer de piste audio. */
const controls: { onChangeAudio: null | ((id: number) => void) } = { onChangeAudio: null };
vi.mock("@/components/PlayerControls", () => ({
  VOLUME_STORAGE_KEY: "volume",
  PlayerControls: (props: { onChangeAudio: (id: number) => void }) => {
    controls.onChangeAudio = props.onChangeAudio;
    return <div data-testid="commandes" />;
  },
}));
vi.mock("@/lib/useAccountPreferences", () => ({ useAccountPreferencesLoader: () => {} }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));
const reported: { kind: string; fields: Record<string, unknown> }[] = [];
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: (kind: string, fields: Record<string, unknown>) => void reported.push({ kind, fields }) }));
vi.mock("@/lib/unsentStop", () => ({ flushOrphanStops: () => {}, saveUnsentStop: () => {}, clearUnsentStop: () => {}, touchUnsentStop: () => {} }));
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: async () => {} }));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
/** WebKit (HLS natif) par défaut ; hls.js quand un test le dit. */
let nativeHls = true;
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => nativeHls }));
vi.mock("@/lib/resumePosition", () => ({ resolveResumeAt: async (_id: string, at: number | undefined) => at ?? 0 }));
vi.mock("@/lib/castRoute", () => ({ castRouteActive: () => false }));
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: () => ({ stop: vi.fn(async () => {}), reportNow: () => {}, resume: vi.fn() }),
  stopOrphanSession: vi.fn(async () => {}),
}));
const reloads = vi.fn();
vi.mock("@/lib/serverReload", async (original) => ({
  ...(await original<typeof import("@/lib/serverReload")>()),
  reloadPage: () => reloads(),
}));

import { PlaybackProvider, PLAYER_RELOAD_INTENT_KEY, usePlayback, type PlaybackSession } from "@/components/PlaybackProvider";
import { PlayerHost } from "@/components/PlayerHost";
import { forgetPrewarm, startPrewarm } from "@/lib/lighterPrewarm";
import { carriedLighter, forgetLighterCarry, writePlaybackQuality } from "@/lib/playbackQuality";
import { shouldReloadDirect } from "@/lib/serverReload";

const STEP = { targetBps: 1_500_000, tier: 1 };
const startBodies: Record<string, unknown>[] = [];
/** Les négociations du lecteur lui-même — un préchauffage n'en est pas une. */
const playerNegotiations = () => startBodies.filter((b) => b.prewarm !== true);
const starts = () => reported.filter((r) => r.kind === "start").map((r) => r.fields);

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  startBodies.length = 0;
  reported.length = 0;
  reloads.mockClear();
  native.onFallback = null;
  controls.onChangeAudio = null;
  nativeHls = true;
  writePlaybackQuality("auto");
  forgetLighterCarry();
  forgetPrewarm();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/jellyfin/playback/start") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        startBodies.push(body);
        const id = body.prewarm ? "seance-prechauffee" : `seance-${startBodies.length}`;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            playSessionId: id,
            mediaSourceId: "source",
            isDirectPlay: false,
            manifestUrl: `/api/jellyfin/stream/film/master.m3u8?DeviceId=appareil&MediaSourceId=source&PlaySessionId=${id}`,
            audioTracks: [],
            subtitleTracks: [],
            title: "Film",
          }),
        };
      }
      if (String(url).includes("master.m3u8")) return { ok: true, status: 200, text: async (): Promise<string> => "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720\nmain.m3u8?x=1\n" };
      if (String(url).includes("main.m3u8")) return { ok: true, status: 200, text: async (): Promise<string> => "#EXTM3U\n#EXTINF:600,\nhls1/main/0.mp4\n#EXTINF:600,\nhls1/main/1.mp4\n#EXT-X-ENDLIST\n" };
      if (String(url).includes("/hls1/main/")) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(10) };
      return { ok: true, status: 200, json: async () => ({}), text: async (): Promise<string> => "" };
    })
  );
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Lance une lecture comme le ferait une fiche. */
function Starter({ session }: { session: PlaybackSession }) {
  const { play } = usePlayback();
  useEffect(() => play(session), [play, session]);
  return null;
}

const page = (session?: PlaybackSession) =>
  render(
    <PlaybackProvider>
      {session && <Starter session={session} />}
      <PlayerHost />
    </PlaybackProvider>
  );

const film: PlaybackSession = { itemId: "film", title: "Film", resumeAt: 0 };

describe("WebKit : la bascule natif → serveur recharge la page tout de suite", () => {
  it("aucune tentative dans la page ; l'intention emporte position, piste, sous-titre, palier (bascule réelle) et la séance ; le préchauffage est repris tel quel après le rechargement", async () => {
    page(film);
    await waitFor(() => expect(native.onFallback).not.toBeNull());
    const prewarm = startPrewarm({ itemId: "film", step: STEP, startSeconds: 600, audioStreamIndex: 2 });
    expect(await prewarm.ready).toBe(true);

    act(() =>
      native.onFallback!("connexion trop lente (version allégée demandée)", { resumeAt: 600, audioStreamIndex: 2, lighter: STEP, switchedAt: Date.now(), subtitleStreamIndex: 7 }, "seance-natif")
    );
    expect(reloads).toHaveBeenCalledTimes(1);
    // Rien d'essayé dans la page : ni négociation, ni lecteur serveur monté.
    expect(playerNegotiations()).toHaveLength(0);
    expect(document.querySelector("[data-testid=natif]")).not.toBeNull();
    const intent = JSON.parse(sessionStorage.getItem(PLAYER_RELOAD_INTENT_KEY) ?? "null");
    expect(intent).toMatchObject({
      itemId: "film",
      resumeAt: 600,
      audioStreamIndex: 2,
      attempt: 1,
      server: true,
      carry: { direct: { opening: false }, lighter: { ...STEP, real: true }, subtitleStreamIndex: 7, continues: "seance-natif" },
    });

    // La page rechargée.
    cleanup();
    page();
    await waitFor(() => expect(starts()).toHaveLength(1), { timeout: 6000 });
    expect(document.querySelector("[data-testid=natif]")).toBeNull();
    // Le préchauffage repris : aucune négociation de plus, même séance Jellyfin.
    expect(playerNegotiations()).toHaveLength(0);
    const start = starts()[0];
    expect(start).toMatchObject({ why: "reload-direct", session: "seance-natif", lighterMbps: 1.5, lighterTier: 1, lighterReloaded: true, at: 600, audioStreamIndex: 2 });
    expect(start.lighterCarried).toBeUndefined();
    expect(start.prewarm).toMatchObject({ used: true, carried: 1 });
    expect(starts().some((s) => s.why === "ladder")).toBe(false);
    expect(document.querySelector("video")!.getAttribute("src")).toContain("PlaySessionId=seance-prechauffee");

    // La première image : l'interruption depuis la décision, au bilan ; une vraie bascule retient son palier.
    act(() => void document.querySelector("video")!.dispatchEvent(new Event("loadeddata")));
    cleanup();
    const stop = reported.find((r) => r.kind === "stop")!.fields;
    expect(stop.reloadGapMs).toBeTypeOf("number");
    expect(String(stop.slowLink)).toContain("rechargement direct");
    expect(carriedLighter()).toEqual(STEP);
  }, 15_000);

  // Choix de Louis (12/10/2026) : seules les bascules allégées rechargent — un repli ordinaire passe
  // la main dans la page, son chemin éprouvé (5 des 6 replis de « Ruby » sur iPhone y ont marché).
  // Safari refuse de reprendre seul dans la page rechargée : le message reste, avec quoi faire, jusqu'à
  // la lecture (12/10/2026 — disparu au bout de 5 s, il laissait une image figée sans explication).
  it("après le rechargement, Safari refuse la reprise automatique : « Touchez Lecture » reste jusqu'à la lecture", async () => {
    page(film);
    await waitFor(() => expect(native.onFallback).not.toBeNull());
    act(() => native.onFallback!("connexion trop lente (version allégée demandée)", { resumeAt: 600, lighter: STEP, switchedAt: Date.now() }, "seance-natif"));
    cleanup();
    (HTMLMediaElement.prototype.play as unknown as { mockImplementation: (f: () => Promise<void>) => void }).mockImplementation(() =>
      Promise.reject(new DOMException("pas de geste", "NotAllowedError"))
    );
    page();
    await waitFor(() => expect(document.querySelector("[data-lighter-tap-notice]")).not.toBeNull(), { timeout: 6000 });
    await act(() => new Promise((r) => setTimeout(r, 5200)));
    expect(document.querySelector("[data-lighter-tap-notice]")).not.toBeNull();
    act(() => void document.querySelector("video")!.dispatchEvent(new Event("playing")));
    await waitFor(() => expect(document.querySelector("[data-lighter-tap-notice]")).toBeNull());
  }, 20_000);

  it("un repli ordinaire (sans palier) ne recharge pas : il passe la main dans la page, comme avant", async () => {
    page(film);
    await waitFor(() => expect(native.onFallback).not.toBeNull());
    act(() => native.onFallback!("Aucun chemin de lecture disponible pour ce fichier. remux : x"));
    expect(reloads).not.toHaveBeenCalled();
    await waitFor(() => expect(starts()).toHaveLength(1));
    expect(starts()[0].why).not.toBe("reload-direct");
    expect(sessionStorage.getItem(PLAYER_RELOAD_INTENT_KEY)).toBeNull();
  });

  it("une seule tentative par séance : une séance qui a déjà consommé son rechargement passe la main dans la page, comme avant", async () => {
    page({ ...film, reloadAttempt: 1 });
    await waitFor(() => expect(native.onFallback).not.toBeNull());
    act(() => native.onFallback!("connexion trop lente (version allégée demandée)", { resumeAt: 600, lighter: STEP }, "seance-natif"));
    expect(reloads).not.toHaveBeenCalled();
    await waitFor(() => expect(starts()).toHaveLength(1));
    expect(starts()[0].why).toBe("handover");
    expect(shouldReloadDirect({ nativeHls: true, serverFallback: true, takeover: undefined, reloadAttempt: 1, bench: undefined })).toBe(false);
  });

  it("une diffusion (AirPlay, Chromecast) ou le banc d'essai : jamais de rechargement", () => {
    const base = { nativeHls: true, serverFallback: true as boolean | undefined, reloadAttempt: 0, bench: undefined as string | undefined };
    expect(shouldReloadDirect({ ...base, takeover: { resumeAt: 0, cast: true } })).toBe(false);
    expect(shouldReloadDirect({ ...base, takeover: { resumeAt: 0, castTarget: "chromecast" } })).toBe(false);
    expect(shouldReloadDirect({ ...base, takeover: undefined, bench: "banc" })).toBe(false);
    expect(shouldReloadDirect({ ...base, takeover: undefined, serverFallback: false })).toBe(false);
    expect(shouldReloadDirect({ ...base, takeover: undefined })).toBe(false);
    expect(shouldReloadDirect({ ...base, takeover: { resumeAt: 0, lighter: { targetBps: 1_500_000, tier: 1 } } })).toBe(true);
  });
});

describe("ailleurs, rien ne change", () => {
  it("hls.js : la bascule passe la main dans la page, sans rechargement", async () => {
    nativeHls = false;
    page(film);
    await waitFor(() => expect(native.onFallback).not.toBeNull());
    act(() => native.onFallback!("connexion trop lente (version allégée demandée)", { resumeAt: 600, lighter: STEP }, "seance-natif"));
    expect(reloads).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PLAYER_RELOAD_INTENT_KEY)).toBeNull();
    await waitFor(() => expect(starts()).toHaveLength(1));
    expect(starts()[0]).toMatchObject({ why: "handover", lighterMbps: 1.5 });
  });

  // L'ouverture directe au lecteur serveur passait par la préférence « lecteur legacy » du compte,
  // disparue le 13/10/2026 ; il en reste une — la version allégée héritée d'une séance récente.
  it("WebKit, ouverture directe au lecteur serveur (aucune lecture native avant) : la lecture dans la page, sans rechargement", async () => {
    page({ ...film, lighter: STEP });
    await waitFor(() => expect(starts()).toHaveLength(1));
    expect(starts()[0].why).toBe("open");
    expect(reloads).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(PLAYER_RELOAD_INTENT_KEY)).toBeNull();
  });
});

describe("tout rechargement emporte le palier allégé en cours", () => {
  it("changer de piste audio sur une séance allégée : l'intention porte le palier, et dit qu'il n'est qu'hérité", async () => {
    page({ ...film, lighter: STEP });
    await waitFor(() => expect(controls.onChangeAudio).not.toBeNull());
    await waitFor(() => expect(starts()).toHaveLength(1));
    act(() => controls.onChangeAudio!(3));
    const intent = JSON.parse(sessionStorage.getItem(PLAYER_RELOAD_INTENT_KEY) ?? "null");
    expect(intent).toMatchObject({ itemId: "film", audioStreamIndex: 3, server: true, carry: { lighter: { ...STEP, real: false } } });
  });

  it("audio-reload d'une séance allégée, mémoire des deux minutes expirée : la page rechargée reste allégée, sans réarmer la mémoire", async () => {
    sessionStorage.setItem(
      PLAYER_RELOAD_INTENT_KEY,
      JSON.stringify({ itemId: "film", title: "Film", audioStreamIndex: 3, resumeAt: 300, server: true, carry: { lighter: { ...STEP, real: false } } })
    );
    page();
    await waitFor(() => expect(starts()).toHaveLength(1), { timeout: 6000 });
    expect(playerNegotiations()[0]).toMatchObject({ lighter: true, maxBitrate: 1_500_000, audioStreamIndex: 3 });
    expect(starts()[0]).toMatchObject({ why: "audio-reload", lighterMbps: 1.5, lighterCarried: true, lighterReloaded: true });
    act(() => void document.querySelector("video")!.dispatchEvent(new Event("loadeddata")));
    cleanup();
    expect(carriedLighter()).toBeNull();
  }, 10_000);

  it("audio-reload d'une vraie bascule : allégée, et son arrêt retient le palier comme avant le rechargement", async () => {
    sessionStorage.setItem(
      PLAYER_RELOAD_INTENT_KEY,
      JSON.stringify({ itemId: "film", title: "Film", audioStreamIndex: 3, resumeAt: 300, server: true, carry: { lighter: { ...STEP, real: true } } })
    );
    page();
    await waitFor(() => expect(starts()).toHaveLength(1), { timeout: 6000 });
    expect(starts()[0]).toMatchObject({ why: "audio-reload", lighterMbps: 1.5, lighterReloaded: true });
    expect(starts()[0].lighterCarried).toBeUndefined();
    cleanup();
    expect(carriedLighter()).toEqual(STEP);
  }, 10_000);

  it("« Originale » choisie entre-temps : la page rechargée repart en pleine qualité", async () => {
    writePlaybackQuality("original");
    sessionStorage.setItem(
      PLAYER_RELOAD_INTENT_KEY,
      JSON.stringify({ itemId: "film", title: "Film", audioStreamIndex: 3, resumeAt: 300, server: true, carry: { lighter: { ...STEP, real: true } } })
    );
    page();
    await waitFor(() => expect(starts()).toHaveLength(1), { timeout: 6000 });
    expect(playerNegotiations()[0].lighter).toBeUndefined();
  }, 10_000);
});
