// Une trame AC-3 ou E-AC-3 silencieuse, aux paramètres exacts d'une piste. DECISIONS.md §159.
//
// Pourquoi construite ici plutôt que tirée d'une table pré-encodée par ffmpeg ou reprise de la piste :
// - **Les paramètres exacts.** L'en-tête de la trame (syncinfo et `bsi()` en entier : fréquence, taille de
//   trame donc débit, `bsid`, `bsmod`, `acmod`, `lfeon`, `dialnorm`, niveaux de mixage, métadonnées
//   d'information, `addbsi`) est **recopié bit pour bit** d'une vraie trame de la piste. Une table
//   pré-encodée ne couvre qu'un nombre fini de combinaisons (acmod × lfeon × 19 débits × fréquences, sans
//   compter dialnorm), et une trame d'un autre débit ou d'un autre `dialnorm` au milieu d'une piste change
//   ce que la boîte `dac3`/`dec3` décrit ; la règle 2.11 d'Apple veut une discontinuité pour tout
//   changement de disposition. Reprendre une trame silencieuse de la piste suppose qu'il en existe une, à
//   zéro numérique — rien ne le garantit (*The Circle* commence son AC-3 sur du son).
// - **La syntaxe des blocs est minuscule** pour un silence (A/52 §5.4.3, Annexe E §E.1.2), et elle a été
//   écrite en suivant l'ordre de lecture de FFmpeg 7.1.5 (`decode_audio_block`, `ff_eac3_parse_header`),
//   puis prouvée par son décodeur (`-err_detect crccheck+bitstream+explode`) et par le banc.
//
// La trame : bloc 0 sans commutation de blocs, **sans tramage** (`dithflag` 0 — sinon un décodeur remplit
// de bruit les coefficients à zéro bit), sans couplage, exposants `D15` (AC-3 : `D45`) tous égaux, puis la
// décalage de rapport signal/bruit `csnroffst` = `fsnroffst` = 0 : le cas que la norme et FFmpeg traitent à
// part (`snr_offset == -960` : toutes les allocations à zéro). Aucun bit de mantisse, donc des coefficients
// nuls, donc des zéros exacts après la transformée — et un recouvrement nul pour le bloc suivant, l'état
// d'un décodeur neuf. Les blocs 1 à 5 réutilisent tout. Le reste de la trame est du bourrage nul, puis
// `auxdatae` = 0 et la vérification : `crc1` (AC-3, les 5/8 premiers) et `crc2`.
//
// Ce qui n'est **pas** construit (la piste reste refusée, la raison le dit) : un E-AC-3 à sous-flux
// dépendants (le « 7.1 » : il faudrait une trame dépendante aussi), un E-AC-3 Atmos (JOC — voir
// `dolbySilenceRefusal`), un E-AC-3 de moins de six blocs par trame ou à fréquence réduite, un AC-3 de
// `bsid` 9 ou 10 (demi- et quart de fréquence), une trame trop petite pour ses exposants.

import { BitReader, BitWriter } from "./bits";

/** Ce que l'en-tête d'une trame AC-3/E-AC-3 dit, et où il finit (en bits depuis le mot de synchronisation). */
export interface DolbyHeader {
  kind: "ac3" | "eac3";
  bsid: number;
  /** Octets de la trame. */
  frameSize: number;
  /** fscod : 0 = 48 kHz, 1 = 44,1, 2 = 32, 3 = fréquence réduite (E-AC-3). */
  fscod: number;
  sampleRate: number;
  acmod: number;
  lfeon: number;
  /** Blocs de 256 échantillons par trame. */
  blocks: number;
  /** E-AC-3 : strmtyp (0 indépendant, 1 dépendant, 2 converti d'AC-3) et substreamid. */
  strmtyp: number;
  substreamid: number;
  /** Le drapeau Atmos d'`addbsi` (flag_ec3_extension_type_a, ETSI TS 103 420 §8.3). */
  joc: boolean;
  /** La fin du `bsi()`, en bits depuis le début de la trame : là où commencent les blocs (AC-3) ou `audfrm()`. */
  bsiEnd: number;
}

