import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Fmp4Reader, fragmentIndexAt, normalizeFragment, parseInit, scanFragments, type Fmp4Fragment } from "@/lib/offline/fmp4";

/**
 * Le MP4 fragmenté des téléchargements hors ligne, sur un fichier de la forme exacte que Jellyfin
 * livre (`src/__tests__/fixtures/offline/generate.sh` : `frag_keyframe+empty_moov+delay_moov`, HEVC `hev1` + AAC).
 */
const file = new Uint8Array(fs.readFileSync(path.join(process.cwd(), "src/__tests__/fixtures/offline/jellyfin-like.mp4")));
const reader = (bytes: Uint8Array) => async (offset: number, length: number) => bytes.slice(offset, Math.min(bytes.length, offset + length));

describe("parseInit", () => {
  it("l'en-tête : pistes, codecs, fin, et hev1 renommé hvc1 sans toucher au reste", () => {
    const init = parseInit(file)!;
    expect(init.end).toBe(3742);
    expect(init.tracks.map((t) => [t.id, t.kind, t.timescale])).toEqual([
      [1, "video", 12288],
      [2, "audio", 48000],
    ]);
    expect(init.tracks[0].codec).toMatch(/^hvc1\.1\.6\.L\d+/);
    expect(init.tracks[1].codec).toBe("mp4a.40.2");
    expect(init.mime).toBe(`video/mp4; codecs="${init.tracks[0].codec},mp4a.40.2"`);
    const text = Buffer.from(init.bytes).toString("latin1");
    expect(text).not.toContain("hev1");
    expect(text).toContain("hvc1");
    // Quatre octets changés, pas un de plus, et le fichier d'origine intact.
    let diff = 0;
    for (let i = 0; i < init.end; i++) if (init.bytes[i] !== file[i]) diff++;
    expect(diff).toBeLessThanOrEqual(4);
    expect(Buffer.from(file.slice(0, init.end)).toString("latin1")).toContain("hev1");
  });

  it("un en-tête pas encore arrivé en entier : null, pas d'erreur", () => {
    expect(parseInit(file.slice(0, 100))).toBeNull();
    expect(parseInit(file.slice(0, 3000))).toBeNull();
  });
});

describe("scanFragments", () => {
  const video = parseInit(file)!.tracks[0];

  it("tout le fichier : trois fragments, leurs instants, le mfra final sauté", async () => {
    const { fragments, next } = await scanFragments(reader(file), 3742, file.length, video);
    expect(fragments.map((f) => f.offset)).toEqual([3742, 14026, 23869]);
    expect(fragments.map((f) => f.time)).toEqual([0, 1, 1.875]);
    expect(fragments[0].size).toBe(14026 - 3742);
    expect(next).toBe(file.length);
  });

  it("un fichier qui arrive : s'arrête au premier fragment incomplet et reprend de là", async () => {
    const partial = file.slice(0, 20000);
    const first = await scanFragments(reader(partial), 3742, partial.length, video);
    expect(first.fragments.map((f) => f.offset)).toEqual([3742]);
    expect(first.next).toBe(14026);
    const rest = await scanFragments(reader(file), first.next, file.length, video);
    expect(rest.fragments.map((f) => f.offset)).toEqual([14026, 23869]);
  });
});

describe("fragmentIndexAt", () => {
  const fragments = [
    { offset: 0, size: 1, time: 0 },
    { offset: 1, size: 1, time: 10 },
    { offset: 2, size: 1, time: 20 },
  ];
  it("le dernier fragment qui commence avant l'instant", () => {
    expect(fragmentIndexAt(fragments, -1)).toBe(0);
    expect(fragmentIndexAt(fragments, 0)).toBe(0);
    expect(fragmentIndexAt(fragments, 9.99)).toBe(0);
    expect(fragmentIndexAt(fragments, 10)).toBe(1);
    expect(fragmentIndexAt(fragments, 25)).toBe(2);
    expect(fragmentIndexAt([], 5)).toBe(-1);
  });
});

