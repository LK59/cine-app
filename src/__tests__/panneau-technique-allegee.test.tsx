// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import { useEffect } from "react";

// Le panneau d'infos techniques fidèle en version allégée (§78, relevé de Louis du 12/10/2026) : la
// section « Fichier » décrivait la source (4K HEVC Dolby Vision 30 Mbit/s) pendant que l'appareil
// recevait du HEVC 720p SDR à 1,5 Mbit/s ; le titre disait « Transcodage » sans la cause ; et après le
// rechargement direct WebKit, la note « a cédé la main » disparaissait. Le panneau montre désormais ce
// qui est diffusé, nomme la version allégée, et garde la cause à travers le rechargement — sans rien
// inventer quand une information manque.

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) => (vars ? `${key}${JSON.stringify(vars)}` : key),
  useLocale: () => ({ locale: "fr", setLocale: () => {} }),
}));
vi.mock("@/lib/useViewportResizing", () => ({ useViewportResizing: () => false }));
vi.mock("@/lib/useWakeLock", () => ({ useWakeLock: () => {} }));
vi.mock("@/lib/playerBench/bridge", () => ({ publishHandedOver: () => {} }));
vi.mock("@/components/MiniPlayer", () => ({
  MiniPlayerChrome: () => <div data-testid="mini" />,
  useMiniPlayerDrag: () => ({ pos: { x: 0, y: 0 }, size: { width: 1, height: 1 }, isDragging: false, handlers: {} }),
}));
/** Le panneau simulé : on garde ce que le lecteur serveur lui donne. */
const panel: { data: PanelData | null } = { data: null };
vi.mock("@/components/PlaybackInfoPanel", () => ({
  PlaybackInfoPanel: (props: { data: PanelData | null }) => {
    panel.data = props.data;
    return null;
  },
}));
const native: { onFallback: null | ((reason: string, takeover?: Record<string, unknown>, sessionId?: string) => void) } = { onFallback: null };
vi.mock("@/components/ExperimentalPlayerHost", () => ({
  ExperimentalPlayerHost: (props: { onFallback: typeof native.onFallback }) => {
    native.onFallback = props.onFallback;
    return <div data-testid="natif" />;
  },
}));
vi.mock("@/components/PlayerControls", () => ({ VOLUME_STORAGE_KEY: "volume", PlayerControls: () => <div data-testid="commandes" /> }));
vi.mock("@/lib/useAccountPreferences", () => ({ useAccountPreferencesLoader: () => {} }));
vi.mock("@/lib/usePlayerEnabled", () => ({ usePlayerServerFallback: () => true }));
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: () => {} }));
vi.mock("@/lib/unsentStop", () => ({ flushOrphanStops: () => {}, saveUnsentStop: () => {}, clearUnsentStop: () => {}, touchUnsentStop: () => {} }));
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: async () => {} }));
vi.mock("@/lib/codecSupport", () => ({ detectCodecSupport: async () => ({}) }));
vi.mock("@/lib/webkitEngine", () => ({ playsHlsNatively: () => true }));
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
import { forgetPrewarm } from "@/lib/lighterPrewarm";
import { forgetLighterCarry, writePlaybackQuality } from "@/lib/playbackQuality";
import {
  codecName,
  describeJellyfinPlayback,
  describeRemuxPlayback,
  masterVariantFacts,
  splitCodecs,
  type JellyfinPlayback,
} from "@/lib/playbackPanel";
import { directReloadIntent, parseReloadIntent } from "@/lib/serverReload";
import { readLink, streamNeedBps } from "@/lib/slowLink";

interface PanelData {
  headline: { name: string; detail: string; tone: string };
  notes: string[];
  sections: { title: string; rows: { label: string; value: string }[] }[];
}

