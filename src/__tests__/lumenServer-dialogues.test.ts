import { describe, it, expect, vi, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DialogueEnhancer, DIALOGUE_TUNING } from "@/lib/webcodecs/dialogueEnhance";
import { DIALOGUE_PREROLL, enhanceWindow, enhanceWindows, LUMEN_DIALOGUE_VERSION, parseDialogueMode, planesOf } from "@/lib/lumenServer/audio/dialogue";
import { dialogueConversionId, dialogueRendition, dialogueSourceOf, dialogueTrackView, withConversion, withDialogue, type ConversionContext } from "@/lib/lumenServer/audio/view";
import { CONVERT_RATE, EAC3_FRAME, inputWindow, segmentFrames, TARGET_20, TARGET_51 } from "@/lib/lumenServer/audio/convertGrid";
import { initName, parseLumenPath, playlistName, segmentName, type LumenAudioTrack, type LumenIndex, type LumenRendition } from "@/lib/lumenServer/format";
import { masterPlaylist } from "@/lib/lumenServer/playlists";
import { fixtureIndex } from "./lumenServer-helpers";

// « Améliorer les dialogues » dans Lumen serveur (DECISIONS.md §191) : ce qui se vérifie sans ffmpeg — les noms, la
// vue, la liste maître, le traitement d'un segment depuis son pré-roulement (une fonction de sa plage seule, le code du
// lecteur actuel), et la conversion « dialogues » avec un ffmpeg remplacé (décodage partagé ou par segment, un encodage
// par segment). Les jointures sur de vrais films, l'identité seul/avance et les niveaux : `lumen-dialogue-bench.spec.ts`.

const labels = { locale: "fr", canaux: (n: number) => `${n} canaux`, piste: (n: number) => `Piste ${n}` };

let index: LumenIndex;
const REFERENCE: Record<string, Uint8Array> = {};
const ctx = (extra: Partial<ConversionContext> = {}): ConversionContext => ({ ffmpegVersion: "7.1.5", ffmpegSha256: "ab".repeat(32), reference: REFERENCE, dolby: true, ...extra });

beforeAll(async () => {
  const opened = await fixtureIndex("hevc-cra.mkv");
  opened.source.close();
  index = opened.index;
  const late = await fixtureIndex("eac3-late.mkv");
  late.source.close();
  const short = await fixtureIndex("eac3-short.mkv");
  short.source.close();
  REFERENCE[TARGET_51.id] = late.index.audio[0].firstFrame!;
  REFERENCE[TARGET_20.id] = short.index.audio[0].firstFrame!;
});

/** Un signal de film en miniature, déterministe : des phrases (bandes de parole) sur un fond, des silences. */
function filmLike(seconds: number, channels: number, seed = 1): Float32Array {
  const n = seconds * CONVERT_RATE;
  const out = new Float32Array(n * channels);
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / CONVERT_RATE;
    const talking = Math.floor(t / 1.7) % 3 !== 2;
    const loud = Math.floor(t / 5.3) % 4 === 0;
    for (let c = 0; c < channels; c++) {
      const voice = c === (channels >= 3 ? 2 : 0) || channels <= 2 ? (talking ? 0.2 * Math.sin(2 * Math.PI * (220 + 40 * Math.sin(t)) * t) * (0.6 + 0.4 * Math.sin(9 * t)) : 0) : 0;
      out[i * channels + c] = voice + (loud ? 0.5 : 0.03) * rand();
    }
  }
  return out;
}

