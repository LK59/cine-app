// Un segment HLS, produit seul : (fichier, piste, segment N, plan) → octets fMP4 (moof+mdat…).
//
// **Sans état.** Rien ne passe d'un segment à l'autre : ni curseur, ni compteur, ni délai mesuré en
// route. Ce qui rend deux segments produits séparément — par deux fils, deux processus, avant et après
// un déploiement — exactement contigus :
// - les frontières viennent de la découpe (`plan.ts`), fixée par l'index ;
// - le délai de présentation D vient de l'index, le même pour tout le fichier et toutes les pistes ;
// - chaque groupe d'images est ancré sur sa propre plus petite présentation (`buildVideo` du remuxeur) :
//   les instants de décodage sont absolus, et la fin d'un groupe tombe sur le début du suivant ;
// - le son est réancré sur l'horodatage de chaque bloc, et chaque trame appartient au segment qui
//   contient son propre instant ;
// - `mfhd` vaut `N × 1000 + rang du fragment + 1`.
//
// Les briques sont celles du remuxeur, appelées dans le même ordre que lui : `strayUnits` (blocs
// égarés rendus à leurs images), `isRandomAccessPoint` (la clé, demandée à l'image et non au
// conteneur), `deriveDurations` + `assignDecodeTimes` (ordre de décodage), `mediaSegment` (muxer).
// Deux écarts au remuxeur, voulus et propres au HLS :
// - **aucune RASL n'est écartée** : sous la découpe `idr`, un segment ne commence jamais sur une CRA qui
//   en a (`lumenIndex.ts`) et, à l'intérieur d'un segment, leurs références sont là ; sous les découpes
//   expérimentales `cra`/`cra-leading` (§157), un segment peut commencer sur une telle CRA et ses RASL y
//   restent aussi — en lecture continue, leurs références sont dans le segment d'avant, et après un saut
//   c'est au décodeur de les jeter. `cra-leading` déclare chaque image (`markLeading`, `leadingOf`) : RASL
//   `is_leading` = 1, RADL 3, toute autre non-clé 2 — de quoi jeter les RASL sans lire le flux. Le reste du
//   code est le même : un groupe CRA + RASL en tête de segment est un groupe comme ceux qu'un segment
//   `idr` contient déjà en son milieu (ancré sur sa plus petite présentation, celle de la première RASL,
//   que le segment précédent prend pour fin — `nextGroupUs`) ;
// - **la dernière image d'un groupe déclare l'écart au groupe suivant**, y compris au-delà de la fin du
//   segment (lu dans l'index ou les en-têtes des blocs suivants) : la règle 7.3 d'Apple veut que le
//   `tfdt` d'un segment prolonge exactement le précédent.

import type { ByteSource } from "../webcodecs/byteSource";
import type { MatroskaFile, MediaSample } from "../webcodecs/matroska";
import { isRandomAccessPoint, joinBytes, strayUnits } from "../webcodecs/codecConfig";
import { assignDecodeTimes, deriveDurations } from "../webcodecs/decodeOrder";
import { mediaSegment, type MuxSample, type MuxTrackInfo } from "../webcodecs/mp4Muxer";
import { readBlockSamples, walkBlocks } from "./mkvBlocks";
import { fragmentRanges } from "./plan";
import {
  AUDIO_TRACK_ID,
  FALLBACK_AUDIO_FRAME_US,
  LUMEN_TIMESCALE,
  LumenError,
  SEQUENCE_STRIDE,
  VIDEO_TRACK_ID,
  type LumenIndex,
  type LumenRendition,
  type LumenSegment,
} from "./format";

/** Combien d'images lire derrière la clé suivante pour connaître le début du groupe qu'elle ouvre. */
const NEXT_GROUP_LOOKAHEAD = 16;

/**
 * Ce qu'un fil de calcul reçoit pour produire un segment : la part de l'index qui le concerne, rien
 * d'autre — quelques centaines d'octets à recopier, pas l'index entier.
 */