const AC3_RATES = [48000, 44100, 32000];
/** Mots de 16 bits par trame AC-3, par `frmsizecod` (0 à 37) et fscod (A/52 tableau 5.18). */
const AC3_FRAME_WORDS: [number, number, number][] = [
  [64, 69, 96], [64, 70, 96], [80, 87, 120], [80, 88, 120], [96, 104, 144], [96, 105, 144], [112, 121, 168], [112, 122, 168],
  [128, 139, 192], [128, 140, 192], [160, 174, 240], [160, 175, 240], [192, 208, 288], [192, 209, 288], [224, 243, 336], [224, 244, 336],
  [256, 278, 384], [256, 279, 384], [320, 348, 480], [320, 349, 480], [384, 417, 576], [384, 418, 576], [448, 487, 672], [448, 488, 672],
  [512, 557, 768], [512, 558, 768], [640, 696, 960], [640, 697, 960], [768, 835, 1152], [768, 836, 1152], [896, 975, 1344], [896, 976, 1344],
  [1024, 1114, 1536], [1024, 1115, 1536], [1152, 1253, 1728], [1152, 1254, 1728], [1280, 1393, 1920], [1280, 1394, 1920],
];
/** Canaux pleine bande par acmod. */
const FBW_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];

/**
 * L'en-tête de la première trame de `frame` (un bloc Matroska peut en contenir plusieurs), lu champ par champ
 * dans l'ordre de `ff_ac3_parse_header` / `ac3_parse_header` / `ff_eac3_parse_header` de FFmpeg. Null pour ce
 * qui n'est pas une trame lisible.
 */
