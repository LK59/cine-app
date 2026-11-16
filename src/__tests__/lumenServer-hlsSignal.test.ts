// La signalisation HLS de Lumen serveur (étape 1) : le `dec3` complet (7.1, Atmos), l'entrée Dolby
// Vision pour HLS, et les attributs de la liste maître. Et surtout : le chemin MediaSource n'a pas
// bougé — sans l'option, chaque entrée est celle d'avant à l'octet près.
//
// Les trames sont fabriquées champ par champ selon ETSI TS 102 366 V1.4.1 (E.1.2.2 et 5.3.2), avec
// des motifs non nuls dans tout ce que le lecteur doit sauter : un champ sauté de travers décale la
// suite et fait échouer `bsmod` ou `complexity_index_type_a`. Les valeurs attendues des boîtes sont
// écrites à la main depuis le tableau F.6 ; trois d'entre elles sont aussi celles relevées sur de
// vrais fichiers (banc `lumen-signal-bench.spec.ts`, 16/11/2026) et chez ffmpeg 9.0.2.
import { describe, it, expect } from "vitest";
import {
  __testing,
  audioSampleEntryFor,
  chanLocChannels,
  chanmapToChanLoc,
  dec3,
  dec3Complete,
  describeEac3,
  hlsDolbyVisionEntry,
  videoSampleEntry,
} from "@/lib/webcodecs/mp4SampleEntries";
import {
  avcTransferCharacteristics,
  hevcTransferCharacteristics,
  hlsAudioSignal,
  hlsVideoSignal,
  variantCodecs,
} from "@/lib/lumenServer/hlsSignal";
import type { MatroskaTrack, TrackColour } from "@/lib/webcodecs/matroska";

const { BitWriter } = __testing;
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fromHex = (s: string) => new Uint8Array(Buffer.from(s, "hex"));

interface Eac3FrameSpec {
  strmtyp?: number;
  substreamid?: number;
  frmsiz: number;
  fscod?: number;
  fscod2?: number;
  numblkscod?: number;
  acmod: number;
  lfeon: number;
  bsid?: number;
  compr?: boolean;
  chanmap?: number;
  /** mixmdate : 1, avec `mixdef` (3 par défaut, trois octets de données). */
  mix?: { mixdef?: number };
  /** infomdate : 1, avec ce `bsmod`. */
  bsmod?: number;
  addbsi?: number[];
}