export interface SegmentSpec {
  path: string;
  /** `identityKey` du fichier indexé : un fichier changé depuis ne produit rien (`fichier-change`). */
  key: string;
  n: number;
  segment: LumenSegment;
  /** Le segment suivant (sa clé ferme celui-ci), ou null pour le dernier. */
  next: LumenSegment | null;
  /** Où arrêter de lire au pire : la grappe du segment d'après le suivant (Matroska). */
  limitAt: number | null;
  delayUs: number;
  frameUs: number;
  /** Découpe `cra-leading` : chaque non-clé porte `is_leading` (RASL 1, RADL 3, sinon 2). Absent : les octets d'avant. */
  markLeading?: boolean;
  video?: { number: number; codecId: string; lengthSize: number };
  audio?: { number: number; codecId: string; sampleRate: number };
}

export interface SegmentResult {
  bytes: Uint8Array;
  facts: {
    samples: number;
    groups: number;
    fragments: number;
    /** Images dont le décalage de composition a été borné à 0 (un réordonnancement plus profond que le premier groupe). */
    clamped: number;
    firstDecodeUs: number;
    endDecodeUs: number;
  };
}

/** La part de l'index dont un segment a besoin. Lève `LumenError` pour un segment ou une piste qui n'existe pas. */
export function segmentSpec(index: LumenIndex, rendition: LumenRendition, n: number): SegmentSpec {
  const segment = index.segments[n];
  if (!segment || !Number.isInteger(n)) throw new LumenError("segment-inconnu", `Segment ${n} inexistant (${index.segments.length}).`);
  const base = {
    path: index.identity.path,
    key: `${index.identity.path}|${index.identity.size}|${index.identity.mtimeMs}|${index.identity.ino}`,
    n,
    segment,
    next: index.segments[n + 1] ?? null,
    limitAt: index.container === "matroska" ? (index.segments[n + 2]?.at ?? null) : null,
    delayUs: index.delayUs,
    frameUs: index.frameUs,
    ...(index.cut === "cra-leading" ? { markLeading: true } : {}),
  };
  if (rendition.kind === "video") {
    if (!index.video) throw new LumenError("piste-inconnue", "Pas de vidéo.");
    return { ...base, video: { number: index.video.number, codecId: index.video.codecId, lengthSize: index.video.lengthSize } };
  }
  const track = index.audio.find((a) => a.number === rendition.track);
  if (!track || track.refusal) throw new LumenError("piste-inconnue", `Piste audio ${rendition.track} non servie.`);
  return { ...base, audio: { number: track.number, codecId: track.codecId, sampleRate: track.sampleRate } };
}

/** Le segment décrit par `spec`, lu dans `source` (`file` : son en-tête, déjà ouvert). */
export async function buildSegment(source: ByteSource, file: MatroskaFile, spec: SegmentSpec): Promise<SegmentResult> {
  if (spec.video) return buildVideo(source, file, spec, spec.video);
  if (spec.audio) return buildAudio(source, file, spec, spec.audio);
  throw new LumenError("piste-inconnue", "Ni vidéo ni son demandés.");
}

// ── Vidéo ────────────────────────────────────────────────────────────────────

interface Pictures {
  /** Les images du segment, dans l'ordre de décodage, unités égarées rendues. */
  pictures: MediaSample[];
  /** La plus petite présentation du groupe qui suit le segment (là où son décodage commence), ou null. */
  nextGroupUs: number | null;
}