describe("les noms des rendus « dialogues »", () => {
  it("`a3d1x{cid}` (améliorer) et `a3d2x{cid}` (davantage), jamais sans identité ; lecture inverse stricte", () => {
    const on: LumenRendition = { kind: "audio", track: 3, conv: "0a1b2c3d", dialogue: "on" };
    const strong: LumenRendition = { kind: "audio", track: 3, conv: "0a1b2c3d", dialogue: "strong" };
    expect([playlistName(on), initName(on), segmentName(on, 12)]).toEqual(["a3d1x0a1b2c3d.m3u8", "init-a3d1x0a1b2c3d.mp4", "a3d1x0a1b2c3d/12.m4s"]);
    expect(playlistName(strong)).toBe("a3d2x0a1b2c3d.m3u8");
    expect(parseLumenPath("a3d1x0a1b2c3d/12.m4s")).toEqual({ kind: "segment", rendition: on, n: 12 });
    expect(parseLumenPath("init-a3d2x0a1b2c3d.mp4")).toEqual({ kind: "init", rendition: strong });
    // Les noms d'avant ne bougent pas.
    expect(parseLumenPath("a3x0a1b2c3d.m3u8")).toEqual({ kind: "playlist", rendition: { kind: "audio", track: 3, conv: "0a1b2c3d" } });
    expect(parseLumenPath("a3.m3u8")).toEqual({ kind: "playlist", rendition: { kind: "audio", track: 3 } });
    for (const bad of ["a3d1.m3u8", "a3d3x0a1b2c3d.m3u8", "a3d1x0A1b2c3d.m3u8", "a3d1xx0a1b2c3d.m3u8", "a3x0a1b2c3dd1.m3u8", "a3d01x0a1b2c3d.m3u8"]) expect([bad, parseLumenPath(bad)]).toEqual([bad, null]);
  });

  it("`?dialogue=` : on, strong ; off ou absent = rien ; le reste est mal formé", () => {
    expect([parseDialogueMode("on"), parseDialogueMode("strong")]).toEqual(["on", "strong"]);
    expect([parseDialogueMode(null), parseDialogueMode(""), parseDialogueMode("off")]).toEqual([undefined, undefined, undefined]);
    expect([parseDialogueMode("loud"), parseDialogueMode("ON")]).toEqual([null, null]);
  });
});

describe("la vue : quelles pistes ont leurs rendus « dialogues »", () => {
  it("l'AC-3 et l'E-AC-3 copiées (décodeur Dolby détecté), l'Opus converti ; rien sans contexte ; rien sans Dolby pour les copiées", () => {
    const viewed = withDialogue(withConversion(index, ctx()), ctx());
    const byCodec = Object.fromEntries(viewed.audio.map((a) => [a.codecId, a.dialogue?.target ?? null]));
    // Les fixtures : une E-AC-3 mono et un Opus mono (cible 2.0), une AC-3 5.1 (cible 5.1).
    expect(byCodec).toEqual({ A_EAC3: TARGET_20.id, A_AC3: TARGET_51.id, A_OPUS: TARGET_20.id });
    const dolby = viewed.audio.find((a) => a.codecId === "A_AC3")!;
    expect(dolby.dialogue!.source).toMatchObject({ codec: "dolby", grid: 1536 });
    expect(dolby.dialogue!.signal.codecs).toBe("ec-3");
    // Sans contexte (option coupée, ffmpeg absent) : l'index lui-même, à l'objet près.
    expect(withDialogue(index, null)).toBe(index);
    const noDolby = withDialogue(withConversion(index, ctx({ dolby: false })), ctx({ dolby: false }));
    expect(noDolby.audio.filter((a) => a.dialogue).map((a) => a.codecId)).toEqual(["A_OPUS"]);
    // Une E-AC-3 à sous-flux dépendant (un 7.1) : pas de rendu, la disposition décodée n'est pas sûre.
    const eac3 = index.audio.find((a) => a.codecId === "A_EAC3")!;
    const withDependent = { ...eac3, firstFrame: new Uint8Array([...eac3.firstFrame!, ...eac3.firstFrame!]) };
    expect(dialogueSourceOf(index, withDependent, true)).toBeNull();
  });

  it("l'AAC, une piste refusée : pas de rendu", () => {
    const aac: LumenAudioTrack = { ...index.audio[0], codecId: "A_AAC", refusal: null, converted: undefined };
    expect(dialogueSourceOf(index, aac, true)).toBeNull();
    expect(dialogueSourceOf(index, { ...index.audio[0], refusal: { reason: "son-codec" } }, true)).toBeNull();
  });

  it("l'identité : la force, ffmpeg, la règle et le moteur JavaScript la changent ; rien d'autre", () => {
    const base = dialogueConversionId(ctx(), TARGET_51, "on", "13.0");
    expect(dialogueConversionId(ctx(), TARGET_51, "on", "13.0")).toBe(base);
    expect(dialogueConversionId(ctx(), TARGET_51, "strong", "13.0")).not.toBe(base);
    expect(dialogueConversionId(ctx(), TARGET_51, "on", "13.1")).not.toBe(base);
    expect(dialogueConversionId(ctx({ ffmpegSha256: "cd".repeat(32) }), TARGET_51, "on", "13.0")).not.toBe(base);
    expect(dialogueConversionId(ctx(), TARGET_20, "on", "13.0")).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{8}$/);
  });

  it("la piste vue par la conversion : convertie vers la cible du traitement, sous l'identité de la force", () => {
    const viewed = withDialogue(withConversion(index, ctx()), ctx());
    const track = viewed.audio.find((a) => a.codecId === "A_AC3")!;
    const view = dialogueTrackView(track, "strong")!;
    expect(view.converted).toEqual({ target: TARGET_51.id, cid: track.dialogue!.cids.strong, channels: 6 });
    expect(view.convert).toBe(track.dialogue!.source);
    expect(dialogueRendition(track, "on")).toEqual({ kind: "audio", track: track.number, conv: track.dialogue!.cids.on, dialogue: "on" });
  });
});

