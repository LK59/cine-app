import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CinemaEpisode, CinemaSeason } from "@/app/api/cinema/series/[jellyfinId]/episodes/route";
import type { DirectPlayAudioTrack, DirectPlayInfo } from "@/app/api/jellyfin/direct/[itemId]/route";
import type { OfflineDownload, OfflineRequest } from "@/lib/offline/downloads";

/**
 * Les épisodes hors ligne (§109, 19/10/2026) : une saison demandée d'un geste — la langue choisie une
 * fois, la bonne piste retrouvée dans chaque épisode —, le téléchargement automatique à mi-épisode, et
 * « Épisode suivant » depuis l'appareil ou en ligne.
 */

const started: OfflineRequest[] = [];
let held: OfflineDownload[] = [];
const infos = new Map<string, DirectPlayInfo>();

vi.mock("@/lib/directInfo", () => ({
  fetchDirectInfo: (itemId: string) => {
    const info = infos.get(itemId);
    return info ? Promise.resolve(info) : Promise.reject(new Error(`inconnu ${itemId}`));
  },
}));
vi.mock("@/lib/offline/downloads", () => ({
  startOfflineDownload: async (request: OfflineRequest) => {
    started.push(request);
  },
  offlineEpisodesOf: () => held,
  offlineDownloadById: (id: string) => held.find((d) => d.id === id) ?? null,
}));

import {
  autoNextDue,
  downloadNextEpisode,
  episodesToDownload,
  estimatedEpisodesBytes,
  offlineEpisodeTitle,
  offlineNextTarget,
  requestSeasonDownloads,
  trackForLanguage,
  watchedThrough,
} from "@/lib/offline/episodeDownloads";

const labeller = { locale: "fr", canaux: (n: number) => `${n} canaux`, piste: (n: number) => `Piste ${n}` };
const SERIES = { seriesItemId: "jfs", sonarrId: 7, seriesTitle: "Une série" };

const audio = (index: number, language: string | null, isDefault = false): DirectPlayAudioTrack =>
  ({ index, codec: "aac", language, displayTitle: null, channels: 2, isDefault, profile: null }) as DirectPlayAudioTrack;
const info = (tracks: DirectPlayAudioTrack[], runtimeSeconds = 2700) => ({ audio: tracks, runtimeSeconds, originalLanguage: null }) as unknown as DirectPlayInfo;

const ep = (season: number, n: number, id = `s${season}e${n}`): CinemaEpisode => ({
  jellyfinItemId: id,
  seasonNumber: season,
  episodeNumber: n,
  title: `Épisode ${n}`,
  overview: null,
  thumbnailUrl: null,
  runtimeMinutes: 45,
  runtimeTicks: 2700 * 1e7,
  watched: false,
  resumeTicks: null,
});

const SEASONS: CinemaSeason[] = [
  { seasonNumber: 1, episodes: [ep(1, 1), ep(1, 2), ep(1, 3)] },
  { seasonNumber: 2, episodes: [ep(2, 1)] },
  { seasonNumber: 0, episodes: [ep(0, 1), ep(0, 2)] },
];

const download = (itemId: string, change: Partial<OfflineDownload> = {}): OfflineDownload =>
  ({
    id: `job-${itemId}`,
    itemId,
    radarrId: null,
    title: itemId,
    year: null,
    runtimeSeconds: 2700,
    quality: "high",
    codec: "hevc",
    audioIndex: 1,
    audioLabel: "Français",
    audioTracks: [],
    generation: 1,
    expectedBytes: 100,
    serverBytes: 100,
    serverDone: true,
    bytes: 100,
    state: "done",
    error: null,
    createdAt: 1,
    positionSeconds: 0,
    hasPoster: false,
    ...change,
  }) as OfflineDownload;

beforeEach(() => {
  started.length = 0;
  held = [];
  infos.clear();
});

describe("le titre d'un épisode téléchargé", () => {
  it("s'écrit comme celui du lecteur : « Série — S01E02 · Titre »", () => {
    expect(offlineEpisodeTitle("Une série", ep(1, 2))).toBe("Une série — S01E02 · Épisode 2");
    expect(offlineEpisodeTitle("Une série", ep(0, 1))).toBe("Une série — S00E01 · Épisode 1");
  });
});