async function matroskaPictures(source: ByteSource, file: MatroskaFile, spec: SegmentSpec, video: NonNullable<SegmentSpec["video"]>): Promise<Pictures> {
  const pictures: MediaSample[] = [];
  let strayAhead: Uint8Array[] = [];
  let started = false;
  let after = false;
  let afterSeen = 0;
  const endKey = spec.next?.keyUs ?? null;
  let nextGroupUs: number | null = null;

  await walkBlocks(
    source,
    file,
    spec.segment.at,
    async (head) => {
      if (head.track !== video.number) return "continue";
      if (after) {
        // Derrière la clé suivante : ses images de tête (affichées avant elle) ouvrent son groupe plus
        // tôt qu'elle. Les en-têtes suffisent ; la première image affichée après elle clôt la recherche.
        if (head.timeUs > (endKey as number) || ++afterSeen > NEXT_GROUP_LOOKAHEAD) return "stop";
        nextGroupUs = Math.min(nextGroupUs ?? head.timeUs, head.timeUs);
        return "continue";
      }
      for (let sample of await readBlockSamples(source, file, head)) {
        const stray = strayUnits(sample.data, video.codecId, video.lengthSize);
        if (stray) {
          // *Dirty Dancing* : les unités suffixes ferment l'image d'avant, les autres ouvrent la suivante.
          if (started && stray.before.length > 0 && pictures.length > 0) {
            const last = pictures[pictures.length - 1];
            pictures[pictures.length - 1] = { ...last, data: joinBytes([last.data, ...stray.before]) };
          }
          strayAhead.push(...stray.after);
          continue;
        }
        if (!started) {
          // La clé vérifiée par l'index : la première image à son instant. Ce qui la précède dans la
          // grappe appartient au segment d'avant, qui l'a lu en allant chercher sa propre fin.
          if (sample.timestampUs !== spec.segment.keyUs || !sample.isKey) {
            strayAhead = [];
            continue;
          }
          started = true;
        } else if (endKey !== null && sample.timestampUs === endKey) {
          after = true;
          nextGroupUs = endKey;
          return "continue";
        }
        if (strayAhead.length > 0) {
          sample = { ...sample, data: joinBytes([...strayAhead, sample.data]) };
          strayAhead = [];
        }
        pictures.push(sample);
      }
      return "continue";
    },
    spec.limitAt ?? undefined
  );
  if (!started) throw new LumenError("cle-introuvable", `Clé de ${spec.segment.keyUs} µs introuvable à ${spec.segment.at}.`);
  if (endKey !== null && !after) throw new LumenError("cle-introuvable", `Clé de fin ${endKey} µs introuvable.`);
  return { pictures, nextGroupUs };
}

async function mp4Pictures(source: ByteSource, file: MatroskaFile, spec: SegmentSpec, video: NonNullable<SegmentSpec["video"]>): Promise<Pictures> {
  const t = file.mp4?.tracks.find((track) => track.number === video.number);
  if (!t) throw new LumenError("piste-inconnue", "Piste vidéo absente de l'index MP4.");
  const pts = (i: number) => t.dtsUs[i] + (t.ctsUs?.[i] ?? 0);
  const from = spec.segment.at;
  const to = spec.next ? spec.next.at : t.dtsUs.length;
  const pictures: MediaSample[] = [];
  let strayAhead: Uint8Array[] = [];
  for (let i = from; i < to; i++) {
    let sample: MediaSample = { trackNumber: t.number, timestampUs: pts(i), durationUs: null, isKey: t.sync ? t.sync[i] === 1 : true, data: await source.read(t.offsets[i], t.sizes[i]) };
    const stray = strayUnits(sample.data, video.codecId, video.lengthSize);
    if (stray) {
      if (stray.before.length > 0 && pictures.length > 0) {
        const last = pictures[pictures.length - 1];
        pictures[pictures.length - 1] = { ...last, data: joinBytes([last.data, ...stray.before]) };
      }
      strayAhead.push(...stray.after);
      continue;
    }
    if (strayAhead.length > 0) {
      sample = { ...sample, data: joinBytes([...strayAhead, sample.data]) };
      strayAhead = [];
    }
    pictures.push(sample);
  }
  let nextGroupUs: number | null = null;
  if (spec.next) {
    const keyPts = pts(to);
    nextGroupUs = keyPts;
    for (let j = to + 1; j < Math.min(t.dtsUs.length, to + 1 + NEXT_GROUP_LOOKAHEAD); j++) {
      if (pts(j) > keyPts) break;
      nextGroupUs = Math.min(nextGroupUs, pts(j));
    }
  }
  return { pictures, nextGroupUs };
}

