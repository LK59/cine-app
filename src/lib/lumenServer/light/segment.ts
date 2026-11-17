// Un segment de la version allégée : les images d'un segment de la vidéo d'origine, réencodées par le iGPU, remises
// dans le fMP4 de Lumen serveur aux instants exacts de l'origine.
//
// Les instants ne viennent pas de l'encodeur (son flux Annex B n'en porte pas) mais du segment d'origine lui-même
// (`originTimes`) : mêmes images, même ordre de présentation, et — sans image B — l'ordre de décodage est celui-là.
// Chaque image `i` reçoit l'instant de présentation de l'image `i` d'origine ; le décodage la précède du délai D, comme
// à l'origine (`compositionOffset` = D, ajouté par le segment d'origine à toutes ses images). Le segment commence au
// `tfdt` du segment d'origine et finit là où il finit : celui d'après, allégé ou non, reprend exactement là (la règle
// 7.3 d'Apple, et ce qui permet à Safari de passer d'une variante à l'autre à une frontière).
// Une image que l'encodeur n'a pas rendue (un décodage qui échoue sur une image abîmée), une première image qui n'est
// pas celle de l'origine, ou une première image qui n'est pas une IDR : une erreur, jamais des octets décalés.

import { initSegment, mediaSegment, type MuxSample, type MuxTrackInfo } from "../../webcodecs/mp4Muxer";
import { videoSampleEntry } from "../../webcodecs/mp4SampleEntries";
import { joinBytes } from "../../webcodecs/codecConfig";
import { fragmentRanges } from "../plan";
import { LUMEN_TIMESCALE, LumenError, SEQUENCE_STRIDE, VIDEO_TRACK_ID, type LumenIndex, type LumenLightRung } from "../format";
import { annexBUnits, hevcPictures, hvcCFromParameterSets, isIdrPicture, lengthPrefixed, parameterSetsOf, type OriginTimes } from "./bitstream";

/** Le segment allégé `n` depuis le flux de l'encodeur et les instants du segment d'origine. */
export function lightSegment(encoded: Uint8Array, origin: OriginTimes, n: number, delayUs: number): { bytes: Uint8Array; samples: number } {
  const pictures = hevcPictures(annexBUnits(encoded));
  const expected = origin.presentations.length;
  if (pictures.length !== expected) throw new LumenError("segment-vide", `Segment allégé ${n} : ${pictures.length} images encodées pour ${expected}.`);
  if (!isIdrPicture(pictures[0])) throw new LumenError("segment-vide", `Segment allégé ${n} : la première image n'est pas une IDR.`);
  const decodes = origin.presentations.map((p) => p - delayUs);
  const samples: MuxSample[] = pictures.map((units, i) => {
    const decode = decodes[i];
    const next = i + 1 < decodes.length ? decodes[i + 1] : origin.endDecode;
    return { data: lengthPrefixed(units), decodeTime: decode, duration: Math.max(1, next - decode), compositionOffset: delayUs, isKeyframe: i === 0 };
  });
  if (samples[0].decodeTime !== origin.startDecode) {
    // L'origine ancre son premier groupe sur sa plus petite présentation : le décodage allégé part du même instant.
    throw new LumenError("segment-vide", `Segment allégé ${n} : départ ${samples[0].decodeTime} µs, l'origine ${origin.startDecode} µs.`);
  }
  const info: MuxTrackInfo = { id: VIDEO_TRACK_ID, kind: "video", timescale: LUMEN_TIMESCALE, sampleEntry: new Uint8Array(0), width: 0, height: 0, language: "und" };
  const parts: Uint8Array[] = [];
  const ranges = fragmentRanges(samples.length, (i) => samples[i].data.byteLength);
  ranges.forEach(([from, to], k) => {
    if (k >= SEQUENCE_STRIDE - 1) throw new LumenError("segment-vide", `Segment allégé ${n} : trop de fragments.`);
    const following = to < samples.length ? samples[to].decodeTime : origin.endDecode;
    parts.push(mediaSegment(info, n * SEQUENCE_STRIDE + k + 1, samples.slice(from, to), following));
  });
  return { bytes: joinBytes(parts), samples: samples.length };
}

/**
 * L'init d'un échelon : une entrée `hvc1` dont le `hvcC` vient des jeux de paramètres que l'encodeur écrit à cette
 * taille et ce profil (une image encodée suffit), la taille de l'échelon, et la couleur de la source (`colr`, `mdcv`,
 * `clli` : un PQ reste un PQ). Jamais de Dolby Vision : le RPU ne survit pas au réencodage.
 */
export function lightInit(encodedFirstPicture: Uint8Array, rung: Pick<LumenLightRung, "width" | "height">, index: Pick<LumenIndex, "video" | "durationUs">): Uint8Array {
  const pictures = hevcPictures(annexBUnits(encodedFirstPicture));
  const sets = pictures.length > 0 ? parameterSetsOf(pictures[0]) : null;
  if (!sets) throw new LumenError("segment-vide", "Init allégée : pas de VPS, SPS ou PPS dans l'image encodée.");
  const hvcC = hvcCFromParameterSets(sets.vps, sets.sps, sets.pps);
  return initSegment(
    {
      id: VIDEO_TRACK_ID,
      kind: "video",
      timescale: LUMEN_TIMESCALE,
      sampleEntry: videoSampleEntry("V_MPEGH/ISO/HEVC", hvcC, rung.width, rung.height, null, index.video?.colour, { signalling: "hls" }),
      width: rung.width,
      height: rung.height,
      language: "und",
    },
    index.durationUs / 1e6
  );
}