describe("la piste gardée pour une langue", () => {
  const tracks = [audio(1, "eng", true), audio(2, "fre"), audio(3, "fre")].map((track) => ({ track }));
  it("la première dans la langue, sinon celle par défaut, sinon la première", () => {
    expect(trackForLanguage(tracks, "fr")?.track.index).toBe(2);
    expect(trackForLanguage(tracks, "de")?.track.index).toBe(1);
    expect(trackForLanguage(tracks, null)?.track.index).toBe(1);
    expect(trackForLanguage([audio(4, null), audio(5, null)].map((track) => ({ track })), "fr")?.track.index).toBe(4);
    expect(trackForLanguage([], "fr")).toBeNull();
  });
});

describe("« Télécharger la saison »", () => {
  it("demande chaque épisode absent, dans l'ordre, avec la piste de la langue choisie dans chacun", async () => {
    // Trois épisodes, trois dispositions de pistes : le français n'est pas au même rang partout, et le
    // troisième n'en a pas — il garde sa piste par défaut.
    infos.set("s1e1", info([audio(1, "eng", true), audio(2, "fre")]));
    infos.set("s1e2", info([audio(1, "fre"), audio(2, "eng", true)]));
    infos.set("s1e3", info([audio(1, "eng"), audio(2, "jpn", true)]));
    const episodes = SEASONS[0].episodes;
    const { started: count, failed } = await requestSeasonDownloads(
      SERIES,
      episodes,
      SEASONS,
      { language: "fr", quality: "high", codec: "hevc", autoNext: true },
      labeller,
      () => held
    );
    expect(failed).toEqual([]);
    expect(count).toBe(3);
    expect(started.map((r) => [r.itemId, r.audioIndex])).toEqual([
      ["s1e1", 2],
      ["s1e2", 1],
      ["s1e3", 2],
    ]);
    expect(started[0]).toMatchObject({
      title: "Une série — S01E01 · Épisode 1",
      quality: "high",
      codec: "hevc",
      radarrId: null,
      runtimeSeconds: 2700,
      episode: { sonarrId: 7, seriesTitle: "Une série", seasonNumber: 1, episodeNumber: 1, episodeTitle: "Épisode 1", autoNext: true, seriesItemId: "jfs", audioLanguage: "fr" },
    });
    // La suite est notée à la demande : la fin d'une saison enchaîne sur la suivante.
    expect(started[0].episode?.next).toEqual({ itemId: "s1e2", title: "Épisode 2" });
    expect(started[2].episode?.next).toEqual({ itemId: "s2e1", title: "Épisode 1" });
    expect(started[0].audioTracks).toHaveLength(2);
  });

  it("saute ce qui est déjà sur l'appareil ou en route, redemande un échec, et un refus n'arrête pas les autres", async () => {
    held = [download("s1e1"), download("s1e2", { state: "failed" })];
    infos.set("s1e2", info([audio(1, "fre", true)]));
    // s1e3 : pas de description — refusé.
    const plan = episodesToDownload(SEASONS[0].episodes, held);
    expect(plan.map((e) => e.jellyfinItemId)).toEqual(["s1e2", "s1e3"]);
    const result = await requestSeasonDownloads(SERIES, plan, SEASONS, { language: "fr", quality: "standard", codec: "h264", autoNext: false }, labeller, () => held);
    expect(started.map((r) => r.itemId)).toEqual(["s1e2"]);
    expect(result.failed.map((f) => f.episode.jellyfinItemId)).toEqual(["s1e3"]);
  });

  it("estime la taille de ce qui reste à télécharger", () => {
    const two = SEASONS[0].episodes.slice(0, 2);
    expect(estimatedEpisodesBytes(two, "high")).toBeGreaterThan(estimatedEpisodesBytes(two, "standard"));
    // 45 min à 2 Mb/s + 128 kb/s, plus 5 % : ~720 Mo par épisode.
    expect(estimatedEpisodesBytes(two, "standard")).toBeCloseTo(2 * ((2700 * 2_128_000) / 8) * 1.05, -3);
  });
});

