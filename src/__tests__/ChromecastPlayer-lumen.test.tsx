// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import { createFakeCast, type FakeCast } from "./helpers/fakeCast";

// DECISIONS.md §192 — le Chromecast par Lumen serveur, côté émetteur, sur le kit simulé : l'option de l'appareil
// décide de demander l'adresse du récepteur ; un refus du serveur garde le flux de Jellyfin ; un refus du récepteur,
// une absence d'image ou une erreur y reviennent à la même position, avec une ligne `fallback` qui le dit.

vi.mock("@/components/TranslationProvider", () => {
  const t = (key: string, vars?: Record<string, unknown>) => (vars ? `${key} ${JSON.stringify(vars)}` : key);
  const locale = { locale: "fr", setLocale: () => {} };
  return { useT: () => t, useLocale: () => locale };
});
const playback = { close: vi.fn(), advance: vi.fn(), minimize: vi.fn(), expand: vi.fn() };
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => playback }));
const reportPlayback = vi.fn();
vi.mock("@/lib/reportPlayback", () => ({ reportPlayback: (...args: unknown[]) => reportPlayback(...args) }));
vi.mock("@/lib/swr", () => ({ refreshAfterPlayback: vi.fn(async () => {}) }));
vi.mock("@/lib/resumeRewind", () => ({ noteWatching: vi.fn() }));
const sessionInfo: unknown[] = [];
vi.mock("@/lib/usePlaybackSession", () => ({
  usePlaybackSession: (_pos: () => number, info: unknown) => {
    sessionInfo.push(info);
    return { stop: vi.fn(async () => {}), reportNow: () => {}, resume: vi.fn(), savePaused: vi.fn() };
  },
  stopOrphanSession: vi.fn(async () => {}),
}));

import { ChromecastPlayer } from "@/components/player/ChromecastPlayer";
import { resetChromecastForTests, startChromecastSender } from "@/lib/chromecast/framework";
import { LUMEN_SERVER_KEY } from "@/lib/lumenServerChoice";
import { resetLumenCastMemory } from "@/lib/chromecast/lumenCast";

const ITEM = "a".repeat(32);
const JELLYFIN_URL = `https://cine.example/api/jellyfin/stream/${ITEM}/master.m3u8?castToken=t`;

function negotiation() {
  return {
    playSessionId: "play-1",
    mediaSourceId: "src-1",
    castUrl: JELLYFIN_URL,
    isDirectPlay: false,
    title: "Le Film",
    audioTracks: [
      { index: 1, language: "fre", title: null, codec: "eac3", channels: 6, profile: null, isDefault: true },
      { index: 2, language: "eng", title: null, codec: "aac", channels: 2, profile: null, isDefault: false },
    ],
    subtitleTracks: [{ index: 3, url: `/api/jellyfin/stream/subtitle/${ITEM}?mediaSourceId=src-1&index=3&castToken=t`, language: "fre", title: null, isDefault: false, isText: true }],
    playbackInfo: { playMethod: "Transcode" },
  };
}

/** Ce que répond `eligibility` : à régler par test. `audio` absent de la requête : la piste par défaut (2). */
let verdictFor: (query: URLSearchParams) => Record<string, unknown> = () => ({ ok: false, reason: "son-codec" });
const lumenQueries: URLSearchParams[] = [];
let fake: FakeCast;
const fetchMock = vi.fn(async (url: string) => {
  if (url === "/api/player/cast") return { ok: true, status: 200, json: async () => ({ allowed: true, receiverAppId: "CC1AD845" }) };
  if (url.startsWith(`/api/lumen/${ITEM}/eligibility?`)) {
    const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    lumenQueries.push(q);
    return { ok: true, status: 200, json: async () => verdictFor(q) };
  }
  return { ok: true, status: 200, json: async () => negotiation() };
});

const linesOf = (kind: string) => reportPlayback.mock.calls.filter((c) => c[0] === kind).map((c) => c[1] as Record<string, unknown>);
const loadedUrl = (i: number) => (fake.loads[i] as { media: { contentId: string } }).media.contentId;

function okVerdict(q: URLSearchParams, video: "h264" | "hevc" = "h264") {
  const audio = Number(q.get("audio") ?? 2);
  return {
    ok: true,
    audioTrack: audio,
    master: `/api/lumen/${ITEM}/5-0123456789ab/${q.get("s")}/cc.jeton.sig/master.m3u8?audio=${audio}`,
    castVideo: video,
    audio: [
      { number: 2, converted: "aac-192-20" },
      { number: 3, converted: null },
    ],
  };
}

async function mount(audioStreamIndex = 1) {
  const session = { itemId: ITEM, title: "Le Film", openId: 1 };
  render(
    <ChromecastPlayer
      session={session}
      mode="full"
      takeover={{ resumeAt: 600, audioStreamIndex, cast: true, castTarget: "chromecast", owner: session }}
      continuesSession="seance-1"
      onCastEnded={vi.fn()}
    />
  );
  await waitFor(() => expect(fake.loads.length).toBeGreaterThan(0));
}

beforeEach(async () => {
  vi.clearAllMocks();
  sessionInfo.length = 0;
  lumenQueries.length = 0;
  resetLumenCastMemory();
  resetChromecastForTests();
  window.localStorage.setItem(LUMEN_SERVER_KEY, "1");
  verdictFor = (q) => okVerdict(q);
  vi.stubGlobal("fetch", fetchMock);
  fake = createFakeCast();
  fake.install();
  await startChromecastSender();
  fake.connect("Salon");
});

afterEach(async () => {
  vi.useRealTimers();
  cleanup();
  window.localStorage.clear();
  await new Promise((resolve) => setTimeout(resolve, 5));
  vi.unstubAllGlobals();
});

