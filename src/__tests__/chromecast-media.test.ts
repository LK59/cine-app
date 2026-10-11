// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { createFakeCast } from "./helpers/fakeCast";
import { chromecastErrorReason, chromecastMediaSpec, idleOutcome, isSideLoadable, subtitleTrackId, toLoadRequest } from "@/lib/chromecast/media";

// DECISIONS.md §64 — ce qu'on demande au récepteur, décidé sans récepteur.

const subtitles = [
  { index: 3, url: "/api/jellyfin/stream/subtitle/abc?mediaSourceId=abc&index=3&castToken=t", label: "Français — Complets", language: "fre", isText: true },
  { index: 4, url: "/api/jellyfin/stream/subtitle/abc?mediaSourceId=abc&index=4&castToken=t", label: "Anglais — Forcés", language: "eng", isText: null },
  { index: 5, url: "/api/jellyfin/stream/subtitle/abc?mediaSourceId=abc&index=5&castToken=t", label: "Français — PGS", language: "fre", isText: false },
];

describe("chromecastMediaSpec", () => {
  const base = {
    castUrl: "https://cine.example/api/jellyfin/stream/abc/master.m3u8?x=1&castToken=t",
    isDirectPlay: false,
    title: "Le Film",
    startSeconds: 1234.5,
    subtitles,
    selectedSubtitle: null,
    origin: "https://cine.example",
  };

  it("un flux HLS : l'adresse signée telle quelle, annoncée en HLS, à la position de reprise", () => {
    const spec = chromecastMediaSpec(base);
    expect(spec).toMatchObject({ url: base.castUrl, contentType: "application/x-mpegurl", hls: true, title: "Le Film", startSeconds: 1234.5, activeTrackIds: [] });
  });

  it("un fichier servi tel quel : annoncé en MP4", () => {
    expect(chromecastMediaSpec({ ...base, isDirectPlay: true })).toMatchObject({ contentType: "video/mp4", hls: false });
  });

  it("les sous-titres texte voyagent à côté, adresses rendues absolues ; les images non", () => {
    const spec = chromecastMediaSpec(base);
    expect(spec.textTracks).toEqual([
      { trackId: 4, url: "https://cine.example/api/jellyfin/stream/subtitle/abc?mediaSourceId=abc&index=3&castToken=t", name: "Français — Complets", language: "fre" },
      { trackId: 5, url: "https://cine.example/api/jellyfin/stream/subtitle/abc?mediaSourceId=abc&index=4&castToken=t", name: "Anglais — Forcés", language: "eng" },
    ]);
  });

  it("allume le sous-titre texte choisi ; un sous-titre en images, incrusté, n'a rien à allumer", () => {
    expect(chromecastMediaSpec({ ...base, selectedSubtitle: 3 }).activeTrackIds).toEqual([4]);
    expect(chromecastMediaSpec({ ...base, selectedSubtitle: 5 }).activeTrackIds).toEqual([]);
  });

  it("une position impossible devient le début", () => {
    expect(chromecastMediaSpec({ ...base, startSeconds: Number.NaN }).startSeconds).toBe(0);
    expect(chromecastMediaSpec({ ...base, startSeconds: -3 }).startSeconds).toBe(0);
  });

  it("identifiants de piste : strictement positifs et stables", () => {
    expect(subtitleTrackId(0)).toBe(1);
    expect(subtitleTrackId(7)).toBe(8);
    expect(isSideLoadable({ isText: true })).toBe(true);
    expect(isSideLoadable({ isText: null })).toBe(true);
    expect(isSideLoadable({ isText: false })).toBe(false);
  });
});

describe("toLoadRequest — la traduction en objets du kit", () => {
  it("HLS en fMP4 annoncé, lecture automatique, position et pistes", () => {
    const fake = createFakeCast();
    const spec = chromecastMediaSpec({
      castUrl: "https://cine.example/m.m3u8?castToken=t",
      isDirectPlay: false,
      title: "Le Film",
      startSeconds: 60,
      subtitles,
      selectedSubtitle: 3,
      origin: "https://cine.example",
    });
    const request = toLoadRequest(fake.globals.chromeCast, spec) as Record<string, unknown> & { media: Record<string, unknown> };
    expect(request.currentTime).toBe(60);
    expect(request.autoplay).toBe(true);
    expect(request.activeTrackIds).toEqual([4]);
    expect(request.media).toMatchObject({
      contentId: "https://cine.example/m.m3u8?castToken=t",
      contentType: "application/x-mpegurl",
      streamType: "BUFFERED",
      hlsSegmentFormat: "fmp4",
      hlsVideoSegmentFormat: "fmp4",
    });
    expect((request.media.metadata as { title: string }).title).toBe("Le Film");
    const tracks = request.media.tracks as Record<string, unknown>[];
    expect(tracks[0]).toMatchObject({ trackId: 4, type: "TEXT", trackContentType: "text/vtt", subtype: "SUBTITLES", language: "fre" });
  });

  it("un fichier servi tel quel ne dit rien de segments HLS", () => {
    const fake = createFakeCast();
    const spec = chromecastMediaSpec({ castUrl: "https://cine.example/s.mp4", isDirectPlay: true, title: "x", startSeconds: 0, subtitles: [], selectedSubtitle: null, origin: "https://cine.example" });
    const media = (toLoadRequest(fake.globals.chromeCast, spec) as { media: Record<string, unknown> }).media;
    expect(media.hlsSegmentFormat).toBeUndefined();
  });
});

describe("ce que dit le récepteur", () => {
  it("idleOutcome : la fin, une erreur, un arrêt extérieur, une interruption", () => {
    expect(idleOutcome("FINISHED")).toBe("finished");
    expect(idleOutcome("ERROR")).toBe("error");
    expect(idleOutcome("CANCELLED")).toBe("stopped");
    expect(idleOutcome("INTERRUPTED")).toBe("interrupted");
    expect(idleOutcome(null)).toBeNull();
    expect(idleOutcome("autre")).toBeNull();
  });

  it("chromecastErrorReason : en mots pour le journal, un code inconnu gardé tel quel", () => {
    expect(chromecastErrorReason("load_media_failed")).toBe("le récepteur n'a pas pu charger le flux");
    expect(chromecastErrorReason("nouveau_code")).toBe("erreur Cast : nouveau_code");
  });
});
