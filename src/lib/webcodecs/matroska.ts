// Matroska demuxer for the experimental WebCodecs player.
//
// Reads only what playback needs: the timestamp scale and duration, the track list with each
// track's codec configuration, the cue index for seeking, and then a stream of encoded samples
// pulled cluster by cluster. It never rewrites or converts anything — the samples handed out are
// the exact bytes stored in the file, which is the whole point: they go straight into a hardware
// decoder with no ffmpeg in between.

import { SlicedSource, type ByteSource } from "./byteSource";
import { ID, TRACK_TYPE } from "./matroskaIds";
import { forEachChild, readElementAt, readFloat, readString, readUint, readVarInt, readVarSize } from "./ebml";

export interface TrackColour {
  matrixCoefficients?: number;
  transferCharacteristics?: number;
  primaries?: number;
  /** 1 = limited/TV, 2 = full/PC. */
  range?: number;
  bitsPerChannel?: number;
}

export interface MatroskaTrack {
  number: number;
  type: "video" | "audio" | "subtitle" | "other";
  codecId: string;
  codecPrivate: Uint8Array | null;
  language: string | null;
  name: string | null;
  isDefault: boolean;
  isForced: boolean;
  isEnabled: boolean;
  defaultDurationNs: number | null;
  video?: { width: number; height: number; displayWidth?: number; displayHeight?: number; colour?: TrackColour };
  audio?: { sampleRate: number; channels: number; bitDepth?: number };
}

export interface CuePoint {
  /**
   * Which track this entry indexes.
   *
   * A cue point carries one set of positions per indexed track, and they are not interchangeable:
   * an audio entry marks a place where the *sound* can be picked up, which is very often nowhere
   * near a video keyframe. Seeking to one leaves the decoder with nothing it can start from.
   */
  track: number;
  /** Presentation time in microseconds. */
  timeUs: number;
  /** Absolute file offset of the cluster holding it. */
  clusterOffset: number;
}

export interface MatroskaFile {
  timestampScaleNs: number;
  durationSeconds: number | null;
  tracks: MatroskaTrack[];
  cues: CuePoint[];
  /** Absolute offset of the Segment's first child — cue positions are relative to this. */
  segmentDataStart: number;
  segmentEnd: number;
  /** Absolute offset of the first Cluster, for playing from the start without cues. */
  firstClusterOffset: number | null;
}

export interface MediaSample {
  trackNumber: number;
  /** Presentation timestamp in microseconds — the unit WebCodecs uses. */
  timestampUs: number;
  durationUs: number | null;
  isKey: boolean;
  data: Uint8Array;
}

const NS_PER_US = 1000;
const DEFAULT_TIMESTAMP_SCALE_NS = 1_000_000; // Matroska's default: 1 ms per tick

function trackTypeOf(raw: number): MatroskaTrack["type"] {
  if (raw === TRACK_TYPE.video) return "video";
  if (raw === TRACK_TYPE.audio) return "audio";
  if (raw === TRACK_TYPE.subtitle) return "subtitle";
  return "other";
}

async function payload(source: ByteSource, element: { offset: number; size: number | null }): Promise<Uint8Array> {
  if (element.size === null) return new Uint8Array(0);
  return source.read(element.offset, element.size);
}