describe("normalizeFragment", () => {
  it("l'adresse absolue de chaque piste devient « relative au moof », et les mêmes octets sont désignés", async () => {
    const video = parseInit(file)!.tracks[0];
    const { fragments } = await scanFragments(reader(file), 3742, file.length, video);
    for (const f of fragments) {
      const original = file.slice(f.offset, f.offset + f.size);
      const fixed = normalizeFragment(original, f.offset);
      // Deux pistes : seize octets de moins, le moof aussi.
      expect(fixed.length).toBe(original.length - 16);
      const view = new DataView(fixed.buffer);
      const moofSize = view.getUint32(0);
      expect(moofSize).toBe(new DataView(original.buffer).getUint32(0) - 16);
      expect(String.fromCharCode(...fixed.subarray(moofSize + 4, moofSize + 8))).toBe("mdat");
      // Chaque trun désigne, dans le fragment corrigé, les mêmes octets qu'avant dans le fichier.
      const trafs = (bytes: Uint8Array) => {
        const out: { flags: number; dataOffset: number; base: number | null }[] = [];
        const v = new DataView(bytes.buffer, bytes.byteOffset);
        let o = 8;
        const end = v.getUint32(0);
        while (o < end) {
          const size = v.getUint32(o);
          if (String.fromCharCode(...bytes.subarray(o + 4, o + 8)) === "traf") {
            let q = o + 8;
            let base: number | null = null;
            let flags = 0;
            while (q < o + size) {
              const s = v.getUint32(q);
              const type = String.fromCharCode(...bytes.subarray(q + 4, q + 8));
              if (type === "tfhd") {
                flags = v.getUint32(q + 8) & 0xffffff;
                base = flags & 1 ? Number(v.getBigUint64(q + 16)) : null;
              }
              if (type === "trun") out.push({ flags, dataOffset: v.getInt32(q + 16), base });
              q += s;
            }
          }
          o += size;
        }
        return out;
      };
      const before = trafs(original);
      const after = trafs(fixed);
      expect(after.every((t) => t.base === null && (t.flags & 0x020000) !== 0)).toBe(true);
      before.forEach((b, i) => {
        const from = b.base! - f.offset + b.dataOffset;
        expect(Buffer.from(fixed.subarray(after[i].dataOffset, after[i].dataOffset + 64)).equals(Buffer.from(original.subarray(from, from + 64)))).toBe(true);
      });
      // Déjà relatif : rendu tel quel.
      expect(normalizeFragment(fixed, f.offset)).toBe(fixed);
    }
  });
});

/*
 * Le fragment trop long : le H.264 que Jellyfin prépare avec `h264_qsv` et ses images forcées toutes
 * les 5 s (`fixtures/offline/generate.sh`), qui ne sont pas des IDR et que `frag_keyframe` ne coupe
 * donc pas — ici un seul fragment de 16 s, IDR en 0, I forcées non marquées en 117, 237 et 357
 * (la forme exacte relevée sur les vrais fichiers, voir `fmp4.ts`).
 */
const h264 = new Uint8Array(fs.readFileSync(path.join(process.cwd(), "src/__tests__/fixtures/offline/jellyfin-h264-qsv.mp4")));