export function readDolbyHeader(frame: Uint8Array): DolbyHeader | null {
  try {
    const r = new BitReader(frame);
    if (r.read(16) !== 0x0b77) return null;
    const bsidAhead = (frame[5] >> 3) & 0x1f;
    if (bsidAhead <= 10) {
      r.skip(16); // crc1
      const fscod = r.read(2);
      const frmsizecod = r.read(6);
      if (fscod === 3 || frmsizecod > 37) return null;
      const bsid = r.read(5);
      r.skip(3); // bsmod
      const acmod = r.read(3);
      if (acmod === 2) r.skip(2); // dsurmod
      else {
        if (acmod & 1 && acmod !== 1) r.skip(2); // cmixlev
        if (acmod & 4) r.skip(2); // surmixlev
      }
      const lfeon = r.read(1);
      for (let i = acmod === 0 ? 2 : 1; i > 0; i--) {
        r.skip(5); // dialnorm
        if (r.read(1)) r.skip(8); // compr
        if (r.read(1)) r.skip(8); // langcod
        if (r.read(1)) r.skip(7); // mixlevel, roomtyp
      }
      r.skip(2); // copyrightb, origbs
      if (bsid === 6) {
        if (r.read(1)) r.skip(14); // xbsi1 : dmixmod, ltrt/loro niveaux
        if (r.read(1)) r.skip(14); // xbsi2 : dsurexmod, dheadphonmod, adconvtyp, xbsi2, encinfo
      } else {
        if (r.read(1)) r.skip(14); // timecod1
        if (r.read(1)) r.skip(14); // timecod2
      }
      if (r.read(1)) r.skip(8 * (r.read(6) + 1)); // addbsi
      const shift = Math.max(bsid, 8) - 8;
      return {
        kind: "ac3",
        bsid,
        frameSize: AC3_FRAME_WORDS[frmsizecod][fscod] * 2,
        fscod,
        sampleRate: AC3_RATES[fscod] >> shift,
        acmod,
        lfeon,
        blocks: 6,
        strmtyp: 2,
        substreamid: 0,
        joc: false,
        bsiEnd: r.pos,
      };
    }
    if (bsidAhead !== 16) return null;
    const strmtyp = r.read(2);
    if (strmtyp === 3) return null;
    const substreamid = r.read(3);
    const frameSize = (r.read(11) + 1) * 2;
    const fscod = r.read(2);
    let blocks = 6;
    let sampleRate: number;
    if (fscod === 3) {
      const fscod2 = r.read(2);
      if (fscod2 === 3) return null;
      sampleRate = AC3_RATES[fscod2] / 2;
    } else {
      blocks = [1, 2, 3, 6][r.read(2)];
      sampleRate = AC3_RATES[fscod];
    }
    const acmod = r.read(3);
    const lfeon = r.read(1);
    const bsid = r.read(5);
    const programs = acmod === 0 ? 2 : 1;
    for (let i = 0; i < programs; i++) {
      r.skip(5); // dialnorm
      if (r.read(1)) r.skip(8); // compr
    }
    if (strmtyp === 1 && r.read(1)) r.skip(16); // chanmap
    if (r.read(1)) {
      // mixmdate
      if (acmod > 2) {
        r.skip(2); // dmixmod
        if (acmod & 1) r.skip(6); // ltrtcmixlev, lorocmixlev
        if (acmod & 4) r.skip(6); // ltrtsurmixlev, lorosurmixlev
      }
      if (lfeon && r.read(1)) r.skip(5); // lfemixlevcod
      if (strmtyp === 0) {
        for (let i = 0; i < programs; i++) if (r.read(1)) r.skip(6); // pgmscl
        if (r.read(1)) r.skip(6); // extpgmscl
        const mixdef = r.read(2);
        if (mixdef === 1) r.skip(5);
        else if (mixdef === 2) r.skip(12);
        else if (mixdef === 3) r.skip((r.read(5) + 2) * 8);
        if (acmod < 2) for (let i = 0; i < programs; i++) if (r.read(1)) r.skip(14); // paninfo
        if (r.read(1)) {
          // frmmixcfginfoe
          for (let b = 0; b < blocks; b++) if (blocks === 1 || r.read(1)) r.skip(5);
        }
      }
    }
    if (r.read(1)) {
      // infomdate
      r.skip(3 + 2); // bsmod, copyrightb, origbs
      if (acmod === 2) r.skip(4); // dsurmod, dheadphonmod
      if (acmod >= 6) r.skip(2); // dsurexmod
      for (let i = 0; i < programs; i++) if (r.read(1)) r.skip(8); // mixlevel, roomtyp, adconvtyp
      if (fscod !== 3) r.skip(1); // sourcefscod
    }
    if (strmtyp === 0 && blocks !== 6) r.skip(1); // convsync
    if (strmtyp === 2 && (blocks === 6 || r.read(1))) r.skip(6); // frmsizecod d'origine
    let joc = false;
    if (r.read(1)) {
      const bytes = r.read(6) + 1;
      // Le premier octet porte, en son bit de poids faible, flag_ec3_extension_type_a : l'Atmos (JOC).
      joc = (r.read(8) & 1) === 1;
      r.skip(8 * (bytes - 1));
    }
    return { kind: "eac3", bsid, frameSize, fscod, sampleRate, acmod, lfeon, blocks, strmtyp, substreamid, joc, bsiEnd: r.pos };
  } catch {
    return null;
  }
}

/**
 * Le nombre de trames *indépendantes* (de 256 × blocs échantillons chacune) dans un échantillon : un bloc
 * Matroska peut porter plusieurs trames AC-3 à la suite sans laçage, et une trame E-AC-3 est suivie de ses
 * dépendantes, qui ne durent rien de plus. Null si l'échantillon ne se lit pas jusqu'au bout.
 */