/** Une trame E-AC-3 complète, chaque champ écrit dans l'ordre de E.1.2.2, remplie jusqu'à sa taille. */
function eac3Frame(f: Eac3FrameSpec): Uint8Array {
  const strmtyp = f.strmtyp ?? 0;
  const fscod = f.fscod ?? 0;
  const numblkscod = fscod === 3 ? 3 : (f.numblkscod ?? 3);
  const blocks = [1, 2, 3, 6][numblkscod];
  const { acmod, lfeon } = f;
  const w = new BitWriter();
  w.write(0x0b77, 16).write(strmtyp, 2).write(f.substreamid ?? 0, 3).write(f.frmsiz, 11).write(fscod, 2);
  w.write(fscod === 3 ? (f.fscod2 ?? 0) : numblkscod, 2);
  w.write(acmod, 3).write(lfeon, 1).write(f.bsid ?? 16, 5);
  for (let i = 0; i < (acmod === 0 ? 2 : 1); i++) {
    w.write(0b10101, 5); // dialnorm
    w.write(f.compr ? 1 : 0, 1);
    if (f.compr) w.write(0xa5, 8);
  }
  if (strmtyp === 1) {
    w.write(f.chanmap !== undefined ? 1 : 0, 1);
    if (f.chanmap !== undefined) w.write(f.chanmap, 16);
  }
  w.write(f.mix ? 1 : 0, 1);
  if (f.mix) {
    if (acmod > 2) w.write(0b10, 2);
    if (acmod & 1 && acmod > 2) w.write(0b101101, 6);
    if (acmod & 4) w.write(0b110011, 6);
    if (lfeon) w.write(1, 1).write(0b10110, 5);
    if (strmtyp === 0) {
      w.write(1, 1).write(0b111000, 6); // pgmscl
      if (acmod === 0) w.write(1, 1).write(0b000111, 6); // pgmscl2
      w.write(1, 1).write(0b101010, 6); // extpgmscl
      const mixdef = f.mix.mixdef ?? 3;
      w.write(mixdef, 2);
      if (mixdef === 1) w.write(0b11011, 5);
      else if (mixdef === 2) w.write(0xabc, 12);
      else if (mixdef === 3) w.write(1, 5).write(0xa5, 8).write(0x5a, 8).write(0xff, 8); // (1 + 2) octets
      if (acmod < 2) {
        w.write(1, 1).write(0x3fff, 14); // panmean, paninfo
        if (acmod === 0) w.write(1, 1).write(0x2aaa, 14);
      }
      w.write(1, 1); // frmmixcfginfoe
      if (numblkscod === 0) w.write(0b10101, 5);
      else for (let b = 0; b < blocks; b++) w.write(1, 1).write(0b01110, 5);
    }
  }
  w.write(f.bsmod !== undefined ? 1 : 0, 1);
  if (f.bsmod !== undefined) {
    w.write(f.bsmod, 3).write(0b11, 2);
    if (acmod === 2) w.write(0b1011, 4);
    if (acmod >= 6) w.write(0b11, 2);
    w.write(1, 1).write(0xc3, 8); // audprodie
    if (acmod === 0) w.write(1, 1).write(0x3c, 8);
    if (fscod < 3) w.write(1, 1); // sourcefscod
  }
  if (strmtyp === 0 && numblkscod !== 3) w.write(1, 1); // convsync
  if (strmtyp === 2) {
    if (numblkscod !== 3) w.write(1, 1); // blkid
    w.write(0b101010, 6);
  }
  w.write(f.addbsi ? 1 : 0, 1);
  if (f.addbsi) {
    w.write(f.addbsi.length - 1, 6);
    for (const byte of f.addbsi) w.write(byte, 8);
  }
  const header = w.bytes();
  const frame = new Uint8Array((f.frmsiz + 1) * 2);
  frame.set(header);
  return frame;
}

/** Une trame AC-3 (5.3.2), remplie jusqu'à la taille que dit `frmsizecod` à 48 kHz. */
function ac3Frame(f: { frmsizecod: number; bsid: number; bsmod: number; acmod: number; lfeon: number }): Uint8Array {
  const w = new BitWriter();
  w.write(0x0b77, 16).write(0x1234, 16).write(0, 2).write(f.frmsizecod, 6).write(f.bsid, 5).write(f.bsmod, 3).write(f.acmod, 3);
  if ((f.acmod & 1) !== 0 && f.acmod !== 1) w.write(0b10, 2);
  if ((f.acmod & 4) !== 0) w.write(0b01, 2);
  if (f.acmod === 2) w.write(0b11, 2);
  w.write(f.lfeon, 1);
  const kbps = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512, 576, 640][f.frmsizecod >> 1];
  const frame = new Uint8Array(kbps * 4);
  frame.set(w.bytes());
  return frame;
}

const join = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Atmos 5.1 à 640 kbit/s : `addbsi` = 7 bits réservés, drapeau, complexité 16 (TS 103 420 §8.3). */
const ATMOS = eac3Frame({ frmsiz: 1279, acmod: 7, lfeon: 1, mix: {}, bsmod: 0, compr: true, addbsi: [0x01, 16] });
/** E-AC-3 7.1 : 5.1 indépendant à 384 kbit/s + dépendant Ls Rs Lrs/Rrs à 256 kbit/s (comme *Avatar 3*). */
const EAC3_71 = join(
  eac3Frame({ frmsiz: 767, acmod: 7, lfeon: 1 }),
  eac3Frame({ strmtyp: 1, frmsiz: 511, acmod: 5, lfeon: 0, chanmap: 0x1a00, mix: {} })
);
/** « 7.1 » de Blu-ray : cœur AC-3 5.1 à 448 kbit/s + dépendant E-AC-3 à 320 kbit/s (comme *2 Guns*). */
const AC3_CORE_71 = join(
  ac3Frame({ frmsizecod: 30, bsid: 6, bsmod: 0, acmod: 7, lfeon: 1 }),
  eac3Frame({ strmtyp: 1, frmsiz: 639, acmod: 5, lfeon: 0, chanmap: 0x1a00 })
);