describe("l'option coupée", () => {
  it("aucune question à Lumen serveur, le flux de Jellyfin comme avant, des lignes sans champ de plus", async () => {
    window.localStorage.removeItem(LUMEN_SERVER_KEY);
    await mount();
    expect(lumenQueries).toHaveLength(0);
    expect(loadedUrl(0)).toBe(JELLYFIN_URL);
    const start = linesOf("start")[0];
    expect(start).toMatchObject({ player: "serveur", path: "serveur", target: "chromecast" });
    expect(start).not.toHaveProperty("lumenSession");
    expect(start).not.toHaveProperty("lumenDeclined");
  });
});

describe("l'option allumée", () => {
  it("le récepteur charge l'adresse Lumen serveur, absolue, en HLS fMP4, à la position du relais", async () => {
    await mount();
    expect(lumenQueries[0].get("cast")).toBe("1");
    expect(lumenQueries[0].get("hevc")).toBeNull();
    const load = fake.loads[0] as { currentTime: number; media: { contentId: string; contentType: string; hlsSegmentFormat?: unknown; streamType?: unknown } };
    expect(load.media.contentId).toMatch(new RegExp(`^http://localhost(:\\d+)?/api/lumen/${ITEM}/5-0123456789ab/[A-Za-z0-9_-]+/cc\\.jeton\\.sig/master\\.m3u8\\?audio=2$`));
    expect(load.media.contentType).toBe("application/x-mpegurl");
    expect(load.media.hlsSegmentFormat).toBeDefined();
    expect(load.currentTime).toBe(600);
    const s = lumenQueries[0].get("s");
    expect(linesOf("start")[0]).toMatchObject({ player: "lumen-serveur", path: "remux-serveur", lumenSession: s, target: "chromecast", lumenAudio: "aac converti", lumenVideo: "h264" });
    await waitFor(() => expect(linesOf("cast")).toHaveLength(1));
    expect(linesOf("cast")[0]).toMatchObject({ player: "lumen-serveur", path: "remux-serveur", lumenSession: s });
    // La reprise reste rapportée à Jellyfin sous la séance négociée, sans transcodage.
    expect(sessionInfo.at(-1)).toMatchObject({ playSessionId: "play-1", playMethod: "DirectStream" });
  });

  it("une autre piste que celle par défaut : nommée par son rang (index Jellyfin 2 → piste Matroska 3)", async () => {
    await mount(2);
    expect(lumenQueries.map((q) => q.get("audio"))).toEqual([null, "3"]);
    expect(loadedUrl(0)).toContain("master.m3u8?audio=3");
  });

  it("un refus du serveur : le flux de Jellyfin tout de suite, la raison sur la ligne `start`", async () => {
    verdictFor = () => ({ ok: false, reason: "son-codec", detail: "chromecast : A_FLAC (AAC seulement)", audio: [] });
    await mount();
    expect(loadedUrl(0)).toBe(JELLYFIN_URL);
    expect(linesOf("start")[0]).toMatchObject({ player: "serveur", lumenDeclined: "son-codec (chromecast : A_FLAC (AAC seulement))" });
    expect(linesOf("fallback")).toHaveLength(0);
  });

  it("un chargement refusé par le récepteur : `fallback` avec le code, puis Jellyfin à la même position — et plus de Lumen pour ce titre", async () => {
    const session = fake.globals.framework.CastContext.getInstance().getCurrentSession() as { loadMedia: (r: unknown) => Promise<unknown> };
    const original = session.loadMedia;
    session.loadMedia = (request: unknown) => {
      const url = (request as { media: { contentId: string } }).media.contentId;
      if (url.includes("/cc.")) {
        fake.loads.push(request as Record<string, unknown>);
        return Promise.reject("load_media_failed");
      }
      return original(request);
    };
    await mount();
    await waitFor(() => expect(fake.loads.length).toBe(2));
    expect(loadedUrl(1)).toBe(JELLYFIN_URL);
    const fallback = linesOf("fallback")[0];
    expect(fallback).toMatchObject({ target: "chromecast", player: "lumen-serveur", path: "remux-serveur", to: "jellyfin", code: "load_media_failed", at: 600 });
    expect(linesOf("start")[1]).toMatchObject({ player: "serveur", path: "serveur", why: "ladder" });
    expect(String(linesOf("start")[1].trigger)).toMatch(/remux serveur/);
    expect(linesOf("error")).toHaveLength(0);
    expect(lumenQueries).toHaveLength(1);
  });

  it("aucune image en 25 s sur Lumen serveur : Jellyfin, et un récepteur qui a refusé le HEVC n'en reçoit plus", async () => {
    verdictFor = (q) => okVerdict(q, "hevc");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    await waitFor(() => expect(fake.loads.length).toBe(2));
    expect(loadedUrl(1)).toBe(JELLYFIN_URL);
    expect(linesOf("fallback")[0]).toMatchObject({ to: "jellyfin", path: "remux-serveur", picture: false });
    const { receiverRefusedHevc } = await import("@/lib/chromecast/lumenCast");
    expect(receiverRefusedHevc("Salon")).toBe(true);
  });

  it("une erreur du récepteur en cours de lecture : Jellyfin à la dernière position, pas d'écran d'erreur", async () => {
    await mount();
    await waitFor(() => expect(linesOf("cast")).toHaveLength(1));
    act(() => fake.play(1300));
    act(() => fake.idle("ERROR"));
    await waitFor(() => expect(fake.loads.length).toBe(2));
    expect(loadedUrl(1)).toBe(JELLYFIN_URL);
    expect((fake.loads[1] as { currentTime: number }).currentTime).toBe(1300);
    expect(linesOf("fallback")[0]).toMatchObject({ to: "jellyfin", picture: true });
    expect(linesOf("error")).toHaveLength(0);
  });
});