async function buildVideo(source: ByteSource, file: MatroskaFile, spec: SegmentSpec, video: NonNullable<SegmentSpec["video"]>): Promise<SegmentResult> {
  const { pictures, nextGroupUs } = file.mp4 ? await mp4Pictures(source, file, spec, video) : await matroskaPictures(source, file, spec, video);
  if (pictures.length === 0) throw new LumenError("segment-vide", `Segment vidéo ${spec.n} sans image.`);

  // Les groupes : une coupe à chaque image d'où un décodeur peut partir (la règle `startsHere` du
  // remuxeur). La première du segment est la clé vérifiée par l'index.
  const groups: MediaSample[][] = [];
  pictures.forEach((picture, i) => {
    const startsHere = i === 0 || (picture.isKey && isRandomAccessPoint(picture.data, video.codecId, video.lengthSize));
    if (startsHere) groups.push([]);
    groups[groups.length - 1].push(picture);
  });

  const info: MuxTrackInfo = { id: VIDEO_TRACK_ID, kind: "video", timescale: LUMEN_TIMESCALE, sampleEntry: new Uint8Array(0), width: 0, height: 0, language: "und" };
  const parts: Uint8Array[] = [];
  let clamped = 0;
  let fragments = 0;
  let firstDecodeUs = 0;
  let endDecodeUs = 0;
  groups.forEach((group, g) => {
    const presentations = group.map((s) => s.timestampUs);
    const durations = deriveDurations(presentations, spec.frameUs);
    const anchor = Math.min(...presentations);
    const ordered = assignDecodeTimes(presentations.map((presentation, i) => ({ presentation, duration: durations[i] })), anchor);
    const samples: MuxSample[] = group.map((sample, i) => {
      const offset = ordered.samples[i].compositionOffset + spec.delayUs;
      if (offset < 0) clamped += 1;
      const muxed: MuxSample = {
        data: sample.data,
        decodeTime: ordered.samples[i].decode,
        duration: ordered.samples[i].duration,
        compositionOffset: Math.max(0, offset),
        isKeyframe: i === 0,
      };
      if (spec.markLeading && i > 0) muxed.isLeading = leadingOf(sample.data, video.codecId, video.lengthSize);
      return muxed;
    });
    if (g === 0) firstDecodeUs = samples[0].decodeTime;
    // Où le décodage du groupe suivant commence : dans ce segment, sa plus petite présentation ; après
    // le dernier groupe, celle du groupe qui ouvre le segment suivant ; au bout du film, rien (la durée
    // de la dernière image).
    const following = g + 1 < groups.length ? Math.min(...groups[g + 1].map((s) => s.timestampUs)) : (nextGroupUs ?? undefined);
    const ranges = fragmentRanges(samples.length, (i) => samples[i].data.byteLength);
    ranges.forEach(([from, to], r) => {
      const next = to < samples.length ? samples[to].decodeTime : following;
      if (fragments >= SEQUENCE_STRIDE - 1) throw new LumenError("segment-vide", `Segment ${spec.n} : plus de ${SEQUENCE_STRIDE - 1} fragments.`);
      parts.push(mediaSegment(info, spec.n * SEQUENCE_STRIDE + fragments + 1, samples.slice(from, to), next));
      fragments += 1;
      if (g === groups.length - 1 && r === ranges.length - 1) {
        const lastSample = samples[to - 1];
        endDecodeUs = next ?? lastSample.decodeTime + lastSample.duration;
      }
    });
  });
  return { bytes: joinBytes(parts), facts: { samples: pictures.length, groups: groups.length, fragments, clamped, firstDecodeUs, endDecodeUs } };
}