describe("la liste maître `?dialogue=`", () => {
  it("chaque piste servie par son rendu traité à la place du sien : même rang, même nombre, `ec-3` ; sans `dialogue`, la liste d'avant à l'octet près", () => {
    const viewed = withDialogue(withConversion(index, ctx()), ctx());
    const audioTrack = viewed.audio.find((a) => a.codecId === "A_EAC3")!.number;
    // La liste ordinaire ne voit pas les rendus « dialogues » : identique à celle de l'index sans la vue.
    expect(masterPlaylist(viewed, { audioTrack, labels })).toBe(masterPlaylist(withConversion(index, ctx()), { audioTrack, labels }));
    const plain = masterPlaylist(viewed, { audioTrack, labels }).split("\n");
    const processed = masterPlaylist(viewed, { audioTrack, labels, dialogue: "on" }).split("\n");
    const media = (lines: string[]) => lines.filter((l) => l.startsWith("#EXT-X-MEDIA:"));
    expect(media(processed)).toHaveLength(media(plain).length);
    const uris = media(processed).map((l) => /URI="([^"]+)"/.exec(l)![1]);
    for (const a of viewed.audio.filter((t) => !t.refusal && t.dialogue)) expect(uris).toContain(`a${a.number}d1x${a.dialogue!.cids.on}.m3u8`);
    expect(processed.find((l) => l.startsWith("#EXT-X-STREAM-INF:"))).toMatch(/CODECS="[^"]*ec-3"/);
    expect(processed.find((l) => l.startsWith("#EXT-X-STREAM-INF:"))).not.toMatch(/ac-3,|,ac-3"/);
    // Un seul DEFAULT, la piste demandée.
    expect(media(processed).filter((l) => l.includes("DEFAULT=YES"))).toHaveLength(1);
    expect(media(processed).find((l) => l.includes("DEFAULT=YES"))).toContain(`a${audioTrack}d1x`);
  });
});

