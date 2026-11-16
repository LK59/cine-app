import { describe, it, expect } from "vitest";
import { masterPlaylist, mediaPlaylist } from "@/lib/lumenServer/playlists";
import { fragmentRanges, planSegments, targetDurationOf } from "@/lib/lumenServer/plan";
import { initName, parseLumenPath, playlistName, segmentName, type LumenIndex, type LumenRendition } from "@/lib/lumenServer/format";
import { mapJellyfinPath, parsePathMap } from "@/lib/lumenServer/paths";
import { __testing as remuxerTesting } from "@/lib/webcodecs/remuxer";
import { selectCuts, trustedCuts, type Candidate, type VerifiedKey } from "@/lib/lumenServer/lumenIndex";
import { fixtureIndex } from "./lumenServer-helpers";

// Les listes, vérifiées règle par règle contre la « HLS Authoring Specification for Apple Devices »
// (numéros entre parenthèses) : `mediastreamvalidator` n'existe que sur macOS, et aucun équivalent
// Linux ne lit le HLS fMP4. Le banc fait en plus relire les listes par le démultiplexeur HLS de ffmpeg.

const labels = { locale: "fr", canaux: (n: number) => `${n} canaux`, piste: (n: number) => `Piste ${n}` };

/** Les attributs d'une ligne `#EXT-X-…:A=B,C="D,E"`. */
function attributes(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = line.slice(line.indexOf(":") + 1);
  for (const m of body.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

describe("la liste maître", () => {
  it("une variante par groupe audio, chacune avec CODECS, RESOLUTION, FRAME-RATE, AVERAGE-BANDWIDTH, VIDEO-RANGE (9.1, 9.2, 9.14, 9.15, 9.16)", async () => {
    const { index, source } = await fixtureIndex("hevc-cra.mkv");
    source.close();
    const text = masterPlaylist(index, { audioTrack: index.audio[1].number, labels });
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("#EXTM3U");
    // La règle `cra` ne promet pas des segments indépendants (§158) : ses CRA gardent leurs RASL.
    expect(lines).not.toContain("#EXT-X-INDEPENDENT-SEGMENTS");

    const media = lines.filter((l) => l.startsWith("#EXT-X-MEDIA:")).map(attributes);
    // L'Opus n'est pas copiable : absent. Deux codecs, deux groupes.
    expect(media.map((m) => [m["GROUP-ID"], m.URI])).toEqual([
      ["aud-ac-3", "a3.m3u8"],
      ["aud-ec-3", "a2.m3u8"],
    ]);
    for (const m of media) {
      expect(m.TYPE).toBe("AUDIO");
      expect(m.LANGUAGE).toMatch(/^[a-z]{2,3}$/); // 8.10
      expect(m.NAME.length).toBeGreaterThan(0);
      expect(m.AUTOSELECT).toBe("YES");
      expect(m.CHANNELS).toMatch(/^\d+(\/JOC)?$/);
    }
    // Un seul DEFAULT=YES par groupe, et c'est la piste demandée dans le sien.
    expect(media.find((m) => m.URI === "a3.m3u8")!.DEFAULT).toBe("YES");
    expect(media.filter((m) => m.DEFAULT === "YES")).toHaveLength(2);
    expect(media.find((m) => m.URI === "a3.m3u8")!.NAME).toBe("Anglais — 5.1");

    const variants = lines.filter((l) => l.startsWith("#EXT-X-STREAM-INF:"));
    expect(variants).toHaveLength(2);
    // La variante de la piste demandée d'abord (1.32) ; l'URI suit chaque STREAM-INF.
    const first = attributes(variants[0]);
    expect(first.AUDIO).toBe("aud-ac-3");
    expect(lines[lines.indexOf(variants[0]) + 1]).toBe("v.m3u8");
    for (const v of variants.map(attributes)) {
      expect(Number(v.BANDWIDTH)).toBeGreaterThanOrEqual(Number(v["AVERAGE-BANDWIDTH"]));
      expect(v.CODECS.split(",")[0]).toBe(index.video!.signal!.codecs);
      expect(v.RESOLUTION).toBe("64x48");
      // 24 i/s : la durée par défaut du Matroska, pas une durée d’image à la milliseconde (41 ou 42 ms).
      expect(v["FRAME-RATE"]).toBe("24.000");
      expect(v["VIDEO-RANGE"]).toBe("SDR");
    }
    expect(attributes(variants[1]).CODECS).toBe(`${index.video!.signal!.codecs},ec-3`);
  });

  it("Dolby Vision 8.1 : SUPPLEMENTAL-CODECS et VIDEO-RANGE=PQ, d'après la signalisation de l'étape 1", async () => {
    const { index, source } = await fixtureIndex("hevc-idr.mkv");
    source.close();
    const dv: LumenIndex = {
      ...index,
      video: { ...index.video!, signal: { codecs: "hvc1.2.4.L153.90", supplementalCodecs: "dvh1.08.06/db1p", videoRange: "PQ", rangeSource: "dolby-vision", entry: "hvc1+dv" } },
    };
    const v = attributes(masterPlaylist(dv, { audioTrack: null, labels }).split("\n").find((l) => l.startsWith("#EXT-X-STREAM-INF"))!);
    expect(v["SUPPLEMENTAL-CODECS"]).toBe("dvh1.08.06/db1p");
    expect(v["VIDEO-RANGE"]).toBe("PQ");
  });

  it("sans son copiable : une variante sans AUDIO", async () => {
    const { index, source } = await fixtureIndex("h264-late.mkv", 1_000_000);
    source.close();
    const text = masterPlaylist(index, { audioTrack: null, labels });
    expect(text).not.toContain("#EXT-X-MEDIA");
    expect(text).not.toContain("AUDIO=");
  });

  it("un nom de piste ne casse jamais la syntaxe (guillemets, retours à la ligne)", async () => {
    const { index, source } = await fixtureIndex("h264-aac.mkv");
    source.close();
    const odd: LumenIndex = { ...index, audio: index.audio.map((a) => ({ ...a, name: 'Le "mix"\noriginal', language: null })) };
    const line = masterPlaylist(odd, { audioTrack: null, labels }).split("\n").find((l) => l.startsWith("#EXT-X-MEDIA"))!;
    expect(line.match(/"/g)!.length % 2).toBe(0);
    // Une piste sans langue : « und » plutôt qu'un attribut absent (8.10).
    expect(attributes(line).LANGUAGE).toBe("und");
  });
});

describe("les listes média", () => {
  it("VOD, EXT-X-MAP, mêmes EXTINF pour la vidéo et chaque son, TARGETDURATION juste (7.7, 8.2, 8.20)", async () => {
    const { index, source } = await fixtureIndex("h264-aac.mkv", 1_000_000);
    source.close();
    const renditions: LumenRendition[] = [{ kind: "video" }, { kind: "audio", track: index.audio[0].number }];
    const lists = renditions.map((r) => mediaPlaylist(index, r));
    const durations = lists.map((text) => text.split("\n").filter((l) => l.startsWith("#EXTINF:")).map((l) => l.slice(8, -1)));
    expect(durations[0]).toEqual(durations[1]);
    expect(durations[0]).toEqual(["1", "1", "1", "1", "1", "1.021"]);
    const target = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(lists[0])![1]);
    for (const d of durations[0]) expect(Number(d)).toBeLessThanOrEqual(target + 0.5);
    // La somme des EXTINF est la durée du contenu (8.1).
    const sum = durations[0].reduce((s, d) => s + Number(d), 0);
    expect(Math.abs(sum - index.durationUs / 1e6)).toBeLessThan(1e-6);

    expect(lists[0]).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    expect(lists[0]).toContain('#EXT-X-MAP:URI="init-v.mp4"');
    expect(lists[1]).toContain(`#EXT-X-MAP:URI="init-a${index.audio[0].number}.mp4"`);
    expect(lists[0]).toContain("\nv/0.m4s\n");
    expect(lists[1]).toContain(`\na${index.audio[0].number}/5.m4s\n`);
    expect(lists[0].trim().endsWith("#EXT-X-ENDLIST")).toBe(true);
  });
});

describe("la découpe", () => {
  const cuts = [0, 1, 2, 2.5, 7, 7.5, 8, 12.4].map((s, i) => ({ timeUs: Math.round(s * 1e6), at: i * 100 }));

  it("coupe à la première clé admise au moins à la cible de la précédente, jamais sous un groupe", () => {
    const segments = planSegments(cuts, 15_000_000, 40_000, 4_000_000);
    expect(segments.map((s) => [s.startUs / 1e6, s.endUs / 1e6, s.at])).toEqual([
      [0, 7, 0],
      [7, 12.4, 400],
      [12.4, 15, 700],
    ]);
  });

  it("est déterministe, et ne dépend ni de l'ordre ni des doublons des clés", () => {
    const shuffled = [...cuts].reverse().sort((a, b) => a.timeUs - b.timeUs);
    expect(planSegments(shuffled, 15_000_000, 40_000, 4_000_000)).toEqual(planSegments(cuts, 15_000_000, 40_000, 4_000_000));
    const doubled = [...cuts, { timeUs: 7_000_000, at: 9999 }].sort((a, b) => a.timeUs - b.timeUs || a.at - b.at);
    expect(planSegments(doubled, 15_000_000, 40_000, 4_000_000)).toEqual(planSegments(cuts, 15_000_000, 40_000, 4_000_000));
  });

  it("le dernier segment finit à la durée, ou une image après sa clé si la durée annoncée est trop courte", () => {
    expect(planSegments(cuts, 0, 40_000, 4_000_000).at(-1)!.endUs).toBe(12_440_000);
    expect(targetDurationOf(planSegments(cuts, 15_000_000, 40_000, 4_000_000))).toBe(7);
  });

  it("la vérification paresseuse et par lots choisit exactement les coupes de la découpe sur toutes les clés", async () => {
    // Des clés tous les 0,5 à 3 s, une sur cinq refusée (CRA à RASL) — tirées d'un générateur fixe.
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let run = 0; run < 20; run++) {
      const candidates: Candidate[] = [];
      let t = 0;
      for (let i = 0; i < 300; i++) {
        candidates.push({ timeUs: t, at: i });
        t += Math.round(500_000 + random() * 2_500_000);
      }
      const refused = new Set(candidates.filter(() => random() < 0.2).map((c) => c.at));
      refused.delete(0);
      const verify = async (c: Candidate): Promise<VerifiedKey | null> =>
        c.at % 37 === 5 ? null : { timeUs: c.timeUs, at: c.at, kind: refused.has(c.at) ? "cra" : "idr", rasl: refused.has(c.at), leading: false };
      const stats = { cues: 0, verified: 0, rejected: 0, idr: 0, cra: 0, craRasl: 0, leading: 0, cuts: 0, trusted: 0 };
      const lazy = await selectCuts(candidates, 4_000_000, verify, stats, "idr");
      const all = (await Promise.all(candidates.map(verify))).filter((k): k is VerifiedKey => !!k && !k.rasl);
      const greedy = planSegments(all, t, 40_000, 4_000_000).map((s) => s.keyUs);
      expect(lazy.map((k) => k.timeUs)).toEqual(greedy);
      expect(stats.verified).toBeLessThan(candidates.length);
    }
  });

  it("l'index des Cues (§158) : la découpe gloutonne sur tous les points, une seule lecture — la première clé", async () => {
    let seed = 11;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let run = 0; run < 20; run++) {
      const candidates: Candidate[] = [];
      let t = 0;
      for (let i = 0; i < 300; i++) {
        candidates.push({ timeUs: t, at: i });
        t += Math.round(500_000 + random() * 2_500_000);
      }
      // Les deux premiers points mentent (le fichier commence sur une image non clé, *Gravity Falls*), et
      // chaque autre est une CRA à RASL une fois sur cinq : sous `cra`, ça ne change rien.
      const read: number[] = [];
      const verify = async (c: Candidate): Promise<VerifiedKey | null> => {
        read.push(c.at);
        return c.at < 2 ? null : { timeUs: c.timeUs, at: c.at, kind: "cra", rasl: random() < 0.2, leading: false };
      };
      const stats = { cues: 0, verified: 0, rejected: 0, idr: 0, cra: 0, craRasl: 0, leading: 0, cuts: 0, trusted: 0 };
      const cuts = await trustedCuts(candidates, 4_000_000, verify, stats, "cra");
      const greedy = planSegments(candidates.slice(2), t, 40_000, 4_000_000).map((s) => s.keyUs);
      expect(cuts.map((k) => k.timeUs)).toEqual(greedy);
      expect(read).toEqual([0, 1, 2]);
      expect(stats).toMatchObject({ verified: 3, rejected: 2, trusted: cuts.length - 1 });
    }
    // Aucune clé lisible dans les premiers points : aucune coupe (`index-invalide`), sans lire tout le fichier.
    const none = await trustedCuts([{ timeUs: 0, at: 0 }, { timeUs: 5e6, at: 1 }], 4_000_000, async () => null, { cues: 0, verified: 0, rejected: 0, idr: 0, cra: 0, craRasl: 0, leading: 0, cuts: 0, trusted: 0 }, "cra");
    expect(none).toEqual([]);
  });

  it("les fragments suivent exactement la règle du remuxeur (planFragments)", () => {
    const shapes: [number, (i: number) => number][] = [
      [200, () => 5_000],
      [200, () => 30_000],
      [20, () => 300_000],
      [7, (i) => (i === 3 ? 5_000_000 : 1000)],
      [1, () => 10],
      [0, () => 10],
    ];
    for (const [count, size] of shapes) {
      const ours = fragmentRanges(count, size).map(([from, to]) => Array.from({ length: to - from }, (_, k) => from + k));
      expect(ours).toEqual(remuxerTesting.planFragments(count, size));
    }
  });
});

describe("les noms servis", () => {
  it("noms naturels, relatifs, et leur lecture inverse stricte", () => {
    const video: LumenRendition = { kind: "video" };
    const audio: LumenRendition = { kind: "audio", track: 3 };
    expect([playlistName(video), initName(video), segmentName(video, 12)]).toEqual(["v.m3u8", "init-v.mp4", "v/12.m4s"]);
    expect([playlistName(audio), initName(audio), segmentName(audio, 12)]).toEqual(["a3.m3u8", "init-a3.mp4", "a3/12.m4s"]);
    for (const name of ["master.m3u8", "v.m3u8", "a3.m3u8", "init-v.mp4", "init-a3.mp4", "v/0.m4s", "a3/12.m4s"]) expect(parseLumenPath(name)).not.toBeNull();
    expect(parseLumenPath("a3/12.m4s")).toEqual({ kind: "segment", rendition: audio, n: 12 });
    for (const bad of ["v/012.m4s", "v/-1.m4s", "a0.m3u8", "a03.m3u8", "x.m3u8", "../v.m3u8", "v/1.mp4", "init-v.m4s", "v/1.m4s?x", "V.m3u8"]) {
      expect([bad, parseLumenPath(bad)]).toEqual([bad, null]);
    }
  });
});

describe("la traduction des chemins Jellyfin", () => {
  it("lit le réglage, la racine la plus longue d'abord, et ignore ce qui est malformé", () => {
    expect(parsePathMap("")).toEqual([]);
    expect(parsePathMap("/media=/mnt/media/video/; /media/tv=/tv ;bad;=x;rel=/a")).toEqual([
      { from: "/media/tv", to: "/tv" },
      { from: "/media", to: "/mnt/media/video" },
    ]);
  });

  it("refuse ce qui sortirait des racines", () => {
    const map = parsePathMap("/media=/mnt/media/video");
    expect(mapJellyfinPath("/media/movies/A (2000)/A.mkv", map)).toEqual({ path: "/mnt/media/video/movies/A (2000)/A.mkv", root: "/mnt/media/video" });
    for (const bad of ["/media/../etc/passwd", "/media/./x", "/mediax/a.mkv", "/media", "media/a.mkv", "/media/a\0.mkv", "/autre/a.mkv"]) {
      expect([bad, mapJellyfinPath(bad, map)]).toEqual([bad, null]);
    }
    expect(mapJellyfinPath("/media/a.mkv", [])).toBeNull();
  });
});