/**
 * `is_leading` d'une image non clé (ISO/IEC 14496-12 §8.8.3.1), lu dans le type NAL de sa tranche :
 * RASL (8, 9) → 1, image de tête qui dépend d'avant sa clé et ne se décode pas après un accès aléatoire ;
 * RADL (6, 7) → 3, image de tête décodable ; toute autre → 2, pas une image de tête. H.264 : rien dans le
 * flux ne nomme une image de tête (et la découpe n'ouvre jamais un segment sur une clé qui en a) → 2.
 * Les clés gardent leurs drapeaux d'avant (`is_leading` 0) : seules les images qu'un lecteur pourrait jeter
 * ont besoin d'être nommées, et une clé changée de forme changerait une seconde chose à la fois.
 */
export function leadingOf(data: Uint8Array, codecId: string, lengthSize: number): 1 | 2 | 3 {
  if (codecId !== "V_MPEGH/ISO/HEVC") return 2;
  for (let at = 0; at + lengthSize + 1 <= data.byteLength; ) {
    let length = 0;
    for (let i = 0; i < lengthSize; i++) length = length * 256 + data[at + i];
    if (length <= 0 || at + lengthSize + length > data.byteLength) return 2;
    const type = (data[at + lengthSize] >> 1) & 0x3f;
    // Le premier NAL sous 32 est la tranche : c'est lui qui dit ce qu'est l'image (comme `isRaslPicture`).
    if (type <= 31) return type === 8 || type === 9 ? 1 : type === 6 || type === 7 ? 3 : 2;
    at += lengthSize + length;
  }
  return 2;
}

// ── Son ──────────────────────────────────────────────────────────────────────

/** La durée d'une trame quand le codec la fixe (AAC-LC 1024, AC-3 1536 échantillons), en µs ; sinon null. */
function codecFrameUs(codecId: string, sampleRate: number): number | null {
  if (codecId === "A_AC3") return (1536 / sampleRate) * 1e6;
  // L'AAC HE porte 2048 échantillons de sortie par trame ; la mesure entre deux blocs le dira.
  // E-AC-3 : 1, 2, 3 ou 6 blocs par trame — à mesurer, jamais à supposer (1-remuxeur.md §1.2).
  return null;
}

async function buildAudio(source: ByteSource, file: MatroskaFile, spec: SegmentSpec, audio: NonNullable<SegmentSpec["audio"]>): Promise<SegmentResult> {
  // Chaque trame appartient au segment qui contient son propre instant : [début, fin). Le premier
  // segment prend aussi ce qui précède 0, le dernier tout ce qui suit sa clé.
  const lower = spec.n === 0 ? -Infinity : spec.segment.startUs;
  const upper = spec.next ? spec.segment.endUs : Infinity;
  const frames: MediaSample[] = [];
  let nextUs: number | null = null;

  if (file.mp4) {
    const t = file.mp4.tracks.find((track) => track.number === audio.number);
    if (!t) throw new LumenError("piste-inconnue", "Piste audio absente de l'index MP4.");
    const pts = (i: number) => t.dtsUs[i] + (t.ctsUs?.[i] ?? 0);
    let i = lowerBound(t.dtsUs.length, (k) => pts(k) >= lower);
    for (; i < t.dtsUs.length && pts(i) < upper; i++) {
      frames.push({ trackNumber: t.number, timestampUs: pts(i), durationUs: null, isKey: true, data: await source.read(t.offsets[i], t.sizes[i]) });
    }
    if (i < t.dtsUs.length) nextUs = pts(i);
  } else {
    // En Matroska, les grappes sont rangées par temps : le son du segment commence dans la grappe de
    // sa clé (0 trame antérieure trouvée à l'étude). Le premier segment part du début du film.
    const from = spec.n === 0 ? Math.min(file.firstClusterOffset ?? spec.segment.at, spec.segment.at) : spec.segment.at;
    await walkBlocks(
      source,
      file,
      from,
      async (head) => {
        if (head.track !== audio.number) return "continue";
        if (head.timeUs >= upper) {
          // Le premier bloc du segment suivant : il donne la durée des dernières trames de celui-ci.
          nextUs = head.timeUs;
          return "stop";
        }
        if (head.timeUs < lower) return "continue";
        frames.push(...(await readBlockSamples(source, file, head)));
        return "continue";
      },
      spec.limitAt ?? undefined
    );
  }
  if (frames.length === 0) throw new LumenError("segment-vide", `Segment audio ${spec.n} sans trame (piste ${audio.number}).`);

  const samples = audioSamples(frames, nextUs, spec.delayUs, codecFrameUs(audio.codecId, audio.sampleRate));
  const info: MuxTrackInfo = { id: AUDIO_TRACK_ID, kind: "audio", timescale: LUMEN_TIMESCALE, sampleEntry: new Uint8Array(0), width: 0, height: 0, language: "und" };
  const bytes = mediaSegment(info, spec.n * SEQUENCE_STRIDE + 1, samples);
  const last = samples[samples.length - 1];
  return {
    bytes,
    facts: { samples: samples.length, groups: 1, fragments: 1, clamped: 0, firstDecodeUs: samples[0].decodeTime, endDecodeUs: last.decodeTime + last.duration },
  };
}