describe("le traitement d'un segment depuis son pré-roulement", () => {
  const channels = 6;
  const pcm = filmLike(30, channels);
  const work = { pcm, pcmStart: 0, channels, mono: false, mode: "strong" as const, preroll: DIALOGUE_PREROLL };

  it("c'est `DialogueEnhancer` lui-même, neuf, sur [début − pré-roulement, fin) : le code du lecteur actuel", () => {
    const w = { start: 10 * CONVERT_RATE, end: 14 * CONVERT_RATE };
    const out = enhanceWindow(work, w);
    const reference = new DialogueEnhancer(CONVERT_RATE, channels, "strong").process(planesOf(pcm, 0, channels, w.start - DIALOGUE_PREROLL, w.end));
    for (const i of [0, 1, 4800, (w.end - w.start) - 1]) for (let c = 0; c < channels; c++) expect(out[i * channels + c]).toBe(reference[c][DIALOGUE_PREROLL + i]);
  });

  it("une fonction de sa plage seule : le même segment pris dans un PCM plus long, ou plus court, donne les mêmes échantillons", () => {
    const w = { start: 12 * CONVERT_RATE + 256, end: 16 * CONVERT_RATE + 256 };
    const whole = enhanceWindow(work, w);
    const from = w.start - DIALOGUE_PREROLL - 1000;
    const cut = { ...work, pcm: pcm.slice(from * channels, (w.end + 500) * channels), pcmStart: from };
    expect(Buffer.from(enhanceWindow(cut, w).buffer).equals(Buffer.from(whole.buffer))).toBe(true);
  });

  it("à 6 s de pré-roulement, à moins de −120 dBFS d'un traitement continu ; à 1 s, nettement plus loin", () => {
    const continuous = new DialogueEnhancer(CONVERT_RATE, channels, "strong").process(planesOf(pcm, 0, channels, 0, 30 * CONVERT_RATE));
    const gap = (preroll: number) => {
      let max = 0;
      for (const startS of [10, 14, 18, 22]) {
        const w = { start: startS * CONVERT_RATE, end: (startS + 4) * CONVERT_RATE };
        const out = enhanceWindow({ ...work, preroll }, w);
        for (let i = 0; i < w.end - w.start; i++) for (let c = 0; c < channels; c++) max = Math.max(max, Math.abs(out[i * channels + c] - continuous[c][w.start + i]));
      }
      return 20 * Math.log10(Math.max(max, 1e-12));
    };
    expect(gap(DIALOGUE_PREROLL)).toBeLessThan(-120);
    expect(gap(CONVERT_RATE)).toBeGreaterThan(gap(DIALOGUE_PREROLL) + 20);
  });

  it("un mono : traité en mono (la voix seule, sans gain de milieu), copié dans les deux canaux de la cible", () => {
    const mono = filmLike(20, 1, 7);
    const stereo = new Float32Array(mono.length * 2);
    for (let i = 0; i < mono.length; i++) stereo[2 * i] = stereo[2 * i + 1] = mono[i];
    const w = { start: 8 * CONVERT_RATE, end: 12 * CONVERT_RATE };
    const out = enhanceWindow({ pcm: stereo, pcmStart: 0, channels: 2, mono: true, mode: "on", preroll: DIALOGUE_PREROLL }, w);
    const reference = new DialogueEnhancer(CONVERT_RATE, 1, "on").process(planesOf(mono, 0, 1, w.start - DIALOGUE_PREROLL, w.end));
    for (const i of [0, 777, 48_000]) {
      expect(out[2 * i]).toBe(reference[0][DIALOGUE_PREROLL + i]);
      expect(out[2 * i + 1]).toBe(reference[0][DIALOGUE_PREROLL + i]);
    }
  });

  it("une plage où rien n'est décodé (le silence d'avant le premier son) : des zéros, sans calcul", () => {
    const out = enhanceWindows({ ...work, pcm: new Float32Array(0), windows: [{ start: 0, end: 4096 }] });
    expect(out[0].every((v) => v === 0)).toBe(true);
    expect(out[0].length).toBe(4096 * channels);
  });
});

describe("ce qui fixe les octets", () => {
  it("`dialogueEnhance.ts` change ⇒ monter `LUMEN_DIALOGUE_VERSION` (une adresse servie donne demain les mêmes octets)", () => {
    // Si ce test échoue : le traitement du lecteur actuel a changé, donc les octets des rendus « dialogues » de Lumen
    // serveur aussi. Monter LUMEN_DIALOGUE_VERSION (audio/dialogue.ts), puis noter ici la nouvelle empreinte.
    const fingerprint = createHash("sha256").update(readFileSync("src/lib/webcodecs/dialogueEnhance.ts")).digest("hex");
    expect({ version: LUMEN_DIALOGUE_VERSION, fingerprint }).toEqual({ version: 1, fingerprint: "d8c016318f6de2eb025861942507efb45ce39cc981232844881d8137d4b6529d" });
    expect(Object.keys(DIALOGUE_TUNING)).toEqual(["on", "strong"]);
  });
});