describe("dec3 complet — la boîte octet par octet", () => {
  it("Atmos : l'extension JOC suit le sous-flux, valeurs relevées aussi chez ffmpeg et sur 6 vraies pistes", () => {
    // 640 = 0b0001010000000 · num_ind_sub 0 → 14 00 ; fscod 0, bsid 16 → 20 ; acmod 7, lfeon 1 → 0f ;
    // num_dep_sub 0 + réservé → 00 ; 7 réservés + flag → 01 ; complexité 16 → 10.
    expect(hex(dec3Complete(describeEac3(ATMOS)))).toBe("0000000f" + "64656333" + "1400200f000110");
  });

  it("E-AC-3 7.1 : un dépendant, `chan_loc` = Lrs/Rrs (bit 1, poids faible), débit = somme des sous-flux", () => {
    // 384 + 256 = 640 kbit/s ; 000 · 0001 · 0_0000_0010 → 02 02. Celle de *Avatar 3* au banc.
    expect(hex(dec3Complete(describeEac3(EAC3_71)))).toBe("0000000e" + "64656333" + "1400200f0202");
    expect(describeEac3(EAC3_71).channels).toBe(8);
  });

  it("cœur AC-3 + dépendant E-AC-3 : le sous-flux 0 est décrit depuis la trame AC-3 (bsid 6)", () => {
    // 448 + 320 = 768 → 18 00 ; fscod 0, bsid 6 → 0c ; acmod 7, lfeon 1 → 0f. Celle de *2 Guns*,
    // *Edge of Tomorrow* et *Saving Private Ryan* au banc.
    expect(hex(dec3Complete(describeEac3(AC3_CORE_71)))).toBe("0000000e" + "64656333" + "18000c0f0202");
    expect(describeEac3(AC3_CORE_71).channels).toBe(8);
  });

  it("une trame sans dépendant ni Atmos donne la même boîte que l'ancien `dec3` (débit compris)", () => {
    const plain = eac3Frame({ frmsiz: 1279, acmod: 7, lfeon: 1 });
    expect(hex(dec3Complete(describeEac3(plain)))).toBe(hex(dec3(plain)));
  });

  it("lit `bsmod` dans infomdate (F.6.2.8) — l'ancien `dec3` écrivait toujours 0", () => {
    const frame = eac3Frame({ frmsiz: 1279, acmod: 7, lfeon: 1, bsmod: 4 });
    expect(hex(dec3Complete(describeEac3(frame))).slice(-6)).toBe("204f00"); // 0 100 111 1
  });

  it.each([
    { name: "1+1 (acmod 0) : tous les doubles champs", acmod: 0, lfeon: 0, numblkscod: 3 },
    { name: "mono : panoramique présent", acmod: 1, lfeon: 0, numblkscod: 3 },
    { name: "2/0 : dsurmod et dheadphonmod", acmod: 2, lfeon: 0, numblkscod: 3 },
    { name: "3/2 + LFE, deux blocs : convsync et mélange par bloc", acmod: 7, lfeon: 1, numblkscod: 1 },
    { name: "3/2 + LFE, un bloc : un seul blkmixcfginfo", acmod: 7, lfeon: 1, numblkscod: 0 },
    { name: "2/2 : dsurexmod", acmod: 6, lfeon: 1, numblkscod: 3 },
  ])("traverse bsi() jusqu'à addbsi sans décaler un bit — $name", ({ acmod, lfeon, numblkscod }) => {
    for (const mixdef of [0, 1, 2, 3]) {
      const frame = eac3Frame({ frmsiz: 511, acmod, lfeon, numblkscod, compr: true, mix: { mixdef }, bsmod: 5, addbsi: [0x01, 12, 0x77] });
      const d = describeEac3(frame);
      expect(d.substreams[0]).toMatchObject({ acmod, lfeon, bsmod: 5, numDepSub: 0 });
      expect(d.joc).toEqual({ complexityIndex: 12 });
    }
  });

  it("demi-fréquence (fscod 3) : fscod recopié, débit sur la vraie fréquence, pas de sourcefscod", () => {
    const frame = eac3Frame({ frmsiz: 639, fscod: 3, fscod2: 1, acmod: 2, lfeon: 0, bsmod: 3, addbsi: [0x01, 8] });
    const d = describeEac3(frame);
    expect(d.dataRate).toBe(147); // 1 280 octets pour 1 536 échantillons à 22,05 kHz
    expect(d.substreams[0]).toMatchObject({ fscod: 3, bsmod: 3 });
    expect(d.joc).toEqual({ complexityIndex: 8 });
  });

  it("pas d'extension sans drapeau, ni avec un drapeau privé de son octet de complexité", () => {
    expect(describeEac3(eac3Frame({ frmsiz: 511, acmod: 7, lfeon: 1, addbsi: [0x00, 16] })).joc).toBeNull();
    expect(describeEac3(eac3Frame({ frmsiz: 511, acmod: 7, lfeon: 1, addbsi: [0x01] })).joc).toBeNull();
  });

  it("s'arrête à la série suivante : deux trames indépendantes de suite ne font pas deux sous-flux", () => {
    const two = join(eac3Frame({ frmsiz: 255, acmod: 7, lfeon: 1, numblkscod: 1 }), eac3Frame({ frmsiz: 255, acmod: 7, lfeon: 1, numblkscod: 1 }));
    const d = describeEac3(two);
    expect(d.substreams).toHaveLength(1);
    expect(d.dataRate).toBe(384); // 512 octets pour 2 blocs de 256 à 48 kHz
  });

  it("refuse ce qui n'est pas une trame", () => {
    expect(() => describeEac3(new Uint8Array(64))).toThrow(/illisible/);
  });
});