/**
 * Les trames d'un segment audio, datées — la règle de `buildAudio` du remuxeur : blocs lacés regroupés
 * par horodatage, durée d'une trame = écart au bloc suivant ÷ nombre de trames, réancrée sur chaque
 * bloc, une trame recouverte à plus de moitié écartée. Une seule différence : la dernière série du
 * segment mesure son écart au premier bloc du segment suivant (`nextUs`), lu exprès, plutôt que de
 * réutiliser la durée d'avant — c'est ce qui fait finir ce segment exactement où le suivant commence.
 */
export function audioSamples(frames: MediaSample[], nextUs: number | null, delayUs: number, codecFrame: number | null): MuxSample[] {
  const runs: { timestamp: number; frames: MediaSample[] }[] = [];
  for (const frame of frames) {
    const last = runs[runs.length - 1];
    if (last && last.timestamp === frame.timestampUs) last.frames.push(frame);
    else runs.push({ timestamp: frame.timestampUs, frames: [frame] });
  }
  const samples: MuxSample[] = [];
  let measured: number | null = null;
  let endUs: number | null = null;
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r];
    const nextTs: number | null = r + 1 < runs.length ? runs[r + 1].timestamp : nextUs;
    let frameDuration: number = nextTs !== null ? (nextTs - run.timestamp) / run.frames.length : (measured ?? codecFrame ?? FALLBACK_AUDIO_FRAME_US);
    if (nextTs !== null && frameDuration > 0) measured = frameDuration;
    else if (!(frameDuration > 0)) frameDuration = measured ?? codecFrame ?? FALLBACK_AUDIO_FRAME_US;
    for (let i = 0; i < run.frames.length; i++) {
      let decode = Math.round(run.timestamp + i * frameDuration) + delayUs;
      const end = Math.round(run.timestamp + (i + 1) * frameDuration) + delayUs;
      // Avant l'origine même après D : l'amorce d'un encodeur qu'une liste de montage MP4 a placée en
      // temps négatif (−21 ms pour un AAC). Un `tfdt` ne dit pas un instant négatif ; ces trames ne
      // sont pas jouées (la liste de montage les retirait), on ne les écrit pas.
      if (decode < 0) continue;
      if (endUs !== null && decode < endUs) {
        if (end - endUs < frameDuration / 2) continue;
        decode = endUs;
      }
      const duration = Math.max(1, end - decode);
      samples.push({ data: run.frames[i].data, decodeTime: decode, duration, compositionOffset: 0, isKeyframe: true });
      endUs = decode + duration;
    }
  }
  return samples;
}

/** Le premier rang pour lequel `ok` est vrai (`ok` croissant), ou `count`. */
function lowerBound(count: number, ok: (index: number) => boolean): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ok(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}