const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}${JSON.stringify(vars)}` : key);
const STEP = { targetBps: 1_500_000, tier: 1 };
const REASON = "connexion trop lente (version allégée demandée)";

/** Le 4K HEVC Dolby Vision du relevé, tel que Jellyfin le décrit (la source). */
const SOURCE: JellyfinPlayback = {
  playMethod: "Transcode",
  transcodeReasons: ["ContainerBitrateExceedsLimit"],
  container: "mkv",
  video: { codec: "hevc", profile: "Main 10", width: 3840, height: 2160, bitDepth: 10, frameRate: 23.976, bitRate: 30_000_000, rangeType: "DOVIWithHDR10" },
  audio: { codec: "eac3", channels: 6, bitRate: 640_000, language: "fre" },
  streamBitrate: 1_500_000,
};
const SERVED = { videoCodec: "hvc1.2.4.L150.B0", audioCodec: "mp4a.40.2", videoRange: "SDR", width: 1280, height: 534 };

const rowsOf = (section: PanelData["sections"][number] | undefined) => Object.fromEntries((section?.rows ?? []).map((r) => [r.label, r.value]));
const sectionNamed = (data: PanelData, title: string) => data.sections.find((s) => s.title === title);

describe("le panneau du lecteur serveur", () => {
  it("version allégée : le titre la nomme avec son débit, « Diffusé » dit ce qui est reçu, le fichier est « d'origine »", () => {
    const data = describeJellyfinPlayback(SOURCE, null, null, t, { ...readLink(null, null), lighter: STEP }, { served: SERVED, origin: { kind: "switch", at: 600 } });
    expect(data.headline).toEqual({
      name: "player.info.lighterName",
      detail: `player.info.describeLighter${JSON.stringify({ rate: "1.5 Mb/s" })}`,
      tone: "warn",
    });
    // « Diffusé » en premier : ce que l'appareil reçoit vraiment.
    expect(data.sections[0].title).toBe("player.info.sections.served");
    expect(rowsOf(data.sections[0])).toEqual({
      "player.info.video": "HEVC",
      "player.info.resolution": "1280×534",
      "player.info.bitrate": "1.5 Mb/s",
      "player.info.range": "SDR",
      "player.info.audio": "AAC",
    });
    const file = rowsOf(sectionNamed(data, "player.info.sections.fileOriginal"));
    expect(file["player.info.resolution"]).toBe("3840×2160");
    expect(file["player.info.range"]).toBe("DOVIWithHDR10");
    expect(sectionNamed(data, "player.info.sections.file")).toBeUndefined();
    expect(data.notes).toContain(`player.info.lighterSwitchedAt${JSON.stringify({ position: "10:00" })}`);
  });

  it("palier hérité (règle des deux minutes) : dit comme tel ; plage SDR sans maître, puisque l'allégée est toujours convertie", () => {
    const data = describeJellyfinPlayback(
      SOURCE,
      null,
      null,
      t,
      { ...readLink(null, null), lighter: STEP },
      { served: { ...SERVED, videoRange: null }, origin: { kind: "inherited" } }
    );
    expect(data.notes).toContain("player.info.lighterInherited");
    expect(data.notes.some((n) => n.startsWith("player.info.lighterSwitched"))).toBe(false);
    expect(rowsOf(data.sections[0])["player.info.range"]).toBe("SDR");
  });

  it("transcodage ordinaire : aucune mention de version allégée ; une source HDR sans plage annoncée n'a pas de ligne de plage", () => {
    const data = describeJellyfinPlayback(
      { ...SOURCE, streamBitrate: 20_000_000 },
      null,
      null,
      t,
      readLink(null, null),
      { served: { ...SERVED, videoRange: null, width: 3840, height: 2160 }, origin: { kind: "switch", at: 600 } }
    );
    expect(data.headline).toEqual({ name: "player.info.transcode", detail: "player.info.describeTranscode", tone: "warn" });
    expect(data.notes.some((n) => n.includes("lighter"))).toBe(false);
    const served = rowsOf(data.sections[0]);
    expect(served["player.info.bitrate"]).toBe("20.0 Mb/s");
    expect(served["player.info.range"]).toBeUndefined();
    // Une source SDR reste SDR : un transcodage ne fabrique pas de HDR.
    const sdr = describeJellyfinPlayback({ ...SOURCE, video: { ...SOURCE.video!, rangeType: "SDR" } }, null, null, t, null, { served: { ...SERVED, videoRange: null } });
    expect(rowsOf(sdr.sections[0])["player.info.range"]).toBe("SDR");
    // Le maître qui annonce du PQ.
    const pq = describeJellyfinPlayback(SOURCE, null, null, t, null, { served: { ...SERVED, videoRange: "PQ" } });
    expect(rowsOf(pq.sections[0])["player.info.range"]).toBe("HDR (PQ)");
  });

  it("aucune ligne inventée : rien de connu sur le flux envoyé → pas de section « Diffusé »", () => {
    const data = describeJellyfinPlayback(
      { ...SOURCE, streamBitrate: null, video: { ...SOURCE.video!, rangeType: "HDR10" } },
      null,
      null,
      t,
      null,
      { served: { videoCodec: null, audioCodec: null, videoRange: null, width: null, height: null } }
    );
    expect(sectionNamed(data, "player.info.sections.served")).toBeUndefined();
    expect(sectionNamed(data, "player.info.sections.fileOriginal")).toBeDefined();
    // Sans extra du tout (appelant d'avant) : pareil.
    expect(sectionNamed(describeJellyfinPlayback({ ...SOURCE, streamBitrate: null }, null, null, t), "player.info.sections.served")).toBeUndefined();
  });

  it("lecture directe et remultiplexage : inchangés — pas de « Diffusé », « Le fichier », jamais de version allégée", () => {
    for (const playMethod of ["DirectPlay", "DirectStream"] as const) {
      const data = describeJellyfinPlayback({ ...SOURCE, playMethod, transcodeReasons: [] }, null, null, t, { ...readLink(null, null), lighter: STEP }, { served: SERVED, origin: { kind: "switch", at: 1 } });
      expect(data.sections.map((s) => s.title)).toEqual(["player.info.sections.file", "player.info.sections.sound", "player.info.sections.stream"]);
      expect(data.headline.name).toBe(playMethod === "DirectPlay" ? "player.info.directPlay" : "player.info.directStream");
      expect(data.notes).toEqual([]);
    }
  });

  it("la cause du relais reste une note à part", () => {
    const data = describeJellyfinPlayback(SOURCE, null, REASON, t, { ...readLink(null, null), lighter: STEP }, { served: SERVED, origin: null });
    expect(data.notes).toContain(`player.info.gaveWay${JSON.stringify({ reason: REASON })}`);
  });
});

describe("le panneau du lecteur natif", () => {
  const remux = { path: "remux" as const, pathReason: null, container: "mkv", audioTrackCount: 1, subtitleTrackCount: 0, currentAudioCodec: "AAC", diagnostics: {} };
  it("ne dit pas « SDR » d'un fichier pas encore décrit ; décrit, sa plage telle quelle", () => {
    const pending = describeRemuxPlayback({ ...remux, path: null, video: null }, t);
    expect(rowsOf(pending.sections[0])["player.info.range"]).toBeUndefined();
    const hdr = describeRemuxPlayback({ ...remux, video: { codec: "hevc", width: 3840, height: 2160, bitDepth: 10, rangeType: "HDR10" } }, t);
    expect(rowsOf(hdr.sections[0])["player.info.range"]).toBe("HDR10");
    expect(rowsOf(hdr.sections[0])["player.info.video"]).toBe("hevc · 3840×2160 · 10 bits");
  });
});

describe("ce que le panneau lit", () => {
  it("le maître : codecs et plage de la première variante", () => {
    const master =
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000,AVERAGE-BANDWIDTH=1500000,VIDEO-RANGE=SDR,CODECS="hvc1.2.4.L150.B0,mp4a.40.2",RESOLUTION=1280x533\nmain.m3u8?x=1\n';
    expect(masterVariantFacts(master)).toEqual({ codecs: "hvc1.2.4.L150.B0,mp4a.40.2", videoRange: "SDR" });
    expect(masterVariantFacts("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmain.m3u8\n")).toBeNull();
    expect(masterVariantFacts("")).toBeNull();
  });

  it("des noms lisibles, l'inconnu tel quel", () => {
    expect(splitCodecs("hvc1.2.4.L150.B0,mp4a.40.2")).toEqual({ video: "hvc1.2.4.L150.B0", audio: "mp4a.40.2" });
    expect(splitCodecs(null)).toEqual({ video: null, audio: null });
    expect(codecName("avc1.640028")).toBe("H.264");
    expect(codecName("hev1.1.6.L120")).toBe("HEVC");
    expect(codecName("ec-3")).toBe("E-AC-3");
    expect(codecName("mp4a.40.2")).toBe("AAC");
    expect(codecName("xyz9")).toBe("xyz9");
    expect(codecName(null)).toBeNull();
  });

  it("le besoin d'un flux transcodé est le débit que Jellyfin vise, pas celui de la source", () => {
    expect(streamNeedBps({ video: { bitRate: 6_131_829 }, audio: { bitRate: 384_000 }, streamBitrate: 1_500_000 })).toBe(1_500_000);
    expect(streamNeedBps({ video: { bitRate: 6_000_000 }, audio: { bitRate: 400_000 }, streamBitrate: null })).toBe(6_400_000);
  });

  it("l'intention du rechargement direct emporte la cause et la position de la bascule ; relue bornée", () => {
    const intent = directReloadIntent({ itemId: "film", title: "Film", resumeAt: 0 }, { resumeAt: 600, lighter: STEP } as never, "seance", REASON, 1);
    expect(intent.carry).toMatchObject({ reason: REASON, lighter: { ...STEP, real: true, at: 600 } });
    const back = parseReloadIntent(JSON.stringify({ ...intent, carry: { ...intent.carry, reason: "x".repeat(1000) } }));
    expect(back?.carry?.reason).toHaveLength(300);
    expect(back?.carry?.lighter?.at).toBe(600);
    expect(parseReloadIntent(JSON.stringify({ itemId: "film", carry: { reason: 3 } }))?.carry?.reason).toBeUndefined();
  });
});

// --- dans le vrai lecteur ------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(async () => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  reloads.mockClear();
  native.onFallback = null;
  panel.data = null;
  writePlaybackQuality("auto");
  forgetLighterCarry();
  forgetPrewarm();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/jellyfin/playback/start") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            playSessionId: "seance-1",
            mediaSourceId: "source",
            isDirectPlay: false,
            manifestUrl: "/api/jellyfin/stream/film/master.m3u8?DeviceId=appareil&PlaySessionId=seance-1",
            audioTracks: [],
            subtitleTracks: [],
            title: "Film",
            // Ce que la route renvoie à Safari : la source, le débit visé, et ce que le maître annonce.
            playbackInfo: { ...SOURCE, requestedVideoCodecs: ["hevc", "h264"], served: { codecs: "hvc1.2.4.L150.B0,mp4a.40.2", videoRange: "SDR" } },
          }),
        };
      }
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

describe("après le rechargement direct WebKit", () => {
  it("la cause et la bascule survivent ; « Diffusé » dit le codec annoncé et la taille décodée, suivie au `resize`", async () => {
    page({ itemId: "film", title: "Film", resumeAt: 0 });
    await waitFor(() => expect(native.onFallback).not.toBeNull());
    act(() => native.onFallback!(REASON, { resumeAt: 600, lighter: STEP, switchedAt: Date.now() }, "seance-natif"));
    expect(reloads).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(PLAYER_RELOAD_INTENT_KEY) ?? "null").carry).toMatchObject({ reason: REASON, lighter: { at: 600 } });

    // La page rechargée.
    cleanup();
    page();
    await waitFor(() => expect(panel.data).not.toBeNull(), { timeout: 6000 });
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 1280 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 534 });
    act(() => void video.dispatchEvent(new Event("resize")));
    await waitFor(() => expect(rowsOf(panel.data!.sections[0])["player.info.resolution"]).toBe("1280×534"));

    const data = panel.data!;
    expect(data.headline.name).toBe("player.info.lighterName");
    expect(data.notes).toContain(`player.info.gaveWay${JSON.stringify({ reason: REASON })}`);
    expect(data.notes).toContain(`player.info.lighterSwitchedAt${JSON.stringify({ position: "10:00" })}`);
    expect(rowsOf(data.sections[0])).toMatchObject({ "player.info.video": "HEVC", "player.info.bitrate": "1.5 Mb/s", "player.info.range": "SDR", "player.info.audio": "AAC" });
    expect(sectionNamed(data, "player.info.sections.fileOriginal")).toBeDefined();
  }, 15_000);
});

// Un fichier que l'appareil ne sait pas lire : le serveur le réencode, et le chargement dit pourquoi
// il est plus long (13/10/2026 — un téléphone Android refermait au bout de quatre secondes muettes).
describe("relais pour un fichier que l'appareil ne lit pas", () => {
  it("« Préparation d'une version compatible… » dès le chargement, puis plus rien une fois l'image là", async () => {
    page({ itemId: "film", title: "Film", resumeAt: 0 });
    await waitFor(() => expect(native.onFallback).not.toBeNull());
    act(() => native.onFallback!("Aucun chemin de lecture disponible pour ce fichier. remux : Vidéo non prise en charge par ce navigateur : video/mp4; codecs=\"hvc1.2.4.L150.90\""));
    await waitFor(() => expect(document.body.textContent).toContain("player.compatPrep"), { timeout: 6000 });
    const video = document.querySelector("video")!;
    act(() => void video.dispatchEvent(new Event("loadeddata")));
    await waitFor(() => expect(document.body.textContent).not.toContain("player.compatPrep"));
  }, 15_000);
});
