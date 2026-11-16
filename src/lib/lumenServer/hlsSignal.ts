// Ce que la liste maître HLS de Lumen serveur dit de chaque piste : `CODECS`, `SUPPLEMENTAL-CODECS`,
// `VIDEO-RANGE` et, pour le son, `CHANNELS`.
//
// Une règle tient tout ce fichier : **la liste dit ce que l'init segment contient**, ni plus ni
// moins. Chaque valeur est donc lue dans ce que le remuxeur écrit — l'enregistrement `hvcC`/`avcC`,
// la boîte Dolby Vision, le `dec3` complet — et jamais dans un nom de codec de Jellyfin. Une liste
// qui contredit son init segment n'échoue pas proprement chez Apple : le lecteur choisit une
// variante sur la foi de la liste, puis le décodeur refuse ce qu'il reçoit.
//
// Sources : Apple, « HLS Authoring Specification for Apple Devices » (règles 1.10, 2.5, 2.8, 9.16,
// et la section « Supplemental codecs ») ; draft-pantos-hls-rfc8216bis (SUPPLEMENTAL-CODECS,
// VIDEO-RANGE, CHANNELS) ; ETSI TS 102 366 V1.4.1 Annexe F et TS 103 420 §8.3 pour le `dec3` ;
// Dolby, « Signaling Dolby Digital Plus bitstreams with Dolby Atmos content in an ISO base media
// format file ». Conception : docs/remux-serveur/1-remuxeur.md §1.3 et 4-son-compat.md §4.1.
//
// Code pur, sans dépendance à Node : il tourne au serveur, mais rien n'empêche un test ou un banc
// de l'appeler tel quel.

import type { MatroskaTrack } from "../webcodecs/matroska";
import { avcCodecString, av1CodecString, dolbyVisionInfo, hevcCodecString, unescapeRbsp } from "../webcodecs/codecConfig";
import { ac3Channels, describeEac3, hlsDolbyVisionEntry, isOpusHead, parseAacConfig } from "../webcodecs/mp4SampleEntries";

// ── Vidéo ────────────────────────────────────────────────────────────────────

/** Les trois valeurs de `VIDEO-RANGE` (rfc8216bis §4.4.6.2). */
export type VideoRange = "SDR" | "PQ" | "HLG";

export interface HlsVideoSignal {
  /** `CODECS` pour la vidéo : la chaîne de l'entrée d'échantillon écrite. */
  codecs: string;
  /** `SUPPLEMENTAL-CODECS` (Dolby Vision 8.x sur base compatible), ou null. */
  supplementalCodecs: string | null;
  videoRange: VideoRange;
  /**
   * D'où vient `videoRange` : l'enregistrement Dolby Vision, l'élément `Colour` du Matroska, le VUI
   * du SPS, ou rien (`défaut` : SDR, la valeur que HLS suppose en l'absence de l'attribut). Gardé
   * pour qu'un écart entre deux lectures du même fichier puisse se voir au journal plus tard.
   */
  rangeSource: "dolby-vision" | "matroska" | "sps" | "défaut";
  /** L'entrée d'échantillon que `videoSampleEntry(…, { signalling: "hls" })` écrit pour cette piste. */
  entry: "hvc1" | "hvc1+dv" | "dvh1" | "avc1" | "av01";
}

/** `transfer_characteristics` (ISO/IEC 23091-2) : 16 est le PQ (SMPTE ST 2084), 18 le HLG. */
function rangeOfTransfer(transfer: number | null | undefined): VideoRange | null {
  if (transfer === 16) return "PQ";
  if (transfer === 18) return "HLG";
  // 2 veut dire « non précisé », 0 et 3 sont réservés : pas une réponse.
  if (transfer === undefined || transfer === null || transfer === 0 || transfer === 2 || transfer === 3) return null;
  return "SDR";
}

/** La marque de compatibilité d'une base Dolby Vision 8.x (Apple, « Supplemental codecs »). */
const DV_BRAND: Record<number, { brand: string; range: VideoRange }> = {
  1: { brand: "db1p", range: "PQ" }, // base HDR10
  2: { brand: "db2g", range: "SDR" }, // base SDR (BT.1886)
  4: { brand: "db4h", range: "HLG" }, // base HLG
};