export function dolbyFrameCount(sample: Uint8Array): number | null {
  let count = 0;
  for (let at = 0; at < sample.length; ) {
    const head = readDolbyHeader(sample.subarray(at));
    if (!head || head.frameSize <= 0) return null;
    if (head.strmtyp !== 1) count += 1;
    at += head.frameSize;
  }
  return count;
}

/**
 * Pourquoi aucune trame de silence n'est construite pour cette piste, ou null. `block` est un bloc entier
 * de la piste (pour l'E-AC-3 : la trame indépendante et ses dépendantes à la suite, §154).
 *
 * L'Atmos (JOC) reste refusé : une trame sans charge JOC (EMDF, ETSI TS 103 420) au milieu d'un flux qui en
 * porte, avec un `addbsi` recopié qui l'annonce, est ce qu'un décodeur Atmos d'Apple recevrait — et rien ici
 * ne permet de le vérifier (FFmpeg ignore le JOC ; son silence ne prouve rien pour un décodeur qui ne
 * l'ignore pas). Retirer l'annonce changerait la nature du flux en son milieu. Les deux restent à éprouver
 * sur un appareil avant d'être servis.
 */
export function dolbySilenceRefusal(block: Uint8Array): string | null {
  const head = readDolbyHeader(block);
  if (!head) return "trame illisible";
  if (head.kind === "ac3") return head.bsid > 8 ? `AC-3 bsid ${head.bsid}` : null;
  if (head.frameSize < block.length) return "E-AC-3 à sous-flux dépendant";
  if (head.joc) return "E-AC-3 Atmos (JOC)";
  if (head.strmtyp !== 0 || head.substreamid !== 0) return `E-AC-3 strmtyp ${head.strmtyp}`;
  if (head.blocks !== 6) return `E-AC-3 à ${head.blocks} blocs par trame`;
  if (head.fscod === 3) return "E-AC-3 à fréquence réduite";
  return null;
}