describe("le téléchargement automatique de l'épisode suivant", () => {
  const fetchList = () =>
    vi.fn(async () => new Response(JSON.stringify({ seasons: SEASONS, nextEpisode: null }), { status: 200 })) as unknown as typeof fetch;

  it("se déclenche à la moitié, et « vu » au seuil de Jellyfin (90 % par défaut)", () => {
    expect(autoNextDue(1349, 2700)).toBe(false);
    expect(autoNextDue(1350, 2700)).toBe(true);
    expect(autoNextDue(100, 0)).toBe(false);
    expect(watchedThrough(2429, 2700)).toBe(false);
    expect(watchedThrough(2430, 2700)).toBe(true);
  });

  it("demande le suivant aux mêmes langue, qualité et codec", async () => {
    vi.stubGlobal("fetch", fetchList());
    infos.set("s1e2", info([audio(1, "eng", true), audio(2, "fre")]));
    const current = download("s1e1", {
      quality: "high",
      codec: "hevc",
      episode: { sonarrId: 7, seriesTitle: "Une série", seasonNumber: 1, episodeNumber: 1, episodeTitle: "Épisode 1", autoNext: true, seriesItemId: "jfs", audioLanguage: "fr" },
    });
    held = [current];
    expect(await downloadNextEpisode(current, labeller, () => true)).toBe("started");
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ itemId: "s1e2", audioIndex: 2, quality: "high", codec: "hevc", episode: { autoNext: true, audioLanguage: "fr" } });
    vi.unstubAllGlobals();
  });

  it("ne redemande pas un suivant déjà là, ne fait rien hors ligne ni sans le choix", async () => {
    vi.stubGlobal("fetch", fetchList());
    const facts = { sonarrId: 7, seriesTitle: "Une série", seasonNumber: 1, episodeNumber: 1, episodeTitle: "Épisode 1", autoNext: true, seriesItemId: "jfs", audioLanguage: "fr" };
    const current = download("s1e1", { episode: facts });
    held = [current, download("s1e2", { state: "downloading" })];
    expect(await downloadNextEpisode(current, labeller, () => true)).toBe("present");
    expect(await downloadNextEpisode(current, labeller, () => false)).toBe("offline");
    expect(await downloadNextEpisode(download("s1e1", { episode: { ...facts, autoNext: false } }), labeller, () => true)).toBe("skipped");
    expect(started).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("les spéciaux s'enchaînent entre eux, et le dernier épisode n'a pas de suite", async () => {
    vi.stubGlobal("fetch", fetchList());
    infos.set("s0e2", info([audio(1, "fre", true)]));
    const facts = { sonarrId: 7, seriesTitle: "Une série", episodeTitle: "x", autoNext: true, seriesItemId: "jfs", audioLanguage: "fr" };
    const special = download("s0e1", { episode: { ...facts, seasonNumber: 0, episodeNumber: 1 } });
    held = [special];
    expect(await downloadNextEpisode(special, labeller, () => true)).toBe("started");
    expect(started[0].itemId).toBe("s0e2");
    const last = download("s2e1", { episode: { ...facts, seasonNumber: 2, episodeNumber: 1 } });
    held = [last];
    expect(await downloadNextEpisode(last, labeller, () => true)).toBe("none");
    vi.unstubAllGlobals();
  });
});

describe("« Épisode suivant » depuis un épisode téléchargé", () => {
  const facts = { sonarrId: 7, seriesTitle: "Une série", seasonNumber: 1, episodeNumber: 1, episodeTitle: "Épisode 1", autoNext: true, next: { itemId: "s1e2", title: "Épisode 2" } };
  const playable = (d: OfflineDownload) => d.state === "done";
  const current = download("s1e1", { episode: facts });

  it("le fichier sur l'appareil s'il est lisible, même sans réseau", () => {
    const next = download("s1e2", { title: "Une série — S01E02 · Épisode 2" });
    expect(offlineNextTarget(current, [current, next], false, playable)).toEqual({ itemId: "s1e2", title: "Une série — S01E02 · Épisode 2", offlineId: "job-s1e2" });
  });

  it("sinon en ligne, et rien sans réseau ni sans suite", () => {
    const preparing = download("s1e2", { state: "preparing" });
    expect(offlineNextTarget(current, [current, preparing], true, playable)).toEqual({ itemId: "s1e2", title: "Épisode 2", offlineId: null });
    expect(offlineNextTarget(current, [current], false, playable)).toBeNull();
    expect(offlineNextTarget(download("film"), [], true, playable)).toBeNull();
  });
});