/**
 * La signalisation d'une piste vidéo pour la liste maître.
 *
 * @param configuration L'enregistrement réellement écrit dans l'entrée, s'il diffère du
 *   `CodecPrivate` — un `hvcC` complété par les jeux de paramètres du flux
 *   (`hevcRecordWithParameterSets`) : c'est lui qu'on lit, VUI compris.
 * @returns null pour un codec que le remuxeur ne sait pas porter, ou un enregistrement illisible.
 */
export function hlsVideoSignal(track: MatroskaTrack, configuration?: Uint8Array): HlsVideoSignal | null {
  const record = configuration ?? track.codecPrivate;
  if (!record) return null;
  const fromColour = rangeOfTransfer(track.video?.colour?.transferCharacteristics);

  if (track.codecId === "V_MPEGH/ISO/HEVC") {
    const base = hevcCodecString(record);
    if (!base) return null;
    const range = (): Pick<HlsVideoSignal, "videoRange" | "rangeSource"> => {
      if (fromColour) return { videoRange: fromColour, rangeSource: "matroska" };
      // L'Exorciste et Retour vers le futur II n'ont aucun élément Colour : seul le SPS le dit.
      const fromSps = rangeOfTransfer(hevcTransferCharacteristics(record));
      return fromSps ? { videoRange: fromSps, rangeSource: "sps" } : { videoRange: "SDR", rangeSource: "défaut" };
    };
    const dv = track.dolbyVision;
    const info = dv ? dolbyVisionInfo(dv.record) : null;
    const entry = dv ? hlsDolbyVisionEntry(dv.record) : "hvc1";
    if (dv && info && entry === "dvh1") {
      // Profil 5 : pas de base lisible sans Dolby Vision, donc pas de « supplémentaire » — le DV est
      // le codec. Toujours PQ (IPT-PQ) : son VUI dit souvent « non précisé ».
      return { codecs: info.codec, supplementalCodecs: null, videoRange: "PQ", rangeSource: "dolby-vision", entry: "dvh1" };
    }
    if (dv && info && entry === "hvc1+dv") {
      const brand = DV_BRAND[info.compatibilityId];
      return {
        codecs: base,
        supplementalCodecs: `${info.codec}/${brand.brand}`,
        // La base décide de ce qu'un appareil sans Dolby Vision affiche : c'est elle que décrit
        // VIDEO-RANGE (Apple : `dvh1.08.xx/db1p` va avec `VIDEO-RANGE=PQ`).
        videoRange: brand.range,
        rangeSource: "dolby-vision",
        entry: "hvc1+dv",
      };
    }
    return { codecs: base, supplementalCodecs: null, ...range(), entry: "hvc1" };
  }

  if (track.codecId === "V_MPEG4/ISO/AVC") {
    const codecs = avcCodecString(record);
    if (!codecs) return null;
    if (fromColour) return { codecs, supplementalCodecs: null, videoRange: fromColour, rangeSource: "matroska", entry: "avc1" };
    const fromSps = rangeOfTransfer(avcTransferCharacteristics(record));
    return fromSps
      ? { codecs, supplementalCodecs: null, videoRange: fromSps, rangeSource: "sps", entry: "avc1" }
      : { codecs, supplementalCodecs: null, videoRange: "SDR", rangeSource: "défaut", entry: "avc1" };
  }

  if (track.codecId === "V_AV1") {
    // Aucun AV1 dans la bibliothèque (recensement du 16/11/2026) : la couleur n'est lue que dans le
    // Matroska. Le profil 10 de Dolby Vision (`dav1`) n'est pas écrit par `videoSampleEntry`, donc
    // pas annoncé non plus.
    const codecs = av1CodecString(record);
    if (!codecs) return null;
    return { codecs, supplementalCodecs: null, videoRange: fromColour ?? "SDR", rangeSource: fromColour ? "matroska" : "défaut", entry: "av01" };
  }
  return null;
}

// ── VUI du SPS ───────────────────────────────────────────────────────────────

/** Lecteur de bits avec Exp-Golomb, sur un RBSP déjà débarrassé de ses octets d'échappement. */
class RbspReader {
  private bit = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get exhausted(): boolean {
    return this.bit > this.bytes.length * 8;
  }
  u(count: number): number {
    let value = 0;
    for (let i = 0; i < count; i++, this.bit++) {
      const byte = this.bytes[this.bit >> 3] ?? 0;
      value = value * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
    }
    return value;
  }
  skip(count: number): void {
    this.bit += count;
  }
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      // Plus de 31 zéros : pas un SPS, ou un SPS lu au mauvais endroit.
      if (++zeros > 31 || this.exhausted) throw new Error("Exp-Golomb illisible");
    }
    return zeros === 0 ? 0 : 2 ** zeros - 1 + this.u(zeros);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