describe("chan_loc", () => {
  it("suit le tableau F.6.1 : bit 0 (poids faible) Lc/Rc … bit 8 (poids fort) LFE2", () => {
    const at = (index: number) => 1 << (15 - index); // chanmap : bit 0 = poids fort (E.1.4)
    expect(chanmapToChanLoc(at(5))).toBe(1 << 0); // Lc/Rc
    expect(chanmapToChanLoc(at(6))).toBe(1 << 1); // Lrs/Rrs
    expect(chanmapToChanLoc(at(12))).toBe(1 << 7); // Vhc
    expect(chanmapToChanLoc(at(13))).toBe(0); // Lts/Rts : pas de place dans chan_loc
    expect(chanmapToChanLoc(at(14))).toBe(1 << 8); // LFE2
    // L C R Ls Rs et LFE remplacent ceux du 5.1 : rien d'ajouté (F.6.2.13).
    expect(chanmapToChanLoc(at(0) | at(1) | at(2) | at(3) | at(4) | at(15))).toBe(0);
  });

  it("compte les canaux ajoutés", () => {
    expect(chanLocChannels(0b000000010)).toBe(2);
    expect(chanLocChannels(0b111111111)).toBe(14);
  });
});

describe("chemin MediaSource inchangé", () => {
  const input = { codecId: "A_EAC3", codecPrivate: null, channels: 6, sampleRate: 48000, firstFrame: ATMOS };

  it("sans option, l'entrée `ec-3` porte l'ancien `dec3`, ni dépendants ni extension", () => {
    const entry = audioSampleEntryFor(input);
    expect(hex(entry)).toBe(hex(audioSampleEntryFor(input, {})));
    expect(hex(entry)).toContain("0000000d" + "64656333" + "1400200f00");
    expect(hex(entry)).not.toContain("0000000f64656333");
  });

  it("avec `signalling: \"hls\"`, seule la boîte `dec3` change", () => {
    const mse = audioSampleEntryFor(input);
    const hls = audioSampleEntryFor(input, { signalling: "hls" });
    expect(hls.length).toBe(mse.length + 2);
    expect(hex(hls).slice(8, 8 + 2 * 28)).toBe(hex(mse).slice(8, 8 + 2 * 28)); // mêmes champs d'entrée
  });

  it("l'AC-3 et l'AAC ne dépendent pas de l'option", () => {
    const ac3 = { codecId: "A_AC3", codecPrivate: null, channels: 6, sampleRate: 48000, firstFrame: ac3Frame({ frmsizecod: 30, bsid: 8, bsmod: 0, acmod: 7, lfeon: 1 }) };
    expect(hex(audioSampleEntryFor(ac3, { signalling: "hls" }))).toBe(hex(audioSampleEntryFor(ac3)));
    const aac = { codecId: "A_AAC", codecPrivate: fromHex("1190"), channels: 2, sampleRate: 48000, firstFrame: null };
    expect(hex(audioSampleEntryFor(aac, { signalling: "hls" }))).toBe(hex(audioSampleEntryFor(aac)));
  });
});