/** Un lecteur de fragment écrit à part de `fmp4.ts` : chaque piste, ses échantillons et leurs octets. */
interface TestSample {
  dts: number;
  duration: number;
  flags: number;
  cto: number;
  bytes: Uint8Array;
}
interface TestTrack {
  tfhdFlags: number;
  tfdt: number;
  samples: TestSample[];
}
function readFragment(bytes: Uint8Array, moofAt = 0): { mdat: [number, number]; tracks: Map<number, TestTrack> } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (o: number) => String.fromCharCode(...bytes.subarray(o + 4, o + 8));
  const kids = (from: number, to: number) => {
    const out: { type: string; start: number; end: number }[] = [];
    for (let o = from; o < to; o += v.getUint32(o)) {
      expect(v.getUint32(o)).toBeGreaterThanOrEqual(8);
      out.push({ type: type(o), start: o, end: o + v.getUint32(o) });
    }
    expect(out.length ? out[out.length - 1].end : from).toBe(to);
    return out;
  };
  expect(type(moofAt)).toBe("moof");
  const moofSize = v.getUint32(moofAt);
  expect(type(moofAt + moofSize)).toBe("mdat");
  const mdat: [number, number] = [moofAt + moofSize + 8, moofAt + moofSize + v.getUint32(moofAt + moofSize)];
  expect(mdat[1]).toBeLessThanOrEqual(bytes.length);
  const tracks = new Map<number, TestTrack>();
  const top = kids(moofAt + 8, moofAt + moofSize);
  expect(top[0].type).toBe("mfhd");
  for (const traf of top.filter((b) => b.type === "traf")) {
    let id = 0;
    let tfhdFlags = 0;
    let base = moofAt;
    let dDur = 0;
    let dSize = 0;
    let dFlags = 0;
    let tfdt = 0;
    let dts = 0;
    const samples: TestSample[] = [];
    for (const box of kids(traf.start + 8, traf.end)) {
      const body = box.start + 8;
      if (box.type === "tfhd") {
        tfhdFlags = v.getUint32(body) & 0xffffff;
        id = v.getUint32(body + 4);
        let p = body + 8;
        if (tfhdFlags & 1) {
          base = Number(v.getBigUint64(p));
          p += 8;
        }
        if (tfhdFlags & 2) p += 4;
        if (tfhdFlags & 8) {
          dDur = v.getUint32(p);
          p += 4;
        }
        if (tfhdFlags & 0x10) {
          dSize = v.getUint32(p);
          p += 4;
        }
        if (tfhdFlags & 0x20) dFlags = v.getUint32(p);
      } else if (box.type === "tfdt") {
        tfdt = bytes[body] === 1 ? Number(v.getBigUint64(body + 4)) : v.getUint32(body + 4);
        dts = tfdt;
      } else if (box.type === "trun") {
        const fl = v.getUint32(body) & 0xffffff;
        const n = v.getUint32(body + 4);
        let p = body + 8;
        let at = base;
        if (fl & 1) {
          at += v.getInt32(p);
          p += 4;
        }
        let first: number | null = null;
        if (fl & 4) {
          first = v.getUint32(p);
          p += 4;
        }
        for (let i = 0; i < n; i++) {
          const take = (flag: number, fallback: number, signed = false) => {
            if (!(fl & flag)) return fallback;
            const value = signed ? v.getInt32(p) : v.getUint32(p);
            p += 4;
            return value;
          };
          const duration = take(0x100, dDur);
          const size = take(0x200, dSize);
          const flags = take(0x400, i === 0 && first !== null ? first : dFlags);
          const cto = take(0x800, 0, true);
          expect(at).toBeGreaterThanOrEqual(mdat[0]);
          expect(at + size).toBeLessThanOrEqual(mdat[1]);
          samples.push({ dts, duration, flags, cto, bytes: bytes.subarray(at, at + size) });
          at += size;
          dts += duration;
        }
      }
    }
    tracks.set(id, { tfhdFlags, tfdt, samples });
  }
  return { mdat, tracks };
}

/** Les types des NAL d'une image H.264 (préfixes de 4 octets). */
const nalTypes = (sample: Uint8Array) => {
  const out: number[] = [];
  for (let at = 0; at + 4 < sample.length; ) {
    const length = new DataView(sample.buffer, sample.byteOffset + at).getUint32(0);
    out.push(sample[at + 4] & 0x1f);
    at += 4 + length;
  }
  return out;
};
/** Le SEI de point de reprise que `fmp4.ts` glisse devant une I forcée, préfixe de longueur compris. */
const RECOVERY = [0, 0, 0, 5, 0x06, 0x06, 0x01, 0xc4, 0x80];
/** L'image telle que l'encodeur l'a écrite : le SEI ajouté, retiré. */
const withoutRecovery = (sample: Uint8Array) => {
  for (let at = 0; at + 4 < sample.length; ) {
    if (RECOVERY.every((b, i) => sample[at + i] === b)) return Buffer.concat([sample.subarray(0, at), sample.subarray(at + RECOVERY.length)]);
    at += 4 + new DataView(sample.buffer, sample.byteOffset + at).getUint32(0);
  }
  return Buffer.from(sample);
};
const isSyncFlags = (flags: number) => (flags & 0x10000) === 0;
const FORCED = [117, 237, 357];

