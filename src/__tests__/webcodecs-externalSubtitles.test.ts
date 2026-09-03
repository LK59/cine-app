import { describe, it, expect, vi, afterEach } from "vitest";
import { parseSubtitles, ExternalSubtitleTrack, isExternalTrack, toEngineTrack } from "@/lib/webcodecs/externalSubtitles";

// Subtitles that came from beside the film. What matters is that the parser survives the shapes
// real files come in, and that a jump backwards still finds its line.

afterEach(() => vi.unstubAllGlobals());

const VTT = `WEBVTT

NOTE this file was converted

1
00:00:01.000 --> 00:00:03.500
Bonjour.

2
00:01:00.250 --> 00:01:02.000
<i>Une réplique</i>
sur deux lignes.
`;

describe("parseSubtitles", () => {
  it("lit un fichier WebVTT en sautant son en-tête et ses notes", () => {
    const cues = parseSubtitles(VTT);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ startSeconds: 1, endSeconds: 3.5, text: "Bonjour." });
    // The markup goes, the line break stays: it is the author's, and it is how the line reads.
    expect(cues[1].text).toBe("Une réplique\nsur deux lignes.");
    expect(cues[1].startSeconds).toBeCloseTo(60.25, 3);
  });

  it("lit aussi du SubRip, dont la virgule et les fins de ligne Windows", () => {
    // The same function reads a file straight off a disk, which SubRip writes with a comma and
    // very often with CRLF. A stray carriage return at the end of every line would show.
    const cues = parseSubtitles("1\r\n00:00:02,000 --> 00:00:04,000\r\nSalut\r\n\r\n");
    expect(cues).toEqual([{ startSeconds: 2, endSeconds: 4, text: "Salut" }]);
  });

  it("échelonne la fraction sur sa propre longueur", () => {
    // ".5" is half a second. Read as milliseconds it would be five, and every cue in a file
    // written that way would land a fraction early — invisible in a test that only checks order.
    const cues = parseSubtitles("00:00:01.5 --> 00:00:02.25\na");
    expect(cues[0].startSeconds).toBe(1.5);
    expect(cues[0].endSeconds).toBe(2.25);
  });

  it("remet les répliques dans l'ordre et jette celles qui n'ont pas de texte", () => {
    const cues = parseSubtitles("00:00:09.000 --> 00:00:10.000\ntard\n\n00:00:01.000 --> 00:00:02.000\ntôt\n\n00:00:04.000 --> 00:00:05.000\n{\\an8}");
    expect(cues.map((c) => c.text)).toEqual(["tôt", "tard"]);
  });
});

describe("ExternalSubtitleTrack", () => {
  const load = async (text: string) => {
    vi.stubGlobal("fetch", async () => ({ ok: true, text: async () => text }));
    return ExternalSubtitleTrack.load({ id: -3, language: "fre", title: null, url: "/x" });
  };

  it("retrouve la réplique en cours, en avant comme en arrière", async () => {
    const track = await load(VTT);
    expect(track.count).toBe(2);
    expect(track.textAt(2)).toBe("Bonjour.");
    expect(track.textAt(30)).toBeNull(); // between two cues
    expect(track.textAt(61)).toContain("Une réplique");
    // The engine's own queue is consumed as it is read; this one is not, so a jump backwards
    // finds the line again instead of an empty screen until the next cue.
    expect(track.textAt(2)).toBe("Bonjour.");
  });

  it("montre une réplique encore à l'écran qu'une autre a commencé par-dessus", async () => {
    // Two speakers at once: the cue that starts later is not the only one covering that instant,
    // and a lookup that stops at the last one to have started would drop the first.
    const track = await load("00:00:00.000 --> 00:00:10.000\nlongue\n\n00:00:02.000 --> 00:00:03.000\ncourte");
    expect(track.textAt(5)).toBe("longue");
  });

  it("dit ce qui manque quand le serveur refuse le fichier", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 404 }));
    await expect(ExternalSubtitleTrack.load({ id: -3, language: null, title: null, url: "/x" })).rejects.toThrow(/404/);
  });
});

describe("numérotation", () => {
  it("ne peut jamais entrer en collision avec une piste du conteneur", () => {
    // Container track numbers are positive; these are derived as -1 - index, so index 0 is -1.
    expect(isExternalTrack(-1)).toBe(true);
    expect(isExternalTrack(3)).toBe(false);
    expect(toEngineTrack({ id: -1, language: "fre", title: "Français", url: "/x" })).toMatchObject({
      number: -1,
      language: "fre",
      name: "Français",
      isForced: false,
    });
  });
});