// ── Vidéo ────────────────────────────────────────────────────────────────────

/** `hvcC` réel (SDR, Main 10, tier High, niveau 5) — VUI : transfert 1 (BT.709). */
const HVCC_SDR = fromHex(
  "012220000000b0000000000096f000fcfdfafa00000f03200001001840010c01ffff222000000300b0000003000003009618b024210001003c420101222000000300b00000030000030096a001df20064136718b92448053888892cf24a69272c9124922dc91aa48fca223ff000100016a0202020122000100084401c0252f053240"
);
/** `hvcC` réel d'un DV 8.1 sans élément Colour dans le Matroska — VUI : transfert 16 (PQ). */
const HVCC_PQ = fromHex(
  "01222000000090000000000099f000fcfdfafa00000f03200001001940010c01ffff222000000300900000030000030099958a02402100010039420101222000000300900000030000030099a001e0200641365958abb482a6a1220136c2000007d20000bb80c5792cbc0002625a0001312d1022000100084401c1732979c689"
);
/** `avcC` réel, High 4.1, VUI : transfert 1. */
const AVCC = fromHex("01640029ffe1001d67640029acd98078067f9f016a020202800000030080015f90078c18cd01000668e978b3c8f0");

/** Un enregistrement Dolby Vision de 24 octets : version 1.0, profil, niveau, rpu/el/bl, compatibilité. */
function dvRecord(profile: number, level: number, el: number, compatibilityId: number): Uint8Array {
  const record = new Uint8Array(24);
  const bits = (profile << 9) | (level << 3) | (1 << 2) | (el << 1) | 1;
  record.set([1, 0, bits >> 8, bits & 0xff, compatibilityId << 4]);
  return record;
}

function videoTrack(codecId: string, codecPrivate: Uint8Array, extra: { colour?: TrackColour; dolbyVision?: { type: string; record: Uint8Array } } = {}): MatroskaTrack {
  return {
    number: 1,
    type: "video",
    codecId,
    codecPrivate,
    language: null,
    name: null,
    isDefault: true,
    isForced: false,
    isHearingImpaired: false,
    isEnabled: true,
    defaultDurationNs: null,
    video: { width: 3840, height: 2160, colour: extra.colour },
    dolbyVision: extra.dolbyVision,
  };
}

const fourccOf = (entry: Uint8Array) => String.fromCharCode(...entry.subarray(4, 8));