/** Les unités d'un type donné dans les tableaux d'un `hvcC` (ISO/IEC 14496-15 §8.3.3). */
function hvcCUnits(hvcC: Uint8Array, wanted: number): Uint8Array[] {
  const units: Uint8Array[] = [];
  if (hvcC.length < 23) return units;
  let at = 23;
  for (let a = 0; a < hvcC[22] && at + 3 <= hvcC.length; a++) {
    const type = hvcC[at] & 0x3f;
    const count = (hvcC[at + 1] << 8) | hvcC[at + 2];
    at += 3;
    for (let n = 0; n < count && at + 2 <= hvcC.length; n++) {
      const length = (hvcC[at] << 8) | hvcC[at + 1];
      if (type === wanted && at + 2 + length <= hvcC.length) units.push(hvcC.subarray(at + 2, at + 2 + length));
      at += 2 + length;
    }
  }
  return units;
}

/** profile_tier_level(1, maxSubLayersMinus1) — H.265 §7.3.3 : seulement sauté. */
function skipProfileTierLevel(r: RbspReader, maxSubLayersMinus1: number): void {
  r.skip(96); // général : espace, tier, profil, 32 drapeaux, 48 bits de contraintes, niveau
  const profilePresent: boolean[] = [];
  const levelPresent: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(r.u(1) === 1);
    levelPresent.push(r.u(1) === 1);
  }
  if (maxSubLayersMinus1 > 0) for (let i = maxSubLayersMinus1; i < 8; i++) r.skip(2);
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) r.skip(88);
    if (levelPresent[i]) r.skip(8);
  }
}

/** scaling_list_data() — H.265 §7.3.4. */
function skipHevcScalingListData(r: RbspReader): void {
  for (let sizeId = 0; sizeId < 4; sizeId++) {
    for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
      if (r.u(1) === 0) {
        r.ue(); // scaling_list_pred_matrix_id_delta
      } else {
        const coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
        if (sizeId > 1) r.se(); // scaling_list_dc_coef_minus8
        for (let i = 0; i < coefNum; i++) r.se();
      }
    }
  }
}

/**
 * Le `transfer_characteristics` du VUI du premier SPS d'un `hvcC`, ou null quand le SPS ne le
 * porte pas (ou ne se lit pas).
 *
 * Il faut traverser tout le SPS jusqu'au VUI (H.265 §7.3.2.2.1) : les ensembles de références à
 * court terme et les listes de quantification ont des longueurs variables. Rien au-delà de la
 * description de couleur n'est lu. Une exception est rendue en null : ce lecteur sert à *ajouter*
 * une information au Matroska, jamais à faire échouer une liste.
 */