// ── La conversion « dialogues », ffmpeg remplacé ─────────────────────────────

const ffmpegCalls: { kind: "decode" | "encode"; bytes: number }[] = [];
vi.mock("@/lib/lumenServer/audio/ffmpeg", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lumenServer/audio/ffmpeg")>();
  return {
    ...actual,
    runFfmpeg: async (_path: string, args: readonly string[], input: Uint8Array | null) => {
      const decode = args.includes("-af");
      ffmpegCalls.push({ kind: decode ? "decode" : "encode", bytes: input?.length ?? 0 });
      const stereo = decode ? args.some((a) => a.startsWith("pan=stereo")) : args[args.indexOf("-ch_layout") + 1] === "stereo";
      const channels = stereo ? 2 : 6;
      if (decode) {
        // Le décodé d'un flux de N « unités » : un PCM de N × 1 536 échantillons aux canaux de la cible, déterministe.
        const frames = (input?.length ?? 0) * 1536;
        const pcm = new Float32Array(frames * channels);
        for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i * 0.001) * 0.2;
        return { stdout: new Uint8Array(pcm.buffer), ms: 1, firstByteMs: 1 };
      }
      // L'encodeur : une trame (la référence) par 1 536 échantillons reçus.
      const count = Math.floor((input?.length ?? 0) / (channels * 4 * EAC3_FRAME));
      const frame = REFERENCE[stereo ? TARGET_20.id : TARGET_51.id];
      const out = new Uint8Array(frame.length * count);
      for (let k = 0; k < count; k++) out.set(frame, k * frame.length);
      return { stdout: out, ms: 1, firstByteMs: 1 };
    },
  };
});

describe("la conversion « dialogues » (ffmpeg remplacé)", () => {
  it("un décodage pour la tâche (décodeur exact au bit), un encodage par segment ; les segments de l'avance sont ceux faits seuls", async () => {
    const { convertRange } = await import("@/lib/lumenServer/audio/convert");
    const viewed = withDialogue(withConversion(index, ctx()), ctx());
    const opus = viewed.audio.find((a) => a.codecId === "A_OPUS")!;
    const view = dialogueTrackView(opus, "on")!;
    const target = view.converted!.channels === 6 ? TARGET_51 : TARGET_20;
    const feeds: { start: number; end: number }[] = [];
    const readFeed = async (spec: { start: number; end: number }) => {
      feeds.push({ start: spec.start, end: spec.end });
      // Un « flux » d'une unité par trame de 1 536 échantillons, posé 0,25 s avant la fenêtre.
      const startSample = spec.start - 12_000;
      const units = Math.ceil((spec.end - startSample) / 1536);
      return { feed: { format: "ogg", bytes: new Uint8Array(units), startSample, endSample: startSample + units * 1536, units }, diskMs: 0, ms: 1 };
    };
    const works: { windows: number; preroll: number; mode: string }[] = [];
    const dialogue = {
      mode: "on" as const,
      enhance: async (work: Parameters<typeof enhanceWindows>[0]) => {
        works.push({ windows: work.windows.length, preroll: work.preroll, mode: work.mode });
        return { segments: enhanceWindows(work), ms: 1 };
      },
    };
    const job = (n0: number, n1: number) => ({ index: viewed, track: opus.number, source: view.convert!, target, n0, n1, ffmpegPath: "/x", readFeed: readFeed as never, niceness: 0, timeoutMs: 1000, dialogue });
    ffmpegCalls.length = 0;
    const lead = await convertRange(job(0, 2));
    expect(ffmpegCalls.map((c) => c.kind)).toEqual(["decode", "encode", "encode"]);
    expect(works).toEqual([{ windows: 2, preroll: DIALOGUE_PREROLL, mode: "on" }]);
    // La lecture couvre la tâche, pré-roulement du traitement compris.
    const [a0] = segmentFrames(viewed, 0, 1);
    expect(feeds[0].start).toBe(inputWindow(a0, a0).start - DIALOGUE_PREROLL);
    for (const n of [0, 1]) {
      const alone = await convertRange(job(n, n + 1));
      expect(Buffer.from(alone.segments.get(n)!).equals(Buffer.from(lead.segments.get(n)!))).toBe(true);
    }
  });

  it("l'AC-3/E-AC-3 : un décodage par segment (le tramage du décodeur Dolby dépend de son départ)", async () => {
    const { convertRange } = await import("@/lib/lumenServer/audio/convert");
    const viewed = withDialogue(withConversion(index, ctx()), ctx());
    const ac3 = viewed.audio.find((a) => a.codecId === "A_AC3")!;
    const view = dialogueTrackView(ac3, "strong")!;
    const readFeed = async (spec: { start: number; end: number }) => {
      const startSample = spec.start - 12_000;
      const units = Math.ceil((spec.end - startSample) / 1536);
      return { feed: { format: "eac3", bytes: new Uint8Array(units), startSample, endSample: startSample + units * 1536, units }, diskMs: 0, ms: 1 };
    };
    const dialogue = { mode: "strong" as const, enhance: async (work: Parameters<typeof enhanceWindows>[0]) => ({ segments: enhanceWindows(work), ms: 1 }) };
    ffmpegCalls.length = 0;
    await convertRange({ index: viewed, track: ac3.number, source: view.convert!, target: TARGET_51, n0: 0, n1: 2, ffmpegPath: "/x", readFeed: readFeed as never, niceness: 0, timeoutMs: 1000, dialogue });
    expect(ffmpegCalls.map((c) => c.kind)).toEqual(["decode", "encode", "decode", "encode"]);
  });
});