describe("entrée Dolby Vision pour HLS", () => {
  const p81 = { type: "dvvC", record: dvRecord(8, 6, 0, 1) };
  const p5 = { type: "dvcC", record: dvRecord(5, 6, 0, 0) };
  const p7 = { type: "dvcC", record: dvRecord(7, 6, 1, 6) };

  it("choisit la forme par profil et compatibilité", () => {
    expect(hlsDolbyVisionEntry(p81.record)).toBe("hvc1+dv");
    expect(hlsDolbyVisionEntry(dvRecord(8, 6, 0, 2))).toBe("hvc1+dv");
    expect(hlsDolbyVisionEntry(dvRecord(8, 6, 0, 4))).toBe("hvc1+dv");
    expect(hlsDolbyVisionEntry(dvRecord(8, 6, 0, 6))).toBe("hvc1"); // compatibilité inconnue d'Apple
    expect(hlsDolbyVisionEntry(p5.record)).toBe("dvh1");
    expect(hlsDolbyVisionEntry(p7.record)).toBe("hvc1");
    expect(hlsDolbyVisionEntry(new Uint8Array(3))).toBe("hvc1");
  });

  it("8.1 : `hvc1` portant hvcC puis la boîte DV recopiée — seul le nom diffère de la forme MSE", () => {
    const hls = videoSampleEntry("V_MPEGH/ISO/HEVC", HVCC_PQ, 3840, 2160, p81, undefined, { signalling: "hls" });
    const mse = videoSampleEntry("V_MPEGH/ISO/HEVC", HVCC_PQ, 3840, 2160, p81);
    expect(fourccOf(hls)).toBe("hvc1");
    expect(fourccOf(mse)).toBe("dvh1"); // MediaSource : inchangé
    expect(hex(hls.subarray(8))).toBe(hex(mse.subarray(8)));
    expect(hex(hls)).toContain("00000020" + "64767643" + hex(p81.record));
  });

  it("5 : `dvh1`, identique à la forme MSE", () => {
    const hls = videoSampleEntry("V_MPEGH/ISO/HEVC", HVCC_PQ, 3840, 2160, p5, undefined, { signalling: "hls" });
    expect(hex(hls)).toBe(hex(videoSampleEntry("V_MPEGH/ISO/HEVC", HVCC_PQ, 3840, 2160, p5)));
  });

  it("7 : `hvc1` sans boîte DV — la même entrée qu'un HEVC ordinaire", () => {
    const hls = videoSampleEntry("V_MPEGH/ISO/HEVC", HVCC_PQ, 3840, 2160, p7, undefined, { signalling: "hls" });
    expect(hex(hls)).toBe(hex(videoSampleEntry("V_MPEGH/ISO/HEVC", HVCC_PQ, 3840, 2160)));
  });

  it("sans Dolby Vision, l'option ne change rien", () => {
    expect(hex(videoSampleEntry("V_MPEGH/ISO/HEVC", HVCC_SDR, 1920, 1080, null, undefined, { signalling: "hls" }))).toBe(
      hex(videoSampleEntry("V_MPEGH/ISO/HEVC", HVCC_SDR, 1920, 1080))
    );
  });
});

describe("VIDEO-RANGE lu dans le SPS", () => {
  it("lit transfer_characteristics dans le VUI d'un vrai SPS HEVC et H.264", () => {
    expect(hevcTransferCharacteristics(HVCC_PQ)).toBe(16);
    expect(hevcTransferCharacteristics(HVCC_SDR)).toBe(1);
    expect(avcTransferCharacteristics(AVCC)).toBe(1);
  });

  it("rend null, sans lever, pour un enregistrement tronqué ou sans SPS", () => {
    expect(hevcTransferCharacteristics(HVCC_PQ.subarray(0, 60))).toBeNull();
    expect(hevcTransferCharacteristics(HVCC_PQ.subarray(0, 23))).toBeNull();
    expect(avcTransferCharacteristics(AVCC.subarray(0, 12))).toBeNull();
  });
});

describe("hlsVideoSignal", () => {
  const HEVC = "V_MPEGH/ISO/HEVC";

  it("HEVC sans Colour : le SPS décide", () => {
    expect(hlsVideoSignal(videoTrack(HEVC, HVCC_SDR))).toEqual({ codecs: "hvc1.2.4.H150.B0", supplementalCodecs: null, videoRange: "SDR", rangeSource: "sps", entry: "hvc1" });
    expect(hlsVideoSignal(videoTrack(HEVC, HVCC_PQ))).toMatchObject({ videoRange: "PQ", rangeSource: "sps" });
  });

  it("le Colour du Matroska passe avant le SPS quand il répond", () => {
    expect(hlsVideoSignal(videoTrack(HEVC, HVCC_SDR, { colour: { transferCharacteristics: 18 } }))).toMatchObject({ videoRange: "HLG", rangeSource: "matroska" });
    // 2 = « non précisé » : pas une réponse, le SPS reprend la main.
    expect(hlsVideoSignal(videoTrack(HEVC, HVCC_PQ, { colour: { transferCharacteristics: 2 } }))).toMatchObject({ videoRange: "PQ", rangeSource: "sps" });
  });

  it("DV 8.1 / 8.2 / 8.4 : CODECS de la base, SUPPLEMENTAL-CODECS avec la marque, VIDEO-RANGE de la base", () => {
    const of = (compat: number) => hlsVideoSignal(videoTrack(HEVC, HVCC_PQ, { dolbyVision: { type: "dvvC", record: dvRecord(8, 6, 0, compat) } }));
    expect(of(1)).toEqual({ codecs: "hvc1.2.4.H153.90", supplementalCodecs: "dvh1.08.06/db1p", videoRange: "PQ", rangeSource: "dolby-vision", entry: "hvc1+dv" });
    expect(of(2)).toMatchObject({ supplementalCodecs: "dvh1.08.06/db2g", videoRange: "SDR" });
    expect(of(4)).toMatchObject({ supplementalCodecs: "dvh1.08.06/db4h", videoRange: "HLG" });
  });

  it("DV 5 : le codec est `dvh1.05.LL`, toujours PQ", () => {
    expect(hlsVideoSignal(videoTrack(HEVC, HVCC_PQ, { dolbyVision: { type: "dvcC", record: dvRecord(5, 9, 0, 0) } }))).toEqual({
      codecs: "dvh1.05.09",
      supplementalCodecs: null,
      videoRange: "PQ",
      rangeSource: "dolby-vision",
      entry: "dvh1",
    });
  });

  it("DV 7 : rien n'est promis en Dolby Vision", () => {
    expect(hlsVideoSignal(videoTrack(HEVC, HVCC_PQ, { dolbyVision: { type: "dvcC", record: dvRecord(7, 6, 1, 6) } }))).toMatchObject({
      codecs: "hvc1.2.4.H153.90",
      supplementalCodecs: null,
      entry: "hvc1",
    });
  });

  it("H.264 : `avc1` et le VUI", () => {
    expect(hlsVideoSignal(videoTrack("V_MPEG4/ISO/AVC", AVCC))).toEqual({ codecs: "avc1.640029", supplementalCodecs: null, videoRange: "SDR", rangeSource: "sps", entry: "avc1" });
  });

  it("un codec que le remuxeur ne porte pas n'a pas de signalisation", () => {
    expect(hlsVideoSignal(videoTrack("V_MPEG2", new Uint8Array(8)))).toBeNull();
  });
});