async function parseTrackEntry(source: ByteSource, start: number, end: number): Promise<MatroskaTrack | null> {
  const track: MatroskaTrack = {
    number: 0,
    type: "other",
    codecId: "",
    codecPrivate: null,
    language: null,
    name: null,
    isDefault: false,
    isForced: false,
    isEnabled: true,
    defaultDurationNs: null,
  };

  await forEachChild(source, start, end, async (el) => {
    switch (el.id) {
      case ID.TrackNumber:
        track.number = readUint(await payload(source, el));
        break;
      case ID.TrackType:
        track.type = trackTypeOf(readUint(await payload(source, el)));
        break;
      case ID.CodecID:
        track.codecId = readString(await payload(source, el));
        break;
      case ID.CodecPrivate:
        // Copied out of the chunk cache: the cache may evict or reuse the backing buffer, and
        // this value has to stay valid for the whole session (it configures the decoder).
        track.codecPrivate = new Uint8Array(await payload(source, el));
        break;
      case ID.Language:
      case ID.LanguageBCP47:
        track.language = readString(await payload(source, el)) || track.language;
        break;
      case ID.TrackName:
        track.name = readString(await payload(source, el));
        break;
      case ID.FlagDefault:
        track.isDefault = readUint(await payload(source, el)) === 1;
        break;
      case ID.FlagForced:
        track.isForced = readUint(await payload(source, el)) === 1;
        break;
      case ID.FlagEnabled:
        track.isEnabled = readUint(await payload(source, el)) !== 0;
        break;
      case ID.DefaultDuration:
        track.defaultDurationNs = readUint(await payload(source, el));
        break;
      case ID.Video: {
        const video = { width: 0, height: 0 } as NonNullable<MatroskaTrack["video"]>;
        await forEachChild(source, el.offset, el.offset + (el.size ?? 0), async (v) => {
          switch (v.id) {
            case ID.PixelWidth: video.width = readUint(await payload(source, v)); break;
            case ID.PixelHeight: video.height = readUint(await payload(source, v)); break;
            case ID.DisplayWidth: video.displayWidth = readUint(await payload(source, v)); break;
            case ID.DisplayHeight: video.displayHeight = readUint(await payload(source, v)); break;
            case ID.Colour: {
              const colour: TrackColour = {};
              await forEachChild(source, v.offset, v.offset + (v.size ?? 0), async (c) => {
                switch (c.id) {
                  case ID.MatrixCoefficients: colour.matrixCoefficients = readUint(await payload(source, c)); break;
                  case ID.TransferCharacteristics: colour.transferCharacteristics = readUint(await payload(source, c)); break;
                  case ID.Primaries: colour.primaries = readUint(await payload(source, c)); break;
                  case ID.ColourRange: colour.range = readUint(await payload(source, c)); break;
                  case ID.BitsPerChannel: colour.bitsPerChannel = readUint(await payload(source, c)); break;
                }
                return "continue";
              });
              video.colour = colour;
              break;
            }
          }
          return "continue";
        });
        track.video = video;
        break;
      }
      case ID.Audio: {
        const audio = { sampleRate: 8000, channels: 1 } as NonNullable<MatroskaTrack["audio"]>;
        await forEachChild(source, el.offset, el.offset + (el.size ?? 0), async (a) => {
          switch (a.id) {
            case ID.SamplingFrequency: audio.sampleRate = readFloat(await payload(source, a)); break;
            // SBR/HE-AAC stores the real output rate here; it wins when present because that is
            // the rate the decoder actually produces.
            case ID.OutputSamplingFrequency: audio.sampleRate = readFloat(await payload(source, a)); break;
            case ID.Channels: audio.channels = readUint(await payload(source, a)); break;
            case ID.AudioBitDepth: audio.bitDepth = readUint(await payload(source, a)); break;
          }
          return "continue";
        });
        track.audio = audio;
        break;
      }
    }
    return "continue";
  });

  return track.number > 0 ? track : null;
}

/**
 * Reads everything needed before playback can start. Deliberately does not scan clusters: on a
 * 40 GB file that would mean reading the whole thing, when the cue index at the end already says
 * where every keyframe lives.
 */