describe("l'hôte : ce que la page lit et écrit", () => {
  it("la liste maître relie aussi les rendus convertis et traités au menu (`a3x…`, `a3d1x…`)", async () => {
    const { parseMasterAudio, processingOf } = await import("@/components/player/lumen/lumenOpening");
    const text = [
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",LANGUAGE="fr",NAME="FR",DEFAULT=YES,URI="a2d1x0a1b2c3d.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",LANGUAGE="en",NAME="EN",DEFAULT=NO,URI="a4x0a1b2c3d.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="g",LANGUAGE="en",NAME="EN 2",DEFAULT=NO,URI="a5.m3u8"',
    ].join("\n");
    expect(parseMasterAudio(text).map((m) => m.number)).toEqual([2, 4, 5]);
    const ac3 = { codec: "A_AC3", converted: null, dialogue: "eac3-640-51" };
    expect(processingOf(ac3)).toBe("copié tel quel");
    expect(processingOf(ac3, "strong")).toBe("dialogues davantage par le serveur (A_AC3 → E-AC-3 5.1)");
    expect(processingOf({ codec: "A_AAC", converted: null, dialogue: null }, "on")).toBe("copié tel quel, sans rendu « dialogues »");
  });

  it("la ligne `audio` porte la force servie ; la ligne `start`, la force et qui la fait", async () => {
    const { lumenAudioFields, lumenStartFields } = await import("@/components/player/lumen/lumenLog");
    const ctx = { itemId: "g1", title: "T", cast: false, session: "s1" } as never;
    expect(lumenAudioFields(ctx, { from: 2, to: 2, fromTrack: "FR", toTrack: "FR", via: "réouverture", applied: true, tookMs: 900, at: 12, dialogue: "on" }, "S")).toMatchObject({ dialogue: "on", from: 2, to: 2 });
    expect(lumenAudioFields(ctx, { from: 2, to: 3, fromTrack: "FR", toTrack: "EN", via: "audioTracks", applied: true, tookMs: 900, at: 12 }, "S")).not.toHaveProperty("dialogue");
    const start = lumenStartFields(ctx, { why: "open", at: 0, audioTrack: 2, lumenSession: "S", version: "5-x", fragment: false, negotiateMs: 1, dialogue: "strong" });
    expect(start).toMatchObject({ dialogue: "strong", dialogueBy: "serveur" });
    expect(lumenStartFields(ctx, { why: "open", at: 0, audioTrack: 2, lumenSession: "S", version: "5-x", fragment: false, negotiateMs: 1 })).not.toHaveProperty("dialogue");
  });
});