describe("hlsAudioSignal et CODECS", () => {
  const audioTrack = (codecId: string, channels: number, codecPrivate: Uint8Array | null = null): MatroskaTrack => ({
    ...videoTrack(codecId, new Uint8Array(0)),
    type: "audio",
    codecPrivate,
    video: undefined,
    audio: { sampleRate: 48000, channels },
  });

  it("CHANNELS : « N/JOC » pour l'Atmos, le compte réel pour un 7.1, l'acmod pour l'AC-3", () => {
    expect(hlsAudioSignal(audioTrack("A_EAC3", 6), ATMOS)).toEqual({ codecs: "ec-3", channels: "16/JOC" });
    expect(hlsAudioSignal(audioTrack("A_EAC3", 8), EAC3_71)).toEqual({ codecs: "ec-3", channels: "8" });
    expect(hlsAudioSignal(audioTrack("A_EAC3", 8), AC3_CORE_71)).toEqual({ codecs: "ec-3", channels: "8" });
    expect(hlsAudioSignal(audioTrack("A_AC3", 6), ac3Frame({ frmsizecod: 30, bsid: 8, bsmod: 0, acmod: 7, lfeon: 1 }))).toEqual({ codecs: "ac-3", channels: "6" });
  });

  it("AAC : l'objet de l'ASC ; FLAC ; et rien pour ce qui doit être converti", () => {
    expect(hlsAudioSignal(audioTrack("A_AAC", 2, fromHex("1190")), null)).toEqual({ codecs: "mp4a.40.2", channels: "2" });
    expect(hlsAudioSignal(audioTrack("A_AAC", 6, fromHex("2b920800")), null)).toMatchObject({ codecs: "mp4a.40.5" });
    expect(hlsAudioSignal(audioTrack("A_FLAC", 6), null)).toEqual({ codecs: "fLaC", channels: "6" });
    expect(hlsAudioSignal(audioTrack("A_DTS", 6), null)).toBeNull();
    expect(hlsAudioSignal(audioTrack("A_TRUEHD", 8), null)).toBeNull();
  });

  it("variantCodecs liste chaque format une fois, la vidéo d'abord", () => {
    const video = hlsVideoSignal(videoTrack("V_MPEGH/ISO/HEVC", HVCC_SDR))!;
    expect(variantCodecs(video, [{ codecs: "ec-3", channels: "16/JOC" }, { codecs: "ec-3", channels: "6" }, { codecs: "ac-3", channels: "6" }])).toBe("hvc1.2.4.H150.B0,ec-3,ac-3");
  });
});