export async function parseMatroska(source: ByteSource): Promise<MatroskaFile> {
  const first = await readElementAt(source, 0);
  if (!first || first.id !== ID.EBML) throw new Error("Ce fichier n'est pas un conteneur Matroska.");

  // Segment is the top-level container; everything else lives inside it.
  let cursor = first.offset + (first.size ?? 0);
  let segment = await readElementAt(source, cursor);
  while (segment && segment.id !== ID.Segment) {
    if (segment.size === null) break;
    cursor = segment.offset + segment.size;
    segment = await readElementAt(source, cursor);
  }
  if (!segment || segment.id !== ID.Segment) throw new Error("Segment Matroska introuvable.");

  const segmentDataStart = segment.offset;
  const segmentEnd = segment.size === null ? source.size : Math.min(segment.offset + segment.size, source.size);

  const file: MatroskaFile = {
    timestampScaleNs: DEFAULT_TIMESTAMP_SCALE_NS,
    durationSeconds: null,
    tracks: [],
    cues: [],
    segmentDataStart,
    segmentEnd,
    firstClusterOffset: null,
  };

  // Positions recorded by the SeekHead, so Tracks/Cues can be jumped to directly. Without it the
  // walk below still finds them, it just has to step over more elements.
  const seekPositions = new Map<number, number>();

  await forEachChild(source, segmentDataStart, segmentEnd, async (el) => {
    switch (el.id) {
      case ID.SeekHead:
        await forEachChild(source, el.offset, el.offset + (el.size ?? 0), async (seek) => {
          if (seek.id !== ID.Seek) return "continue";
          let id = 0;
          let position = -1;
          await forEachChild(source, seek.offset, seek.offset + (seek.size ?? 0), async (s) => {
            if (s.id === ID.SeekID) id = readUint(await payload(source, s));
            if (s.id === ID.SeekPosition) position = readUint(await payload(source, s));
            return "continue";
          });
          if (id && position >= 0) seekPositions.set(id, segmentDataStart + position);
          return "continue";
        });
        return "continue";

      case ID.Info: {
        // Duration is expressed in TimestampScale ticks, not seconds — and the two elements can
        // appear in either order, so the conversion waits until both have been read. (Caught by
        // running this against a real file: a 2h movie reported a duration of 7 176 362.)
        let durationTicks: number | null = null;
        await forEachChild(source, el.offset, el.offset + (el.size ?? 0), async (info) => {
          if (info.id === ID.TimestampScale) file.timestampScaleNs = readUint(await payload(source, info)) || DEFAULT_TIMESTAMP_SCALE_NS;
          if (info.id === ID.Duration) durationTicks = readFloat(await payload(source, info));
          return "continue";
        });
        if (durationTicks !== null) file.durationSeconds = (durationTicks * file.timestampScaleNs) / 1e9;
        return "continue";
      }

      case ID.Tracks: {
        // Held whole rather than read field by field — see SlicedSource.
        const end = el.offset + (el.size ?? 0);
        const buffered = await SlicedSource.of(source, el.offset, end);
        await forEachChild(buffered, el.offset, end, async (entry) => {
          if (entry.id !== ID.TrackEntry) return "continue";
          const track = await parseTrackEntry(buffered, entry.offset, entry.offset + (entry.size ?? 0));
          if (track) file.tracks.push(track);
          return "continue";
        });
        return "continue";
      }

      case ID.Cues: {
        const end = el.offset + (el.size ?? 0);
        await parseCues(await SlicedSource.of(source, el.offset, end), el.offset, end, segmentDataStart, file);
        return "continue";
      }

      case ID.Cluster:
        // The first cluster is where playback begins when there is no usable index. Reaching it
        // also means every header element that matters has been passed, so the walk can stop
        // rather than stepping through gigabytes of media data.
        file.firstClusterOffset = el.offset - el.headerSize;
        return "stop";
    }
    return "continue";
  });

  // Some muxers put Cues at the very end and only reference them from the SeekHead, so the
  // forward walk above stops at the first cluster before ever seeing them.
  if (file.cues.length === 0) {
    const cuesOffset = seekPositions.get(ID.Cues);
    if (cuesOffset !== undefined && cuesOffset < source.size) {
      const cues = await readElementAt(source, cuesOffset);
      if (cues && cues.id === ID.Cues && cues.size !== null) {
        const end = cues.offset + cues.size;
        await parseCues(await SlicedSource.of(source, cues.offset, end), cues.offset, end, segmentDataStart, file);
      }
    }
  }

  // Same for Tracks, on files that place them after the media data.
  if (file.tracks.length === 0) {
    const tracksOffset = seekPositions.get(ID.Tracks);
    if (tracksOffset !== undefined && tracksOffset < source.size) {
      const tracks = await readElementAt(source, tracksOffset);
      if (tracks && tracks.id === ID.Tracks && tracks.size !== null) {
        const end = tracks.offset + tracks.size;
        const buffered = await SlicedSource.of(source, tracks.offset, end);
        await forEachChild(buffered, tracks.offset, end, async (entry) => {
          if (entry.id !== ID.TrackEntry) return "continue";
          const track = await parseTrackEntry(buffered, entry.offset, entry.offset + (entry.size ?? 0));
          if (track) file.tracks.push(track);
          return "continue";
        });
      }
    }
  }

  if (file.tracks.length === 0) throw new Error("Aucune piste lisible dans ce fichier.");
  file.cues.sort((a, b) => a.timeUs - b.timeUs);
  return file;
}

async function parseCues(
  source: ByteSource,
  start: number,
  end: number,
  segmentDataStart: number,
  file: MatroskaFile
): Promise<void> {
  await forEachChild(source, start, end, async (point) => {
    if (point.id !== ID.CuePoint) return "continue";
    let time = -1;
    const positions: { track: number; clusterPosition: number }[] = [];
    await forEachChild(source, point.offset, point.offset + (point.size ?? 0), async (c) => {
      if (c.id === ID.CueTime) time = readUint(await payload(source, c));
      if (c.id === ID.CueTrackPositions) {
        let track = -1;
        let clusterPosition = -1;
        await forEachChild(source, c.offset, c.offset + (c.size ?? 0), async (p) => {
          if (p.id === ID.CueTrack) track = readUint(await payload(source, p));
          // Only the cluster position is used: reading restarts at the cluster and runs forward
          // to the keyframe, so the finer CueRelativePosition would buy nothing.
          if (p.id === ID.CueClusterPosition && clusterPosition < 0) clusterPosition = readUint(await payload(source, p));
          return "continue";
        });
        if (track >= 0 && clusterPosition >= 0) positions.push({ track, clusterPosition });
      }
      return "continue";
    });
    // One entry per indexed track, rather than whichever happened to be written first. Keeping
    // only the first is how a seek ends up following the audio track's index into a cluster with
    // no picture to start from.
    if (time >= 0) {
      for (const { track, clusterPosition } of positions) {
        file.cues.push({
          track,
          timeUs: Math.round((time * file.timestampScaleNs) / NS_PER_US),
          clusterOffset: segmentDataStart + clusterPosition,
        });
      }
    }
    return "continue";
  });
}