describe("le fragment trop long (H.264 de h264_qsv, images forcées non IDR)", () => {
  const init = parseInit(h264)!;
  const [video, audio] = init.tracks;
  const original = readFragment(h264, init.end);
  const originalVideo = original.tracks.get(video.id)!.samples;
  const originalAudio = original.tracks.get(audio.id)!.samples;
  const pieces = async () => (await scanFragments(reader(h264), init.end, h264.length, video)).fragments;

  it("le fichier a la forme relevée en vrai : un fragment, une IDR, des I forcées non marquées et sans SEI de reprise", () => {
    expect(video.codec).toMatch(/^avc1\./);
    expect(video.nalLengthSize).toBe(4);
    expect(originalVideo.length).toBe(384);
    expect(originalVideo.flatMap((s, i) => (isSyncFlags(s.flags) ? [i] : []))).toEqual([0]);
    expect(nalTypes(originalVideo[0].bytes)).toEqual([7, 8, 6, 5]);
    for (const i of FORCED) expect(nalTypes(originalVideo[i].bytes)).toEqual([7, 8, 6, 1]);
  });

  it("l'index le range en morceaux de ~5 s, qui couvrent toutes les images une fois", async () => {
    const fragments = await pieces();
    expect(fragments.map((f) => f.piece && [f.piece.first, f.piece.count])).toEqual([
      [0, 120],
      [120, 120],
      [240, 120],
      [360, 24],
    ]);
    expect(new Set(fragments.map((f) => `${f.offset}/${f.size}`)).size).toBe(1);
    expect(fragments.map((f) => f.time)).toEqual([0, 120, 240, 360].map((i) => (i * 1001) / 24000));
    expect(fragmentIndexAt(fragments, 11)).toBe(2);
  });

  it("chaque morceau est un fragment valide, et ensemble ils rendent chaque octet une fois, dans l'ordre, sans trou de temps", async () => {
    const fragments = await pieces();
    const reads: number[] = [];
    const fileReader = new Fmp4Reader(async (o, l) => {
      reads.push(l);
      return h264.slice(o, o + l);
    }, init.tracks);
    const videoOut: TestSample[] = [];
    const audioOut: TestSample[] = [];
    const end = (samples: TestSample[]) => (samples.length ? samples[samples.length - 1].dts + samples[samples.length - 1].duration : 0);
    for (const [k, f] of fragments.entries()) {
      const piece = (await fileReader.fragment(f))!;
      expect(piece.entry).toBe(true);
      const parsed = readFragment(piece.bytes);
      // Tout tient dans le morceau, et les adresses sont relatives au moof (ce que Chrome exige).
      expect(parsed.mdat[1]).toBe(piece.bytes.length);
      for (const t of parsed.tracks.values()) expect(t.tfhdFlags & 0x020001).toBe(0x020000);
      const v = parsed.tracks.get(video.id)!;
      const a = parsed.tracks.get(audio.id)!;
      // Le tfdt de chaque piste reprend exactement où le morceau précédent s'arrêtait.
      expect(v.tfdt).toBe(end(videoOut));
      expect(a.tfdt).toBe(end(audioOut));
      // Le son d'un morceau tombe entre sa première image et celle du suivant.
      const next = fragments[k + 1];
      if (next) expect(a.samples[a.samples.length - 1].dts / audio.timescale).toBeLessThan(next.time);
      if (k > 0) expect(a.samples[0].dts / audio.timescale).toBeGreaterThanOrEqual(f.time);
      videoOut.push(...v.samples);
      audioOut.push(...a.samples);
    }
    // Lu par plages : jamais le fragment entier d'un coup.
    expect(Math.max(...reads)).toBeLessThan(h264.length / 3);

    expect(videoOut.length).toBe(originalVideo.length);
    expect(audioOut.length).toBe(originalAudio.length);
    videoOut.forEach((s, i) => {
      const o = originalVideo[i];
      expect([s.dts, s.duration, s.cto]).toEqual([o.dts, o.duration, o.cto]);
      expect(withoutRecovery(s.bytes).equals(Buffer.from(o.bytes))).toBe(true);
    });
    audioOut.forEach((s, i) => {
      const o = originalAudio[i];
      expect([s.dts, s.duration, s.flags]).toEqual([o.dts, o.duration, o.flags]);
      expect(Buffer.from(s.bytes).equals(Buffer.from(o.bytes))).toBe(true);
    });

    // Les points d'entrée : l'IDR, et chaque I forcée — marquée « sync » et annoncée par un SEI de
    // point de reprise juste avant sa tranche. Aucune autre image ne change de drapeaux.
    expect(videoOut.flatMap((s, i) => (isSyncFlags(s.flags) ? [i] : []))).toEqual([0, ...FORCED]);
    for (const i of FORCED) {
      expect(videoOut[i].flags).toBe(0x02000000);
      expect(nalTypes(videoOut[i].bytes)).toEqual([7, 8, 6, 6, 1]);
    }
    expect(Buffer.from(videoOut[0].bytes).equals(Buffer.from(originalVideo[0].bytes))).toBe(true);
    videoOut.forEach((s, i) => {
      if (!FORCED.includes(i)) expect(s.flags).toBe(originalVideo[i].flags);
    });
  });

  it("un saut repart de la dernière image d'entrée avant la position, quitte à reculer d'un morceau", async () => {
    const fragments = await pieces();
    const fileReader = new Fmp4Reader(reader(h264), init.tracks);
    const startOf = async (f: Fmp4Fragment, from: number) => {
      const piece = (await fileReader.fragment(f, from))!;
      if (!piece.entry) return null;
      const parsed = readFragment(piece.bytes);
      return { video: parsed.tracks.get(video.id)!, audio: parsed.tracks.get(audio.id)! };
    };
    // 11 s : le morceau 2 (images 240 à 359) n'a d'entrée qu'en 357, affichée à 15,1 s — il dit non.
    expect(await startOf(fragments[2], 11)).toBeNull();
    // Le moteur recule : la dernière entrée du morceau 1, l'image 237 (affichée à 10,0 s).
    const back = (await startOf(fragments[1], Infinity))!;
    expect(back.video.tfdt).toBe(237 * 1001);
    expect(back.video.samples.length).toBe(3);
    expect(isSyncFlags(back.video.samples[0].flags)).toBe(true);
    expect(nalTypes(back.video.samples[0].bytes)).toEqual([7, 8, 6, 6, 1]);
    // Le son repart avec l'image d'entrée : le premier échantillon gardé est le premier à partir d'elle.
    const entryTime = (237 * 1001) / 24000;
    expect(back.audio.tfdt / audio.timescale).toBeGreaterThanOrEqual(entryTime);
    expect((back.audio.tfdt - 1024) / audio.timescale).toBeLessThan(entryTime);
    // 15,5 s : l'image 357 est dans le morceau.
    expect((await startOf(fragments[2], 15.5))!.video.tfdt).toBe(357 * 1001);
    // Le dernier morceau (360 à 383) n'en a aucune ; le premier commence toujours sur la sienne.
    expect(await startOf(fragments[3], 16)).toBeNull();
    expect((await startOf(fragments[0], 0))!.video.tfdt).toBe(0);
    expect((await startOf(fragments[0], 3))!.video.samples.length).toBe(120);
  });

  it("un fichier encore incomplet : le fragment n'est indexé qu'une fois entier", async () => {
    const partial = h264.slice(0, 100_000);
    const first = await scanFragments(reader(partial), init.end, partial.length, video);
    expect(first.fragments).toEqual([]);
    expect(first.next).toBe(init.end);
  });
});

describe("le fragment ordinaire (HEVC, ~10 s) : rien ne change", () => {
  it("pas de morceaux, et les octets confiés sont exactement ceux de normalizeFragment, quel que soit le départ", async () => {
    const init = parseInit(file)!;
    const { fragments } = await scanFragments(reader(file), init.end, file.length, init.tracks[0]);
    expect(fragments.length).toBe(3);
    expect(fragments.every((f) => f.piece === undefined)).toBe(true);
    const fileReader = new Fmp4Reader(reader(file), init.tracks);
    for (const f of fragments) {
      const expected = normalizeFragment(file.slice(f.offset, f.offset + f.size), f.offset);
      for (const from of [undefined, 0, f.time + 0.5, Infinity]) {
        const piece = (await fileReader.fragment(f, from))!;
        expect(piece.entry).toBe(true);
        expect(Buffer.from(piece.bytes).equals(Buffer.from(expected))).toBe(true);
      }
    }
  });
});