/** CRC-16 de l'AC-3 (polynôme x¹⁶ + x¹⁵ + x² + 1, 0x8005, poids fort d'abord, valeur initiale 0). */
export function ac3Crc(bytes: Uint8Array, from = 0, to = bytes.length): number {
  let crc = 0;
  for (let i = from; i < to; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/**
 * `crc1` d'une trame AC-3 : la valeur qui, écrite aux octets 2–3, annule le CRC des 5/8 premiers mots (sans
 * le mot de synchronisation). Elle est *au début* de la zone qu'elle protège : le CRC étant linéaire, on
 * résout CRC(zone avec x) = CRC(zone avec 0) ⊕ L(x) = 0, L s'obtenant bit à bit (FFmpeg, `ac3enc.c`, fait
 * le même calcul par une puissance de polynôme).
 */
function solveCrc1(frame: Uint8Array, end: number): number {
  frame[2] = frame[3] = 0;
  const target = ac3Crc(frame, 2, end);
  const probe = new Uint8Array(end - 2);
  const columns: number[] = [];
  for (let bit = 0; bit < 16; bit++) {
    probe.fill(0);
    probe[bit >> 3] = 0x80 >> (bit & 7);
    columns.push(ac3Crc(probe));
  }
  // Élimination de Gauss sur GF(2) : 16 inconnues (les bits de crc1), 16 équations (les bits du CRC).
  const rows = Array.from({ length: 16 }, (_, eq) => {
    let mask = 0;
    columns.forEach((col, bit) => {
      if ((col >> (15 - eq)) & 1) mask |= 1 << bit;
    });
    return { mask, value: (target >> (15 - eq)) & 1 };
  });
  for (let bit = 0, row = 0; bit < 16; bit++) {
    const pivot = rows.findIndex((r, i) => i >= row && (r.mask >> bit) & 1);
    if (pivot < 0) throw new Error("crc1 sans solution");
    [rows[row], rows[pivot]] = [rows[pivot], rows[row]];
    rows.forEach((r, i) => {
      if (i !== row && (r.mask >> bit) & 1) {
        r.mask ^= rows[row].mask;
        r.value ^= rows[row].value;
      }
    });
    row++;
  }
  let x = 0;
  rows.forEach((r) => {
    const bit = 31 - Math.clz32(r.mask);
    if (r.value) x |= 1 << bit;
  });
  // Le bit i des colonnes est le i-ième bit de la zone en partant du poids fort de l'octet 2.
  let crc1 = 0;
  for (let bit = 0; bit < 16; bit++) if ((x >> bit) & 1) crc1 |= 0x8000 >> bit;
  return crc1;
}

/** Les exposants d'un canal pleine bande au bloc 0 : `chbwcod` 0 (73 coefficients), tous à 15, gain 0. */
function writeExponents(w: BitWriter, withGain: boolean, groups: number): void {
  w.write(15, 4); // exposant absolu
  for (let g = 0; g < groups; g++) w.write(25 * 2 + 5 * 2 + 2, 7); // trois écarts nuls
  if (withGain) w.write(0, 2); // gainrng
}

/** Groupes d'exposants pour 73 coefficients (`chbwcod` 0), selon la stratégie (FFmpeg : (fin + taille − 4) / taille). */
function exponentGroups(strategy: 1 | 3): number {
  const size = 3 << (strategy - 1);
  return Math.floor((73 + size - 4) / size);
}

/**
 * La trame de silence d'une piste dont `frame` est une vraie trame (son premier bloc suffit), ou null si
 * `dolbySilenceRefusal` refuse. Mêmes octets à chaque appel : une fonction de la trame seule.
 */
export function silentDolbyFrame(frame: Uint8Array): Uint8Array | null {
  if (dolbySilenceRefusal(frame) !== null) return null;
  const head = readDolbyHeader(frame);
  if (!head) return null;
  const fbw = FBW_CHANNELS[head.acmod];
  const programs = head.acmod === 0 ? 2 : 1;
  const w = new BitWriter();
  w.copy(frame, 0, head.bsiEnd); // syncinfo + bsi, bit pour bit

  if (head.kind === "ac3") {
    const strategy = 3; // D45 : le moins de bits, et rien ne contraint la stratégie en AC-3
    for (let blk = 0; blk < 6; blk++) {
      const first = blk === 0;
      w.write(0, fbw); // blksw
      w.write(0, fbw); // dithflag : jamais de bruit sur les coefficients nuls
      for (let p = 0; p < programs; p++) w.write(0, 1); // dynrnge
      w.write(first ? 1 : 0, 1); // cplstre
      if (first) w.write(0, 1); // cplinu
      if (head.acmod === 2) {
        w.write(first ? 1 : 0, 1); // rematstr
        if (first) w.write(0, 4); // rematflg, quatre bandes sans couplage
      }
      for (let ch = 0; ch < fbw; ch++) w.write(first ? strategy : 0, 2); // chexpstr
      if (head.lfeon) w.write(first ? 1 : 0, 1); // lfeexpstr
      if (first) {
        for (let ch = 0; ch < fbw; ch++) w.write(0, 6); // chbwcod
        for (let ch = 0; ch < fbw; ch++) writeExponents(w, true, exponentGroups(strategy));
        if (head.lfeon) writeExponents(w, false, 2);
      }
      w.write(first ? 1 : 0, 1); // baie
      if (first) w.write(2, 2).write(1, 2).write(1, 2).write(3, 2).write(7, 3); // les valeurs par défaut de l'encodeur de FFmpeg
      w.write(first ? 1 : 0, 1); // snroffste
      if (first) {
        w.write(0, 6); // csnroffst
        for (let ch = 0; ch < fbw + head.lfeon; ch++) w.write(0, 4).write(4, 3); // fsnroffst = 0, fgaincod
      }
      w.write(0, 1); // deltbaie
      w.write(0, 1); // skiple
      // Aucune mantisse : toutes les allocations sont nulles (snr_offset = −960).
    }
  } else {
    // audfrm() — `ff_eac3_parse_header` à partir de « audio frame syntax flags ».
    w.write(1, 1); // expstre : stratégies d'exposants à la manière de l'AC-3
    w.write(0, 1); // ahte
    w.write(0, 2); // snroffststrat : un décalage pour toute la trame
    w.write(0, 1); // transproce
    w.write(0, 1); // blkswe
    w.write(1, 1); // dithflage : les drapeaux de tramage sont écrits (et nuls) ; à 0, tout canal serait tramé
    w.write(0, 1); // bamode : paramètres d'allocation par défaut
    w.write(0, 1); // frmfgaincode
    w.write(0, 1); // dbaflde
    w.write(0, 1); // skipflde
    w.write(0, 1); // spxattene
    if (head.acmod > 1) {
      w.write(0, 1); // bloc 0 : cplinu (cplstre implicite)
      for (let blk = 1; blk < 6; blk++) w.write(0, 1); // cplstre
    }
    for (let blk = 0; blk < 6; blk++) for (let ch = 0; ch < fbw; ch++) w.write(blk === 0 ? 1 : 0, 2); // chexpstr : D15 puis réutilisation
    if (head.lfeon) for (let blk = 0; blk < 6; blk++) w.write(blk === 0 ? 1 : 0, 1); // lfeexpstr
    for (let ch = 0; ch < fbw; ch++) w.write(0, 5); // convexpstr : l'entrée 0 de la table E.12, {D15, R, R, R, R, R}
    w.write(0, 6).write(0, 4); // frmcsnroffst, frmfsnroffst : snr_offset = −960
    w.write(0, 1); // blkstrtinfoe

    for (let blk = 0; blk < 6; blk++) {
      const first = blk === 0;
      w.write(0, fbw); // dithflag
      for (let p = 0; p < programs; p++) w.write(0, 1); // dynrnge
      w.write(0, 1); // bloc 0 : spxinu ; ensuite spxstre
      if (head.acmod === 2) {
        if (first) w.write(0, 4); // rematflg (rematstr implicite au bloc 0)
        else w.write(0, 1); // rematstr
      }
      if (first) {
        for (let ch = 0; ch < fbw; ch++) w.write(0, 6); // chbwcod
        for (let ch = 0; ch < fbw; ch++) writeExponents(w, true, exponentGroups(1));
        if (head.lfeon) writeExponents(w, false, 2);
      }
      w.write(0, 1); // convsnroffste (flux indépendant)
    }
  }

  // Bourrage, puis auxdatae, crcrsv/encinfo et crc2 dans les 18 derniers bits.
  if (w.length > head.frameSize * 8 - 18) return null;
  const out = w.bytes(head.frameSize);
  if (head.kind === "ac3") {
    const fiveEighths = ((head.frameSize >> 2) + (head.frameSize >> 4)) << 1;
    const crc1 = solveCrc1(out, fiveEighths);
    out[2] = crc1 >> 8;
    out[3] = crc1 & 0xff;
  }
  // crc2 annule le CRC de la fin de la trame (AC-3 : depuis les 5/8 ; E-AC-3 : tout après la synchro). Comme
  // FFmpeg, on évite qu'il imite le mot de synchronisation en basculant le bit qui le précède.
  const from = head.kind === "ac3" ? ((head.frameSize >> 2) + (head.frameSize >> 4)) << 1 : 2;
  const seal = () => {
    const crc2 = ac3Crc(out, from, head.frameSize - 2);
    out[head.frameSize - 2] = crc2 >> 8;
    out[head.frameSize - 1] = crc2 & 0xff;
    return crc2;
  };
  if (seal() === 0x0b77) {
    out[head.frameSize - 3] ^= 0x01;
    seal();
  }
  return out;
}