export function hevcTransferCharacteristics(hvcC: Uint8Array): number | null {
  const sps = hvcCUnits(hvcC, 33)[0];
  if (!sps || sps.length < 3) return null;
  try {
    const r = new RbspReader(unescapeRbsp(sps.subarray(2))); // en-tête NAL de deux octets
    r.skip(4); // sps_video_parameter_set_id
    const maxSubLayersMinus1 = r.u(3);
    r.skip(1); // sps_temporal_id_nesting_flag
    skipProfileTierLevel(r, maxSubLayersMinus1);
    r.ue(); // sps_seq_parameter_set_id
    const chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) r.skip(1); // separate_colour_plane_flag
    r.ue(); // pic_width_in_luma_samples
    r.ue(); // pic_height_in_luma_samples
    if (r.u(1)) for (let i = 0; i < 4; i++) r.ue(); // conformance_window
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    const log2MaxPocLsb = r.ue() + 4;
    const subLayerOrderingInfo = r.u(1);
    for (let i = subLayerOrderingInfo ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
      r.ue(); // sps_max_dec_pic_buffering_minus1
      r.ue(); // sps_max_num_reorder_pics
      r.ue(); // sps_max_latency_increase_plus1
    }
    for (let i = 0; i < 6; i++) r.ue(); // tailles de blocs et profondeurs de transformée
    if (r.u(1) && r.u(1)) skipHevcScalingListData(r); // scaling_list_enabled, sps_scaling_list_data_present
    r.skip(2); // amp_enabled_flag, sample_adaptive_offset_enabled_flag
    if (r.u(1)) {
      // pcm_enabled_flag
      r.skip(8); // pcm_sample_bit_depth_luma_minus1, chroma_minus1
      r.ue();
      r.ue();
      r.skip(1); // pcm_loop_filter_disabled_flag
    }
    const numShortTermRefPicSets = r.ue();
    if (numShortTermRefPicSets > 64) return null;
    // st_ref_pic_set(i) — §7.3.7. NumDeltaPocs de chaque ensemble, pour la prédiction du suivant.
    const numDeltaPocs: number[] = [];
    for (let i = 0; i < numShortTermRefPicSets; i++) {
      const interPrediction = i !== 0 ? r.u(1) : 0;
      if (interPrediction) {
        // Dans le SPS, delta_idx_minus1 n'existe pas : la référence est l'ensemble précédent.
        r.skip(1); // delta_rps_sign
        r.ue(); // abs_delta_rps_minus1
        let count = 0;
        for (let j = 0; j <= numDeltaPocs[i - 1]; j++) {
          const used = r.u(1);
          const useDelta = used ? 1 : r.u(1);
          if (used || useDelta) count++;
        }
        numDeltaPocs.push(count);
      } else {
        const negative = r.ue();
        const positive = r.ue();
        if (negative + positive > 32) return null;
        for (let j = 0; j < negative + positive; j++) {
          r.ue(); // delta_poc_sX_minus1
          r.skip(1); // used_by_curr_pic_sX_flag
        }
        numDeltaPocs.push(negative + positive);
      }
    }
    if (r.u(1)) {
      // long_term_ref_pics_present_flag
      const count = r.ue();
      if (count > 32) return null;
      for (let i = 0; i < count; i++) r.skip(log2MaxPocLsb + 1);
    }
    r.skip(2); // sps_temporal_mvp_enabled_flag, strong_intra_smoothing_enabled_flag
    if (!r.u(1)) return null; // vui_parameters_present_flag
    return readVuiTransfer(r);
  } catch {
    return null;
  }
}

/** Le début du VUI, commun à H.264 (E.1.1) et H.265 (E.2.1), jusqu'à la description de couleur. */
function readVuiTransfer(r: RbspReader): number | null {
  if (r.u(1)) {
    // aspect_ratio_info_present_flag
    if (r.u(8) === 255) r.skip(32); // Extended_SAR : sar_width, sar_height
  }
  if (r.u(1)) r.skip(1); // overscan_info_present_flag → overscan_appropriate_flag
  if (!r.u(1)) return null; // video_signal_type_present_flag
  r.skip(4); // video_format, video_full_range_flag
  if (!r.u(1)) return null; // colour_description_present_flag
  r.skip(8); // colour_primaries
  const transfer = r.u(8);
  return r.exhausted ? null : transfer;
}

/** Les profils H.264 dont le SPS porte chroma_format_idc et la suite (H.264 §7.3.2.1.1). */
const AVC_HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/** Le `transfer_characteristics` du VUI du premier SPS d'un `avcC`, ou null. */
export function avcTransferCharacteristics(avcC: Uint8Array): number | null {
  if (avcC.length < 8 || (avcC[5] & 0x1f) === 0) return null;
  const length = (avcC[6] << 8) | avcC[7];
  if (8 + length > avcC.length || length < 4) return null;
  try {
    const r = new RbspReader(unescapeRbsp(avcC.subarray(9, 8 + length))); // après l'en-tête NAL d'un octet
    const profileIdc = r.u(8);
    r.skip(16); // contraintes, level_idc
    r.ue(); // seq_parameter_set_id
    if (AVC_HIGH_PROFILES.has(profileIdc)) {
      const chromaFormatIdc = r.ue();
      if (chromaFormatIdc === 3) r.skip(1);
      r.ue(); // bit_depth_luma_minus8
      r.ue(); // bit_depth_chroma_minus8
      r.skip(1); // qpprime_y_zero_transform_bypass_flag
      if (r.u(1)) {
        // seq_scaling_matrix_present_flag
        for (let i = 0; i < (chromaFormatIdc !== 3 ? 8 : 12); i++) {
          if (!r.u(1)) continue;
          const size = i < 6 ? 16 : 64;
          let last = 8;
          let next = 8;
          for (let j = 0; j < size; j++) {
            if (next !== 0) next = (last + r.se() + 256) % 256;
            last = next === 0 ? last : next;
          }
        }
      }
    }
    r.ue(); // log2_max_frame_num_minus4
    const pocType = r.ue();
    if (pocType === 0) r.ue();
    else if (pocType === 1) {
      r.skip(1);
      r.se();
      r.se();
      const cycle = r.ue();
      if (cycle > 255) return null;
      for (let i = 0; i < cycle; i++) r.se();
    }
    r.ue(); // max_num_ref_frames
    r.skip(1); // gaps_in_frame_num_value_allowed_flag
    r.ue(); // pic_width_in_mbs_minus1
    r.ue(); // pic_height_in_map_units_minus1
    if (!r.u(1)) r.skip(1); // frame_mbs_only_flag → mb_adaptive_frame_field_flag
    r.skip(1); // direct_8x8_inference_flag
    if (r.u(1)) for (let i = 0; i < 4; i++) r.ue(); // frame_cropping
    if (!r.u(1)) return null; // vui_parameters_present_flag
    return readVuiTransfer(r);
  } catch {
    return null;
  }
}