/**
 * Where to start reading clusters to land at or just before `timeUs`.
 *
 * @param trackNumber the track that has to be decodable from there — the video one, in practice.
 *   Entries for other tracks are ignored when any exist for this one, because they mark places
 *   the *sound* can resume, which is regularly nowhere near a picture a decoder can start on.
 */
export function clusterOffsetForTime(file: MatroskaFile, timeUs: number, trackNumber?: number): number | null {
  const forTrack = trackNumber === undefined ? file.cues : file.cues.filter((cue) => cue.track === trackNumber);
  const cues = forTrack.length > 0 ? forTrack : file.cues;
  if (cues.length === 0) return file.firstClusterOffset;

  let best = cues[0];
  for (const cue of cues) {
    if (cue.timeUs <= timeUs) best = cue;
    else break;
  }
  return best.clusterOffset;
}

// Lacing packs several small frames into one block — common for audio, essentially never used
// for video. Getting it wrong turns a valid audio track into noise, so all three schemes are
// implemented rather than assuming the file won't use them.
function unlace(data: Uint8Array, flags: number): Uint8Array[] {
  const lacing = (flags >> 1) & 0x03;
  if (lacing === 0) return [data];

  const frameCount = data[0] + 1;
  let at = 1;
  const sizes: number[] = [];

  if (lacing === 2) {
    // Fixed: every frame is the same size.
    const size = Math.floor((data.length - at) / frameCount);
    for (let i = 0; i < frameCount; i++) sizes.push(size);
  } else if (lacing === 1) {
    // Xiph: sizes as chains of 255s, all but the last frame.
    for (let i = 0; i < frameCount - 1; i++) {
      let size = 0;
      while (at < data.length) {
        size += data[at];
        if (data[at++] !== 255) break;
      }
      sizes.push(size);
    }
  } else {
    // EBML: first size absolute, the rest as signed deltas.
    const first = readVarSize(data, at);
    if (!first || first.value === null) return [data];
    at += first.width;
    sizes.push(first.value);
    for (let i = 1; i < frameCount - 1; i++) {
      const delta = readVarInt(data, at);
      if (!delta) return [data];
      at += delta.width;
      sizes.push(sizes[sizes.length - 1] + delta.value);
    }
  }

  const frames: Uint8Array[] = [];
  for (const size of sizes) {
    if (at + size > data.length) return frames.length ? frames : [data];
    frames.push(data.subarray(at, at + size));
    at += size;
  }
  // The last frame takes whatever is left (all schemes except fixed, which already covered it).
  if (lacing !== 2 && at <= data.length) frames.push(data.subarray(at));
  return frames;
}

/** Decodes one SimpleBlock/Block payload into samples. */
export function parseBlock(
  data: Uint8Array,
  clusterTimeTicks: number,
  timestampScaleNs: number,
  isSimple: boolean,
  blockGroupIsKey: boolean
): MediaSample[] {
  const track = readVarSize(data, 0);
  if (!track || track.value === null) return [];
  let at = track.width;
  if (at + 3 > data.length) return [];

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const relative = view.getInt16(at);
  at += 2;
  const flags = data[at];
  at += 1;

  // SimpleBlock carries its keyframe flag in the top bit. A plain Block does not — for those the
  // caller decides from the absence of a ReferenceBlock in the enclosing BlockGroup.
  const isKey = isSimple ? (flags & 0x80) !== 0 : blockGroupIsKey;
  const usPerTick = timestampScaleNs / NS_PER_US;
  const timestampUs = Math.round((clusterTimeTicks + relative) * usPerTick);

  const frames = unlace(data.subarray(at), flags);
  return frames.map((frame) => ({
    trackNumber: track.value as number,
    timestampUs,
    durationUs: null,
    isKey,
    data: frame,
  }));
}