// ── Son ──────────────────────────────────────────────────────────────────────

export interface HlsAudioSignal {
  /** `CODECS` pour ce rendu : `ec-3`, `ac-3`, `mp4a.40.x`, `fLaC`, `Opus`. */
  codecs: string;
  /**
   * `CHANNELS` : le nombre de canaux indépendants, ou `"N/JOC"` pour un Atmos, N étant le
   * `complexity_index_type_a` écrit dans le `dec3` (Apple, règle 2.8 : « JOC » en capitales, et ce
   * nombre égal à celui de la boîte).
   */
  channels: string;
}

/**
 * La signalisation d'une piste audio copiée telle quelle, ou null pour un codec que HLS ne porte
 * pas (DTS, TrueHD, MP2, PCM — à convertir, phase 2 de la conception).
 *
 * @param firstFrame Le premier bloc de la piste — celui-là même que le remuxeur lit pour écrire
 *   `dac3`/`dec3` : les deux doivent lire les mêmes octets pour dire la même chose.
 * @param configuration La configuration AAC réellement écrite (`copiedAsc` réécrit un PCE
 *   équivalent à une configuration standard), si elle diffère du `CodecPrivate`.
 */
export function hlsAudioSignal(track: MatroskaTrack, firstFrame: Uint8Array | null, configuration?: Uint8Array | null): HlsAudioSignal | null {
  const declared = track.audio?.channels ?? 2;
  switch (track.codecId) {
    case "A_EAC3": {
      if (!firstFrame) return null;
      const description = describeEac3(firstFrame);
      return {
        codecs: "ec-3",
        channels: description.joc ? `${description.joc.complexityIndex}/JOC` : String(description.channels),
      };
    }
    case "A_AC3":
      if (!firstFrame) return null;
      return { codecs: "ac-3", channels: String(ac3Channels(firstFrame)) };
    case "A_AAC": {
      const asc = configuration ?? track.codecPrivate;
      const parsed = asc ? parseAacConfig(asc) : null;
      if (!parsed) return null;
      // Un PCE (configuration 0) ne dit pas son nombre de canaux dans l'ASC : celui du conteneur.
      return { codecs: `mp4a.40.${parsed.objectType}`, channels: String(parsed.channels || declared) };
    }
    case "A_FLAC":
      return { codecs: "fLaC", channels: String(declared) };
    case "A_OPUS":
      // Non documenté par Apple (4-son-compat.md §4.1) : décrit pour être complet, à convertir en
      // pratique tant qu'un appareil ne l'a pas prouvé.
      if (!isOpusHead(track.codecPrivate)) return null;
      return { codecs: "Opus", channels: String(track.codecPrivate[9]) };
    default:
      return null;
  }
}

/**
 * Le `CODECS` d'une variante : la vidéo, puis chaque format audio des rendus du groupe qu'elle
 * référence, sans doublon (rfc8216bis §4.4.6.1.1 : « every media format in any of the renditions »).
 */
export function variantCodecs(video: HlsVideoSignal, audio: readonly HlsAudioSignal[]): string {
  const seen = new Set<string>([video.codecs]);
  for (const rendition of audio) seen.add(rendition.codecs);
  return [...seen].join(",");
}
