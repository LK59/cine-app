// Turns a Matroska file into the segment stream a MediaSource eats, without touching a single
// byte of the compressed video or audio.
//
// The samples inside Matroska are already exactly what MP4 wants — HEVC and AVC access units
// prefixed by their length, AC-3 and AAC frames as they are. Only the packaging differs. So this
// copies samples verbatim and rebuilds the wrapper around them, which is why it costs almost
// nothing and, unlike the WebCodecs path, hands the decoding back to the browser's own hardware
// pipeline: no canvas, no per-frame JavaScript, no colour conversion, HDR handled natively.
//
// An MP4 comes through here too, described in the same shape (mp4Demux.ts) and read through the
// same factory (mediaFile.ts): the remuxer never learns which container it is reading.

import { deriveDurations, assignDecodeTimes } from "./decodeOrder";
import { subtitleText, TEXT_SUBTITLE_CODECS, type SubtitleCue } from "./engine";
import { av1CodecString, joinBytes, strayUnits, avcCodecString, hevcCodecString, isRandomAccessPoint, nalLengthSize, dolbyVisionCodecString, withoutHdr10Plus } from "./codecConfig";
import type { MatroskaFile, MatroskaTrack, MediaSample } from "./matroska";
import { clusterOffsetForTime } from "./matroska";
import { initSegment, mediaSegment, type MuxSample, type MuxTrackInfo } from "./mp4Muxer";
import { audioSampleEntryFor, videoSampleEntry } from "./mp4SampleEntries";
import { transcodeTargetCodec, AudioTranscoder, transcodableAudio, type TranscodedFrame } from "./audioTranscode";
import { trace } from "./trace";
import { containerAccepts } from "./mseSource";
import { createSampleReader, type MediaSampleReader } from "./mediaFile";
import type { ByteSource } from "./byteSource";

/** Microseconds — Matroska's own precision, so sample times are copied rather than rescaled. */
const TIMESCALE = 1_000_000;

/** Roughly how much media each segment carries. Cut at keyframes, so it is a floor, not a target. */
const SEGMENT_US = 2_000_000;

/**
 * How many times a failing encoder is rebuilt before its failure is reported.
 *
 * One is usually enough — the hiccup is transient — and an encoder that refuses every time must
 * not turn into a player that reads a whole film in silence.
 */
const MAX_ENCODER_RESTARTS = 3;

/**
 * Combien de segments sains effacent les reconstructions de l'encodeur.
 *
 * Le compteur ci-dessus ne redescendait jamais : trois reconstructions pour tout le film. Or
 * l'encodeur AAC d'Apple échoue *de loin en loin*, si bien qu'un long film épuisait son crédit par
 * accident et partait au lecteur serveur au quatrième hoquet. Trente segments, c'est une minute de
 * son produite sans incident : un encodeur qui échoue à chaque fois n'y arrive jamais et garde sa
 * borne ; un hoquet isolé est oublié, comme le budget de reconstruction du lecteur, qui décroît.
 */
const GOOD_SEGMENTS_TO_FORGIVE = 30;

/**
 * How far back to read from when the index points at a picture a decoder cannot start on.
 *
 * More than the widest gap between genuine random access points measured across this library —
 * ten seconds — so one step is normally enough. Tried a few times, further each time, because a
 * file could in principle have a long stretch with none at all.
 */
const INDEX_BACKUP_US = 12_000_000;
const MAX_INDEX_BACKUPS = 3;

/**
 * How much a single fragment may carry, and how many samples.
 *
 * Both bounds matter. The bytes are what a player has to swallow in one call, and the sample
 * count is what its parser has to walk; a stretch of tiny pictures can be many of one and little
 * of the other. Two seconds of this library's video is about a megabyte, so these are that, with
 * room for a hard scene.
 */
const FRAGMENT_BYTES = 1_200_000;
const FRAGMENT_SAMPLES = 60;

/**
 * How many pictures beyond a fragment must be read before its timeline is final.
 *
 * A picture's decode time is its rank among the group's presentation times, so one read later can
 * still displace one already held — but only within the reordering depth of the codec, which is a
 * handful of pictures and never the whole group. The depth is measured once per stream; until
 * there is anything to measure, this generous guess stands in for it. Sixty-four is far past any
 * reordering a real encoder produces, and still a fraction of a twenty-five-second group.
 */
const REORDER_LOOKAHEAD_GUESS = 64;
const REORDER_LOOKAHEAD_MARGIN = 4;

/** A frame's duration when nothing in the file says what it is: 24 fps, close enough for one frame. */
const FALLBACK_FRAME_US = 41_667;

/**
 * Extra room on top of the reordering depth measured in the first segment, in frames.
 *
 * The delay is fixed for the whole stream — changing it mid-way would put a gap or an overlap at
 * a segment boundary — so it is measured once and given margin in case a later segment reorders
 * more deeply than the opening one.
 */
const DELAY_MARGIN_FRAMES = 3;

/** An audio frame's duration when the file gives nothing to measure it from: 1536 samples at 48 kHz. */
const FALLBACK_AUDIO_FRAME_US = 32_000;

/** A subtitle line, carrying the track it belongs to so a change of language costs nothing. */
export interface TrackedCue extends SubtitleCue {
  track: number;
}

export interface RemuxSegment {
  /**
   * The pictures, in one or more fragments — see Remuxer.fragmentise. Empty when this stretch's
   * pictures were not wanted, which is what a change of audio language asks for.
   */
  video: Uint8Array[];
  audio: Uint8Array | null;
  /**
   * Subtitle lines found while reading this stretch of the file, already timed on the player's
   * clock — for *every* text track, not only the one on screen.
   *
   * They come free: every sample in the file passes through here anyway, so picking the subtitle
   * ones out costs no extra reading, and text weighs nothing next to the pictures. Collecting
   * only the selected track would mean re-reading the file whenever the viewer changes language,
   * and re-reading means re-appending media the browser has already played — which it catches up
   * on at speed, so a change of subtitles came with a second of fast-forward.
   */
  subtitles: TrackedCue[];
  /** Presentation time of the end of this segment, in seconds. */
  endSeconds: number;
}

/** How long a subtitle stays up when the file does not say. Long enough to read a short line. */
const SUBTITLE_FALLBACK_SECONDS = 3;

export interface RemuxPlan {
  videoMimeType: string;
  audioMimeType: string | null;
  videoInit: Uint8Array;
  audioInit: Uint8Array | null;
  durationSeconds: number;
}

export interface RemuxDiagnostics {
  /**
   * How far the whole presentation timeline sits after the source's, in seconds.
   *
   * Reordering forces it: a decoder cannot show a picture it has not decoded, so the first
   * picture cannot be presented at the same instant the first picture is decoded. Both tracks
   * carry the identical shift, so they stay in sync with each other — but the player's clock is
   * this much ahead of the file's, which is what a seek has to account for.
   */
  presentationDelaySeconds: number;
  /** Pictures whose offset had to be clamped because the fixed delay was too small. Should be 0. */
  clampedSamples: number;
  /** The sound is being decoded and encoded again on the way through, rather than copied. */
  transcodedAudio: boolean;
  /** What it was re-encoded as, when it was. Not always AAC — see chooseTranscodeCodec. */
  transcodedCodec: string | null;
  /** Where the last segment built began, on the file's clock. What a seek actually landed on. */
  segmentStartSeconds: number;
}

function aacCodecString(codecPrivate: Uint8Array | null): string {
  // The object type is the first five bits of the AudioSpecificConfig; 2 is AAC-LC, which is
  // what all but a handful of files use.
  const objectType = codecPrivate && codecPrivate.length > 0 ? codecPrivate[0] >> 3 : 2;
  return `mp4a.40.${objectType === 31 ? 2 : objectType}`;
}

function audioCodecString(track: MatroskaTrack): string | null {
  switch (track.codecId) {
    case "A_AAC": return aacCodecString(track.codecPrivate);
    case "A_FLAC": return "flac";
    case "A_AC3": return "ac-3";
    case "A_EAC3": return "ec-3";
    default: return null;
  }
}

function videoCodecString(track: MatroskaTrack): string | null {
  if (!track.codecPrivate) return null;
  if (track.codecId === "V_MPEGH/ISO/HEVC") return hevcCodecString(track.codecPrivate);
  if (track.codecId === "V_MPEG4/ISO/AVC") return avcCodecString(track.codecPrivate);
  if (track.codecId === "V_AV1") return av1CodecString(track.codecPrivate);
  return null;
}

/**
 * The MIME types the remuxed segments would carry, derivable from the track headers alone.
 *
 * Worth having separately from `plan()`: opening a remuxer reads from the file — an AC-3 track
 * cannot be described without seeing a frame — and there is no point paying for that before
 * knowing whether the browser would accept the result.
 */
export function plannedMimeTypes(
  videoTrack: MatroskaTrack,
  audioTrack: MatroskaTrack | null,
  file?: MatroskaFile
): { video: string | null; audio: string | null } {
  const video = videoCodecString(videoTrack);
  // What will arrive in the container, which for a re-encoded track is not what is in the file.
  const audio = !audioTrack
    ? null
    : audioDelivery(audioTrack, file) === "transcode"
      ? TRANSCODED_CODEC()
      : audioCodecString(audioTrack);
  return {
    video: video ? `video/mp4; codecs="${video}"` : null,
    audio: audio ? `audio/mp4; codecs="${audio}"` : null,
  };
}

/** Whether this track can be remuxed at all — checked before any of the work starts. */
export function remuxableVideo(track: MatroskaTrack): boolean {
  return videoCodecString(track) !== null;
}

/** What this codec can be described as in an MP4, or null if it cannot. */
export function remuxableAudio(track: MatroskaTrack): boolean {
  return audioCodecString(track) !== null;
}

/** What has to happen to a track's sound for this player to carry it. */
export type AudioDelivery = "copy" | "transcode" | "none";

function naturalDelivery(track: MatroskaTrack): AudioDelivery {
  const natural = audioCodecString(track);
  if (natural && containerAccepts(`audio/mp4; codecs="${natural}"`)) return "copy";
  return transcodableAudio(track) ? "transcode" : "none";
}

/**
 * **La livraison par piste** — l'interrupteur de ce qui suit.
 *
 * À `false`, c'est l'unification par fichier, décrite plus bas et stable depuis le 03/09/2026 :
 * si les pistes d'un fichier ne peuvent pas toutes passer telles quelles, toutes sont
 * ré-encodées, et le codec ne change jamais pendant la vie de la MediaSource.
 *
 * À `true`, chaque piste est livrée dans sa meilleure forme — le Dolby tel quel, le TrueHD et le
 * DTS ré-encodés. Un changement de piste reconstruit le lecteur à la même position, directement
 * sur la nouvelle piste, par le mécanisme qui relève déjà le lecteur d'une coupure (voir
 * `ExperimentalPlayerHost`) — pour tout changement depuis le 22/09/2026, et non plus seulement
 * pour un changement de format.
 *
 * Pourquoi, mesuré le 21/09/2026 : depuis que le TrueHD se décode ici, 19 films qui mêlent TrueHD
 * et Dolby voyaient leur VF Dolby ré-encodée — une seconde génération avec perte, du travail pour
 * le téléphone, pour une piste qui passait intacte la veille. Et un changement de piste ré-encodé
 * coûtait 2 à 15 s sur iPhone, quand une reconstruction du lecteur en prenait 0,3 à 0,5
 * (« Dirty Dancing », trois reconstructions ce jour-là).
 *
 * Les trois échecs du 03/09/2026 restent vrais et ne sont pas contournés : aucune de ces voies ne
 * change le codec d'un tampon vivant, ni ne remplace une MediaSource saine en cours de lecture
 * sur place ; c'est le lecteur entier qui est reconstruit, comme après une coupure.
 */
let perTrack = true;

/**
 * Retirer les métadonnées HDR10+ du flux vidéo — voir `withoutHdr10Plus`. Posé par
 * `probePlaybackPath` selon le navigateur : c'est un défaut d'un moteur, pas une capacité qu'on
 * pourrait lui demander.
 */
let stripHdr10Plus = false;

export function setStripHdr10Plus(value: boolean): void {
  stripHdr10Plus = value;
}

export function setPerTrackAudioDelivery(value: boolean): void {
  perTrack = value;
}

export function perTrackAudioDelivery(): boolean {
  return perTrack;
}

/** What a re-encoded track is delivered as, and therefore what every track is unified to. */
const TRANSCODED_CODEC = () => transcodeTargetCodec();

/**
 * The one codec every audio track of this file will be delivered in — or null when they can all
 * keep their own.
 *
 * This is the design that replaced changing a live buffer's codec, and the reason is worth
 * writing down. A source buffer can be told to reinterpret itself mid-playback, and the
 * specification says so, but this device answers a language change that crosses codecs with
 * "media failed to decode" — sometimes at once, sometimes six seconds later at the next pause —
 * and a decode failure closes the MediaSource and takes the picture with it. Every attempt to
 * make that transition survivable was a guess about someone else's decoder.
 *
 * So the transition is removed instead. If a file's audio tracks cannot all be delivered as they
 * are, they are all delivered re-encoded, decided once when the file is opened. The codec then
 * never changes for the life of the MediaSource. (Changing language then emptied the audio
 * buffer and read it again; since 2026-09-22 every change rebuilds the player instead, so this
 * design — kept behind `perTrack = false` — no longer has a transition to protect.)
 *
 * The cost is real and worth naming: on a file that mixes codecs, a track that could have ridden
 * through untouched is decoded and encoded again. It buys a language change that cannot break
 * playback. A file whose tracks already agree — most of the library — pays nothing.
 */
export function unifiedAudioCodec(file: MatroskaFile): string | null {
  // Not needed where each track is delivered on its own and a change of track rebuilds the
  // player — see perTrack.
  if (perTrack) return null;

  const audio = file.tracks.filter((t) => t.type === "audio" && naturalDelivery(t) !== "none");
  if (audio.length < 2) return null;
  const delivered = new Set(
    audio.map((t) => (naturalDelivery(t) === "copy" ? audioCodecString(t) : TRANSCODED_CODEC()))
  );
  if (delivered.size < 2) return null;
  // Unifying is only possible if everything can actually be carried that way.
  return audio.every((t) => audioCodecString(t) === TRANSCODED_CODEC() || transcodableAudio(t))
    ? TRANSCODED_CODEC()
    : null;
}

/**
 * La disposition de canaux que toutes les pistes audio de ce fichier partageront — ou `null`
 * quand chacune peut garder la sienne.
 *
 * C'est le pendant, longtemps manquant, de {@link unifiedAudioCodec}. Celui-ci retire la
 * transition de *codec* au milieu d'un tampon audio ; il ne disait rien du nombre de canaux, qui
 * fait pourtant partie de la même configuration. Un fichier dont les deux pistes sont déjà
 * livrées dans le même codec — deux pistes E-AC3 ré-encodées en Opus, le cas courant — ne
 * déclenchait donc aucune unification, et changer de langue faisait passer le tampon de huit
 * canaux à six.
 *
 * Mesuré : Firefox 154 sous Linux accepte ce nouveau segment d'initialisation, continue de lire
 * l'image, et ne sort plus aucun son. « Mourir peut attendre » — piste française en 7.1 Atmos,
 * anglaise en 5.1 — se lit en français et devient muet en anglais. Le même fichier fonctionne
 * dans les deux langues sur iPhone, qui, lui, encaisse le changement.
 *
 * L'unification va vers le **plus grand** compte du fichier, et personne n'y perd : l'ordre des
 * canaux est L R C LFE Ls Rs Lrs Rrs, donc porter un 5.1 en 7.1 revient à ajouter deux arrières
 * silencieux — un mixage 5.1 n'a de toute façon rien à y mettre. La piste la plus riche garde
 * tous ses canaux, la plus pauvre sort des mêmes enceintes qu'avant.
 *
 * Le compte demandé reste un souhait : `chooseTranscodePlan` le rabaisse si l'encodeur du
 * navigateur ne sait pas produire autant de canaux — un Chrome qui plafonne à six repliera alors
 * les deux pistes en 5.1, ce qui les laisse unifiées quand même.
 *
 * Écrit pour le changement de piste dans le tampon, retiré le 22/09/2026 : chaque changement
 * reconstruit désormais le lecteur, et cette unification n'a plus de transition à protéger.
 * Gardée telle quelle pour ne rien changer à ce qui est livré ; la retirer est une décision à
 * part — elle rendrait à chaque piste ré-encodée son propre nombre de canaux.
 */
export function unifiedAudioChannels(file: MatroskaFile): number | null {
  // Livrées piste par piste, seules les pistes ré-encodées partagent un tampon sans reconstruction
  // — elles sortent toutes dans le même codec — et c'est entre elles seulement que le nombre de
  // canaux doit être le même. Une piste copiée garde évidemment les siens.
  const carried = file.tracks.filter(
    (t) => t.type === "audio" && (perTrack ? naturalDelivery(t) === "transcode" : naturalDelivery(t) !== "none")
  );
  if (carried.length < 2) return null;

  // Le repli est celui de la spécification Matroska — un canal —, et non un deux inventé ici.
  // Le lecteur de conteneur applique déjà ce défaut et construit toujours ce bloc pour une piste
  // audio, si bien que ce repli ne s'exécute pas ; le laisser contredire la seule autre valeur par
  // défaut du dépôt n'aidait qu'à faire croire à deux règles là où il n'y en a qu'une.
  const counts = carried.map((t) => t.audio?.channels ?? 1);
  const max = Math.max(...counts);
  return counts.some((n) => n !== max) ? max : null;
}

/**
 * Asked of the browser, not answered from a list.
 *
 * Which codecs a player takes inside a MediaSource is not a property of the codec: an iPhone
 * takes AC-3 there and should carry it through untouched, while Chrome ships no Dolby decoder at
 * all and would otherwise lose the hardware path for most of a library over it. So the question
 * is put to the browser, and only what it declines is decoded and encoded again.
 *
 * Given the file as well, the answer also accounts for the other tracks in it: see
 * {@link unifiedAudioCodec}.
 */
export function audioDelivery(track: MatroskaTrack, file?: MatroskaFile): AudioDelivery {
  const natural = naturalDelivery(track);
  if (!file || natural === "none") return natural;

  const unified = unifiedAudioCodec(file);
  if (!unified) return natural;
  if (natural === "copy" && audioCodecString(track) === unified) return "copy";
  return "transcode";
}

/** Carried through at all — either untouched, or by being decoded and encoded again. */
export function playableAudio(track: MatroskaTrack): boolean {
  return audioDelivery(track) !== "none";
}

/**
 * Builds the box that tells a decoder how to read this audio track.
 *
 * AC-3 and E-AC-3 carry no description in the Matroska header — it has to be read out of a frame.
 * The probe uses its own reader and throws its samples away rather than handing them to the
 * segment builder: the byte source caches what it read, so starting over costs nothing, and there
 * is then no second copy of the opening samples to accidentally emit twice. How far the first
 * audio frame sits from the start varies a lot between files; some open with a long run of video
 * before any sound.
 */
async function describeAudio(
  source: ByteSource,
  file: MatroskaFile,
  start: number,
  track: MatroskaTrack
): Promise<MuxTrackInfo> {
  let firstFrame: Uint8Array | null = null;
  if (track.codecId === "A_AC3" || track.codecId === "A_EAC3") {
    const probe = createSampleReader(source, file, start);
    for (let i = 0; i < 20_000 && !firstFrame; i++) {
      const sample = await probe.next();
      if (!sample) break;
      if (sample.trackNumber === track.number) firstFrame = sample.data;
    }
    if (!firstFrame) throw new Error("Aucune trame audio trouvée pour décrire la piste AC-3.");
  }

  return {
    id: 2,
    kind: "audio",
    timescale: TIMESCALE,
    sampleEntry: audioSampleEntryFor({
      codecId: track.codecId,
      codecPrivate: track.codecPrivate,
      channels: track.audio?.channels ?? 2,
      sampleRate: track.audio?.sampleRate ?? 48000,
      firstFrame,
    }),
    width: 0,
    height: 0,
    language: track.language ?? "und",
  };
}

/** The track description for sound the encoder produces rather than the file supplying. */
/**
 * Refuses a re-encoded track whose result this browser will not take.
 *
 * Checked here, before the description is put anywhere, because the alternative is discovering it
 * by appending: an init segment the browser rejects does not merely fail on Safari, it closes the
 * MediaSource, and the video buffer playing perfectly beside it dies with it.
 */
function assertContainerTakes(transcoder: AudioTranscoder): void {
  const mime = `audio/mp4; codecs="${transcoder.codecString}"`;
  if (containerAccepts(mime)) return;
  transcoder.close();
  throw new Error(`Ce navigateur produit un AAC qu'il n'accepte pas lui-même : ${mime}`);
}

/**
 * Which samples go in which fragment, given how big each one is.
 *
 * Separate from the muxing so it can be exercised on shapes real files rarely produce: a run of
 * tiny pictures, one picture larger than the whole budget, a group that divides evenly.
 */
/**
 * How many pictures beyond a fragment settle its timeline.
 *
 * Separate from the remuxer so the rule can be read and exercised on its own: it is the one thing
 * standing between handing media over early and handing over a timeline that later moves.
 */
function reorderLookahead(delayUs: number | null, frameUs: number | null): number {
  if (delayUs === null || frameUs === null) return REORDER_LOOKAHEAD_GUESS;
  const depth = Math.ceil(delayUs / Math.max(1, frameUs));
  return Math.min(REORDER_LOOKAHEAD_GUESS, depth + REORDER_LOOKAHEAD_MARGIN);
}

function planFragments(count: number, byteLengthOf: (index: number) => number): number[][] {
  const fragments: number[][] = [];
  let from = 0;
  while (from < count) {
    let to = from;
    let bytes = 0;
    // At least one sample, however large it is on its own: a fragment of nothing is not a
    // smaller fragment, it is an infinite loop.
    do {
      bytes += byteLengthOf(to);
      to += 1;
    } while (to < count && to - from < FRAGMENT_SAMPLES && bytes < FRAGMENT_BYTES);
    fragments.push(Array.from({ length: to - from }, (_, i) => from + i));
    from = to;
  }
  return fragments;
}

/** Deux transcodeurs qui décrivent le tampon audio de la même façon : fréquence et canaux. */
function sameShape(a: AudioTranscoder, b: AudioTranscoder): boolean {
  return a.sampleRate === b.sampleRate && a.channels === b.channels;
}

function transcodedAudioInfo(transcoder: AudioTranscoder, track: MatroskaTrack): MuxTrackInfo {
  return {
    id: 2,
    kind: "audio",
    timescale: TIMESCALE,
    sampleEntry: transcoder.sampleEntry,
    width: 0,
    height: 0,
    language: track.language ?? "und",
  };
}

export class Remuxer {
  private pendingVideo: MediaSample[] = [];
  private pendingAudio: MediaSample[] = [];
  /** Units of a block with no picture, waiting to open the next picture. See strayUnits. */
  private strayAhead: Uint8Array[] = [];
  /**
   * Where the last segment's decode timeline ended. Reporting only: decode times are absolute,
   * anchored per segment on its own earliest picture, so nothing is chained off this.
   */
  private videoDecodeTime = 0;
  private encoderRestarts = 0;
  /** Segments de son produits sans échec depuis la dernière reconstruction — voir GOOD_SEGMENTS_TO_FORGIVE. */
  private goodSegments = 0;
  /**
   * Fermé : plus rien ne s'ouvre au nom de cet objet.
   *
   * Un segment en cours pendant `close()` échouait sur l'encodeur fermé, et `retryTranscoder`
   * ouvrait alors un transcodeur **neuf** — un décodeur (pour le TrueHD, un contexte WebAssembly)
   * et un AudioEncoder, dont le navigateur n'accorde qu'un nombre fixe —, installé sur un
   * remultiplexeur que plus personne ne fermerait.
   */
  private closed = false;
  /** La fin du son ré-encodé a été demandée, à la fin du fichier — voir nextSegment. */
  private tailDone = false;
  /** How many of the current group's pictures have already been handed over. */
  private emitted = 0;
  /** The picture that closes the current group and opens the next one. */
  private boundary: MediaSample | null = null;
  /** Whether the current group's last picture has been read. */
  private groupClosed = false;
  /** The group's own earliest presentation, fixed once enough of it has been read. */
  private groupAnchorUs: number | null = null;
  /** The typical gap between pictures, for turning a reordering delay into a count of them. */
  private frameDurationUs: number | null = null;
  /** Where a seek asked to be, while the reader is still looking for somewhere to start. */
  private seekTargetUs: number | null = null;
  private backupsLeft = 0;
  /** Read once from the codec's configuration record; see nalLengthSize. */
  private readonly nalLength: number;

  /**
   * Whether a decoder may start on this picture — which is not the same question as whether the
   * container called it a keyframe. See isRandomAccessPoint.
   */
  /**
   * A block that is not a picture, returned to the pictures it was cut from: its suffix units
   * close the last picture read, provided it has not been handed over yet — it virtually never
   * has, since the last few always wait on the reordering depth — and the rest opens the next.
   */
  private putBack(stray: { before: Uint8Array[]; after: Uint8Array[] }): void {
    const last = this.pendingVideo.length - 1;
    if (stray.before.length > 0 && last >= this.emitted) {
      const previous = this.pendingVideo[last];
      this.pendingVideo[last] = { ...previous, data: joinBytes([previous.data, ...stray.before]) };
    }
    this.strayAhead.push(...stray.after);
  }

  private startsHere(sample: MediaSample): boolean {
    return sample.isKey && isRandomAccessPoint(sample.data, this.videoTrack.codecId, this.nalLength);
  }
  private presentationDelayUs: number | null = null;
  private audioFrameUs: number | null = null;
  private subtitleNumbersCache: Map<number, MatroskaTrack> | null = null;
  /** Where the segment being built actually starts, on the file's clock. */
  private segmentStartUs = 0;
  /** A seek the transcoder still owes, deferred until that start is known. */
  /**
   * Vrai d'emblée depuis le 22/09/2026 : le transcodeur est amorcé là où la lecture doit commencer
   * (voir `Remuxer.open`), mais la vidéo, elle, part du début quand le fichier n'a pas d'index —
   * aucun saut n'est alors demandé, et le son restait une heure en avance sur l'image, muet. Le
   * premier segment recale donc toujours le son sur son propre début.
   */
  private transcoderSeekPending = true;
  private videoCuePointsCache: number | null = null;
  private needKeyframe = false;
  private pendingSubtitles: MediaSample[] = [];
  private clampedSamples = 0;
  private sequence = 1;
  private done = false;

  private constructor(
    private readonly file: MatroskaFile,
    private readonly videoTrack: MatroskaTrack,
    private audioTrack: MatroskaTrack | null,
    private readonly videoInfo: MuxTrackInfo,
    private audioInfo: MuxTrackInfo | null,
    /**
     * The same reader the audio probe used, not a fresh one. A second reader would restart at
     * the beginning of the file and hand back the samples the probe already consumed, which
     * duplicates the opening keyframe and shifts the entire presentation timeline.
     */
    private readonly reader: MediaSampleReader,
    private readonly source: ByteSource,
    /** Present only when the chosen track has to be re-encoded to be carried at all. */
    private transcoder: AudioTranscoder | null,
    /**
     * La chaîne annoncée pour la vidéo quand on livre du Dolby Vision, ou rien.
     *
     * Portée par le remultiplexeur, et pas recalculée ailleurs : c'est lui qui écrit l'entrée
     * d'échantillon, donc lui seul sait ce qu'elle contient. Déclarer `hvc1` en écrivant `dvh1`
     * ferait rejeter le segment d'initialisation entier — la règle de CLAUDE.md sur les boîtes qui
     * se contredisent, appliquée cette fois entre le conteneur et le type MIME.
     */
    private readonly dolbyVisionCodec: string | null = null
  ) {
    this.nalLength = nalLengthSize(videoTrack.codecId, videoTrack.codecPrivate);
  }

  static async open(
    source: ByteSource,
    file: MatroskaFile,
    videoTrack: MatroskaTrack,
    audioTrack: MatroskaTrack | null,
    dimensions: { width: number; height: number },
    /**
     * L'enregistrement Dolby Vision à porter dans l'entrée d'échantillon, ou rien.
     *
     * Décidé par le sélecteur de chemin, qui est le seul à pouvoir demander au navigateur s'il en
     * veut — voir `planDolbyVision`. Absent, la sortie est à l'octet près celle d'avant.
     */
    dolbyVision: { type: string; record: Uint8Array } | null = null,
    /**
     * Où la lecture va commencer, pour y amorcer l'encodeur audio. Il s'amorçait au début du
     * film, puis sautait : une reconstruction à une heure lisait d'abord les premières secondes
     * du fichier — 0,7 s de plus, relevées sur iPhone le 21/09/2026, pour rien.
     */
    startSeconds = 0
  ): Promise<Remuxer> {
    if (!remuxableVideo(videoTrack)) throw new Error(`Vidéo non remultiplexable : ${videoTrack.codecId}`);
    if (audioTrack && !playableAudio(audioTrack)) throw new Error(`Audio non remultiplexable : ${audioTrack.codecId}`);

    const start = file.firstClusterOffset ?? file.segmentDataStart;
    // A track that cannot ride in the container is decoded and encoded again on the way through,
    // and the encoder — not the file — is then what describes it.
    const transcoder =
      audioTrack && audioDelivery(audioTrack, file) === "transcode"
        ? await AudioTranscoder.open(source, audioTrack, startSeconds, unifiedAudioChannels(file) ?? undefined, file)
        : null;
    if (transcoder) assertContainerTakes(transcoder);
    const audioInfo = audioTrack
      ? transcoder
        ? transcodedAudioInfo(transcoder, audioTrack)
        : await describeAudio(source, file, start, audioTrack)
      : null;
    const reader = createSampleReader(source, file, start);

    const videoInfo: MuxTrackInfo = {
      id: 1,
      kind: "video",
      timescale: TIMESCALE,
      sampleEntry: videoSampleEntry(
        videoTrack.codecId,
        videoTrack.codecPrivate!,
        dimensions.width,
        dimensions.height,
        dolbyVision,
        videoTrack.video?.colour
      ),
      width: dimensions.width,
      height: dimensions.height,
      language: videoTrack.language ?? "und",
    };

    return new Remuxer(
      file,
      videoTrack,
      audioTrack,
      videoInfo,
      audioInfo,
      reader,
      source,
      transcoder,
      dolbyVision ? dolbyVisionCodecString(dolbyVision.record) : null
    );
  }

  plan(): RemuxPlan {
    const duration = this.file.durationSeconds ?? 0;
    return {
      videoMimeType: `video/mp4; codecs="${this.dolbyVisionCodec ?? videoCodecString(this.videoTrack)}"`,
      // Once there is a transcoder, it is the authority on what the audio buffer will carry:
      // `plannedMimeTypes` has to guess before one exists, and an encoder is free to answer with
      // a different profile than the one asked for.
      audioMimeType: !this.audioTrack
        ? null
        : this.transcoder
          ? `audio/mp4; codecs="${this.transcoder.codecString}"`
          : plannedMimeTypes(this.videoTrack, this.audioTrack, this.file).audio,
      videoInit: initSegment(this.videoInfo, duration),
      audioInit: this.audioInfo ? initSegment(this.audioInfo, duration) : null,
      durationSeconds: duration,
    };
  }

  /** Whether the file carries an index. Without one there is no way to reach a time directly. */
  get seekable(): boolean {
    return this.file.cues.length > 0;
  }

  /** Index entries that actually point at pictures, which is what a seek needs. */
  get videoCuePoints(): number {
    // Counted once: the technical panel reads this twice a second, and a long film's index runs
    // to several thousand entries.
    if (this.videoCuePointsCache === null) {
      this.videoCuePointsCache = this.file.cues.filter((cue) => cue.track === this.videoTrack.number).length;
    }
    return this.videoCuePointsCache;
  }

  /** The subtitle tracks this path can render — the text ones; styled formats are not handled. */
  subtitleTracks(): MatroskaTrack[] {
    return this.file.tracks.filter(
      (t) => t.type === "subtitle" && t.isEnabled && TEXT_SUBTITLE_CODECS.has(t.codecId)
    );
  }

  audioTracks(): MatroskaTrack[] {
    return this.file.tracks.filter((t) => t.type === "audio");
  }

  /** Releases the decoder and encoder a transcoded track holds. */
  close(): void {
    this.closed = true;
    // Gardé : la ligne de fin de séance peut être écrite après la fermeture.
    if (this.transcoder) this.retiredTiming.push(this.transcoder.timingStats);
    this.transcoder?.close();
    this.transcoder = null;
  }

  /**
   * Le pire écart d'horloge du son ré-encodé sur la séance, en millisecondes — voir
   * `AudioTimingStats`. Additionne ce qu'ont vu les transcodeurs déjà remplacés (changement de
   * piste, reprise après un échec) à celui qui tourne.
   */
  audioTiming(): { sourceMs: number; encoderMs: number } | null {
    const all = [...this.retiredTiming, ...(this.transcoder ? [this.transcoder.timingStats] : [])];
    if (all.length === 0) return null;
    const worst = (pick: (t: { sourceUs: number; encoderUs: number }) => number) =>
      all.map(pick).reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0);
    return {
      sourceMs: Math.round(worst((t) => t.sourceUs) / 100) / 10,
      encoderMs: Math.round(worst((t) => t.encoderUs) / 100) / 10,
    };
  }
  private retiredTiming: { sourceUs: number; encoderUs: number }[] = [];

  diagnostics(): RemuxDiagnostics {
    return {
      presentationDelaySeconds: (this.presentationDelayUs ?? 0) / TIMESCALE,
      clampedSamples: this.clampedSamples,
      transcodedAudio: this.transcoder !== null,
      transcodedCodec: this.transcoder?.codecString ?? null,
      segmentStartSeconds: this.segmentStartUs / TIMESCALE,
    };
  }

  /**
   * Restarts at the cluster containing this time. The caller must clear its source buffers.
   *
   * @param seconds a time on the *source's* clock. A caller working from the player's clock has
   *   to subtract `presentationDelaySeconds` first.
   */
  seekTo(seconds: number): void {
    const offset = clusterOffsetForTime(this.file, Math.round(seconds * 1e6), this.videoTrack.number);
    const from = offset ?? this.file.firstClusterOffset ?? this.file.segmentDataStart;
    this.reader.seekTo(from);
    // Asked for now rather than when the parser gets there. The index has just said where this
    // seek lands, and everything below — clearing the queues, resetting the timeline — takes a
    // few milliseconds during which the link would otherwise carry nothing. Measured on a dense
    // 4K file: four megabytes have to arrive before the first picture can be built, and the
    // fetching of them used to begin with one lone request on an idle connection.
    this.source.warm?.(from);
    // Deferred, not done here. Reading restarts at the indexed keyframe at or before the
    // requested time, which is regularly the best part of a second earlier — pointing the
    // transcoder at the request instead leaves that much of the segment with pictures and no
    // sound. The segment's real start is known a moment later, and that is what it is given.
    this.transcoderSeekPending = this.transcoder !== null;
    this.pendingVideo = [];
    this.pendingAudio = [];
    this.pendingSubtitles = [];
    this.strayAhead = [];
    // The group being handed over piece by piece is abandoned with everything else.
    this.emitted = 0;
    this.boundary = null;
    this.groupClosed = false;
    this.groupAnchorUs = null;
    this.needKeyframe = true;
    this.seekTargetUs = Math.round(seconds * 1e6);
    this.backupsLeft = MAX_INDEX_BACKUPS;
    this.done = false;
    this.tailDone = false;
    // Decode times restart at the seek point so the segments land where the player expects them,
    // rather than continuing a timeline that no longer matches the media.
    this.videoDecodeTime = Math.round(seconds * TIMESCALE);
  }

  /** The next pair of segments, or null once the file is exhausted. */
  /**
   * The next piece of media, handed over as soon as it is settled rather than when the keyframe
   * group it belongs to has finished arriving.
   *
   * A picture's decode time is its rank among the group's presentation times, so nothing can be
   * emitted until the pictures that might hold a smaller presentation have been read. But that is
   * a handful of pictures — the reordering depth — and not the whole group. Waiting for the group
   * meant waiting for all of it: five megabytes on an ordinary file, fifteen on the two dozen in
   * this library whose keyframes sit twenty-five seconds apart, against forty milliseconds of
   * actual muxing.
   */
  async nextSegment(): Promise<RemuxSegment | null> {
    if (!(await this.readUntilSettled())) return null;

    // Le fichier est lu jusqu'au bout et chaque image est partie : il ne reste que la fin du son
    // ré-encodé, ce qui suit la dernière image. Demandée une fois, puis `null` — c'est ce `null`
    // qui fait déclarer la fin du flux (`endOfStream`) et lever `ended`.
    if (this.done && this.transcoder && this.emitted >= this.pendingVideo.length) {
      this.tailDone = true;
      const audio = await this.buildTranscodedAudio(Infinity);
      const subtitles = this.buildSubtitles();
      this.pendingSubtitles = [];
      return { video: [], audio, subtitles, endSeconds: this.videoDecodeTime / TIMESCALE };
    }

    const video = this.buildVideo();
    // Built after the video, because the stretch it has to cover is what the video just settled.
    const audio = this.transcoder ? await this.buildTranscodedAudio() : this.buildAudio();
    const subtitles = this.buildSubtitles();
    const endUs = this.videoDecodeTime;

    this.pendingAudio = [];
    this.pendingSubtitles = [];
    return { video, audio, subtitles, endSeconds: endUs / TIMESCALE };
  }

  /** Reads until a fragment's worth of pictures is settled, or the group ends. */
  private async readUntilSettled(): Promise<boolean> {
    // A group handed over to its end starts the next one, on the keyframe that closed it.
    if (this.groupClosed && this.emitted >= this.pendingVideo.length && !this.done) {
      this.pendingVideo = this.boundary ? [this.boundary] : [];
      this.boundary = null;
      this.emitted = 0;
      this.groupClosed = false;
      this.groupAnchorUs = null;
    }

    while (!this.groupClosed && !this.settled()) {
      let sample = await this.reader.next();
      if (!sample) {
        this.done = true;
        this.groupClosed = true;
        break;
      }
      if (sample.trackNumber === this.videoTrack.number) {
        const stray = strayUnits(sample.data, this.videoTrack.codecId, this.nalLength);
        if (stray) {
          this.putBack(stray);
          continue;
        }
        if (this.strayAhead.length > 0) {
          sample = { ...sample, data: joinBytes([...this.strayAhead, sample.data]) };
          this.strayAhead = [];
        }
        if (stripHdr10Plus && this.videoTrack.codecId === "V_MPEGH/ISO/HEVC") {
          sample = { ...sample, data: withoutHdr10Plus(sample.data, this.nalLength) };
        }
        // A cluster does not have to begin on a picture a decoder can start on, and handing over
        // the ones that precede it produces a segment the browser holds but can never show —
        // which looks exactly like a seek that froze.
        if (this.needKeyframe) {
          if (!this.startsHere(sample)) {
            // Past where the viewer asked to be, still with nowhere to start: the index pointed
            // at a picture a decoder cannot begin on, and reading on would land them wherever
            // the next genuine one happens to be — up to ten seconds late. Reading from earlier
            // instead costs a few seconds of pictures nobody sees, and lands them where they
            // asked. Only ever on the file that lies: elsewhere this never runs.
            if (this.seekTargetUs !== null && sample.timestampUs > this.seekTargetUs && this.backUp()) continue;
            continue;
          }
          this.needKeyframe = false;
          this.seekTargetUs = null;
        }
        const span = this.pendingVideo.length > 0 ? sample.timestampUs - this.pendingVideo[0].timestampUs : 0;
        if (this.startsHere(sample) && span >= SEGMENT_US) {
          this.boundary = sample;
          this.groupClosed = true;
          break;
        }
        this.pendingVideo.push(sample);
      } else if (this.audioTrack && !this.transcoder && sample.trackNumber === this.audioTrack.number) {
        this.pendingAudio.push(sample);
      } else if (this.subtitleNumbers.has(sample.trackNumber)) {
        this.pendingSubtitles.push(sample);
      }
    }

    // Le son ré-encodé compte aussi, mais comme une chose qui *finit*. Écrit `&& !this.transcoder`
    // jusqu'au 22/09/2026 : avec un transcodeur, le fichier n'était jamais épuisé. Chaque appel
    // rendait un segment vide, `endOfStream` n'était jamais appelé ni `ended` levé, et au bout de
    // huit segments sans effet la source concluait que le navigateur ne retenait rien — reprise,
    // relecture des trente dernières secondes, et ainsi de suite jusqu'à l'erreur, dans le
    // générique de chaque film au son ré-encodé (DTS et AC-3 sur Chrome ; DTS, TrueHD, FLAC et
    // Opus sur iPhone).
    const spent = this.emitted >= this.pendingVideo.length && this.pendingAudio.length === 0;
    const soundSpent = !this.transcoder || this.tailDone || this.transcoder.drained === true;
    return !(this.done && spent && soundSpent);
  }

  /**
   * Whether enough has been read for the next fragment's timeline to be final.
   *
   * Past the reordering depth, what came before cannot move. The depth is measured on the first
   * group of the stream and used for every one after it — which is every seek; the first group is
   * given a generous guess instead, because there is nothing yet to measure it from.
   */
  private settled(): boolean {
    return this.pendingVideo.length - this.emitted >= FRAGMENT_SAMPLES + this.reorderLookahead() + 1;
  }

  private reorderLookahead(): number {
    return reorderLookahead(this.presentationDelayUs, this.frameDurationUs);
  }

  /** The text tracks worth collecting, worked out once and kept by number for the cue builder. */
  private get subtitleNumbers(): Map<number, MatroskaTrack> {
    if (!this.subtitleNumbersCache) {
      this.subtitleNumbersCache = new Map(this.subtitleTracks().map((t) => [t.number, t]));
    }
    return this.subtitleNumbersCache;
  }

  private buildSubtitles(): TrackedCue[] {
    if (this.pendingSubtitles.length === 0) return [];

    // Timed on the player's clock like everything else, so a line appears with the picture it
    // belongs to rather than a fifth of a second before it.
    const delay = (this.presentationDelayUs ?? 0) / TIMESCALE;
    const cues: TrackedCue[] = [];
    for (const sample of this.pendingSubtitles) {
      const track = this.subtitleNumbers.get(sample.trackNumber);
      if (!track) continue;
      const text = subtitleText(new TextDecoder().decode(sample.data), track.codecId);
      if (!text) continue;
      const startSeconds = sample.timestampUs / TIMESCALE + delay;
      cues.push({
        track: sample.trackNumber,
        startSeconds,
        endSeconds:
          startSeconds + (sample.durationUs !== null ? sample.durationUs / TIMESCALE : SUBTITLE_FALLBACK_SECONDS),
        text,
      });
    }
    return cues;
  }

  /**
   * Sound that had to be decoded and encoded again, cut to this segment.
   *
   * Asked for by time rather than handed packets: the transcoder reads the file itself, through
   * the same cache, and runs its own decode and encode pipeline. Cutting at the video segment's
   * own end is what keeps the two tracks tiling together — each segment holds exactly the sound
   * belonging to the pictures beside it.
   */
  private async buildTranscodedAudio(untilSeconds = this.videoDecodeTime / TIMESCALE): Promise<Uint8Array | null> {
    if (!this.transcoder || !this.audioInfo) return null;

    if (this.transcoderSeekPending) {
      this.transcoderSeekPending = false;
      this.transcoder.seekTo(this.segmentStartUs / TIMESCALE);
    }

    let frames: TranscodedFrame[];
    try {
      frames = await this.transcoder.framesUpTo(untilSeconds);
    } catch (error) {
      // La fin du son, derrière la dernière image : rien qui vaille une reconstruction, qui
      // repartirait du début du segment et renverrait un son déjà livré. Et un échec à cet
      // endroit ne doit pas devenir celui du film, qui se termine.
      if (untilSeconds === Infinity) {
        trace(`transcodage audio : fin du son perdue (${error instanceof Error ? error.message : String(error)})`);
        return null;
      }
      // Safari's own AAC encoder gives up from time to time — "InternalAudioEncoderCocoa encoding
      // failed" — always after a change of track, never at the start, and not reproducibly: the
      // same change succeeds on the next attempt. Nothing about the file or the configuration is
      // wrong, so ending playback over it throws away a session for someone else's hiccup. The
      // encoder is a service; it is closed and opened again where the reader stands.
      frames = await this.retryTranscoder(error);
    }
    // Fermé pendant l'attente : plus personne ne recevra ce segment.
    const transcoder = this.transcoder;
    if (!transcoder) return null;
    if (++this.goodSegments >= GOOD_SEGMENTS_TO_FORGIVE && this.encoderRestarts > 0) {
      trace(`transcodage audio : ${this.goodSegments} segments sans échec, reconstructions oubliées`);
      this.encoderRestarts = 0;
    }
    if (frames.length === 0) return null;

    const delay = this.presentationDelayUs ?? 0;
    const fallback = Math.round((1024 / transcoder.sampleRate) * TIMESCALE);
    const samples: MuxSample[] = frames.map((frame) => ({
      data: frame.data,
      decodeTime: frame.timestampUs + delay,
      duration: Math.max(1, frame.durationUs || fallback),
      compositionOffset: 0,
      isKeyframe: true,
    }));

    return mediaSegment(this.audioInfo, this.sequence, samples);
  }

  /**
   * Builds a fresh transcoder in place of one that failed, and asks it again.
   *
   * Bounded, because an encoder that refuses every time is a real possibility and retrying it for
   * ever would be a player that reads the whole film without ever producing a sound. Past the
   * limit the original failure is raised, which is the one worth reporting.
   */
  private async retryTranscoder(cause: unknown): Promise<TranscodedFrame[]> {
    const track = this.audioTrack;
    // Fermé : l'échec est celui de l'encodeur qu'on vient de fermer, pas une panne à réparer.
    if (!track || this.closed || this.encoderRestarts >= MAX_ENCODER_RESTARTS) throw cause;
    this.encoderRestarts += 1;
    this.goodSegments = 0;

    const at = this.segmentStartUs / TIMESCALE;
    // The cause is written out: this path is taken for the decoder's failures too, and on
    // 21/09/2026 three lines reading "encoder failed" hid a FLAC decoder crashing on every retry.
    const why = cause instanceof Error ? cause.message : String(cause);
    trace(`transcodage audio : chaîne en échec (${why}), reconstruction (${this.encoderRestarts}) à ${at.toFixed(1)} s`);
    const previous = this.transcoder;
    const next = await AudioTranscoder.open(this.source, track, at, unifiedAudioChannels(this.file) ?? undefined, this.file);
    // Fermé pendant l'ouverture : ce transcodeur n'aurait plus aucun propriétaire.
    if (this.closed) {
      next.close();
      throw cause;
    }
    assertContainerTakes(next);
    if (previous && (next.codecString !== previous.codecString || !sameShape(previous, next))) {
      // The buffer decodes by an initialisation segment already sent; a replacement that
      // describes itself differently cannot take over behind its back.
      next.close();
      throw cause;
    }
    if (previous) this.retiredTiming.push(previous.timingStats);
    previous?.close();
    this.transcoder = next;
    this.audioInfo = transcodedAudioInfo(next, track);
    next.seekTo(at);
    return next.framesUpTo(this.videoDecodeTime / TIMESCALE);
  }

  /** Points the reader further back, one step at a time, and says whether it moved. */
  private backUp(): boolean {
    if (this.seekTargetUs === null || this.backupsLeft <= 0) return false;
    const step = MAX_INDEX_BACKUPS - this.backupsLeft + 1;
    this.backupsLeft -= 1;
    const earlier = this.seekTargetUs - INDEX_BACKUP_US * step;
    if (earlier < 0) return false;

    const start = this.file.firstClusterOffset ?? this.file.segmentDataStart;
    const from = clusterOffsetForTime(this.file, earlier, this.videoTrack.number) ?? start;
    this.reader.seekTo(from);
    // Same reason as a seek, and this one lands somewhere colder still: twelve seconds earlier
    // in the film is a region nothing has read and nothing has fetched ahead into.
    this.source.warm?.(from);
    this.pendingVideo = [];
    this.pendingAudio = [];
    this.pendingSubtitles = [];
    this.strayAhead = [];
    trace(
      `index : rien où démarrer avant ${(this.seekTargetUs / 1e6).toFixed(1)} s, ` +
        `relecture depuis ${(earlier / 1e6).toFixed(1)} s`
    );
    return true;
  }

  private buildVideo(): Uint8Array[] {
    if (this.pendingVideo.length === 0 || this.emitted >= this.pendingVideo.length) return [];

    // The whole of the group read so far, not only the part about to be handed over: a picture's
    // decode time is its rank among these presentations, so the rank has to be taken against
    // everything known. What settles it is that the pictures beyond the fragment have been read.
    const presentations = this.pendingVideo.map((s) => s.timestampUs);
    const durations = deriveDurations(presentations, FALLBACK_FRAME_US);

    // Anchored on this group's own earliest picture, not on where the previous one's decode
    // timeline happened to stop. Chaining them looks natural and is wrong: the keyframe that
    // opens a group is first in *decode* order, and several pictures decoded after it are shown
    // before it, so it is not the group's earliest presentation. Anchoring on the keyframe
    // therefore pushed every segment after the first later by that gap — a fifth of a second on a
    // real 4K file, which is the picture drifting away from the sound.
    //
    // Fixed the first time this group is built, and kept. The reordering depth guarantees no
    // picture read later can be shown earlier than one already handed over, so re-deriving it
    // would give the same answer — and if it ever did not, the timeline would move underneath
    // media the browser is already holding.
    this.groupAnchorUs ??= Math.min(...presentations);
    this.segmentStartUs = this.groupAnchorUs;
    const ordered = assignDecodeTimes(
      presentations.map((presentation, i) => ({ presentation, duration: durations[i] })),
      this.segmentStartUs
    );

    // Measured once, on the opening group, then fixed for the whole stream. The audio timeline is
    // moved by the same amount at the same moment, which is the only thing keeping the picture on
    // the sound: shifting the video alone is the classic lip-sync error in a remux.
    if (this.presentationDelayUs === null) {
      this.frameDurationUs = durations[0] || FALLBACK_FRAME_US;
      this.presentationDelayUs = ordered.presentationDelay + DELAY_MARGIN_FRAMES * this.frameDurationUs;
    }
    const delay = this.presentationDelayUs;

    // Only what the reading has settled, and only a fragment of it at a time.
    const from = this.emitted;
    const until = this.groupClosed
      ? this.pendingVideo.length
      : Math.min(this.pendingVideo.length - this.reorderLookahead() - 1, from + FRAGMENT_SAMPLES);
    if (until <= from) return [];

    const samples: MuxSample[] = [];
    for (let i = from; i < until; i++) {
      const sample = this.pendingVideo[i];
      const offset = ordered.samples[i].compositionOffset + delay;
      // A negative offset here would mean this group reorders more deeply than the opening one
      // did. Clamping costs one picture shown a frame early; widening the delay instead would
      // break the timeline everywhere before this point.
      if (offset < 0) this.clampedSamples += 1;
      samples.push({
        data: sample.data,
        decodeTime: ordered.samples[i].decode,
        duration: ordered.samples[i].duration,
        compositionOffset: Math.max(0, offset),
        // The container's word is not enough here either: telling a player that a trailing
        // picture is a sync sample invites it to start decoding there.
        isKeyframe: this.startsHere(sample),
      });
    }
    this.emitted = until;

    // Where the sound is cut: the end of what has just been handed over, not the end of a group
    // that may still be arriving.
    this.videoDecodeTime =
      until >= this.pendingVideo.length ? ordered.endDecodeTime : ordered.samples[until].decode;

    return this.fragmentise(samples);
  }

  /**
   * Cuts one keyframe group's samples into several fragments.
   *
   * A fragment does not have to be a whole keyframe group — that is what a CMAF chunk is, and
   * what every low-latency packager produces. The group has to be *computed* whole, though, and
   * that is why this happens here and not in the reader: the decode timeline is recovered by
   * sorting a group's presentation times, which only works for a group reordering cannot cross.
   * Cut the samples before that and a B-picture's decode time comes out wrong, which is drift.
   *
   * What it buys: this library's keyframes sit anywhere from nothing to ten seconds apart, so a
   * group can be eight megabytes of pictures handed over in one call. Safari answers one of those
   * — nine seconds, 228 samples, 5.5 MB, at 1951 s of a real file — by closing the MediaSource
   * with "media failed to decode", the same bytes every time.
   */
  private fragmentise(samples: MuxSample[]): Uint8Array[] {
    return planFragments(samples.length, (i) => samples[i].data.byteLength).map((indices) => {
      const from = indices[0];
      const to = indices[indices.length - 1] + 1;
      // The final sample of a fragment states the gap to the next sample's decode time, and at a
      // boundary that sample lives in the next fragment. Reading its own duration there instead
      // leaves the buffered range short of where the next fragment begins — invisible at a
      // constant frame rate, which is exactly how the same mistake hid for a day last time.
      const next = to < samples.length ? samples[to].decodeTime : undefined;
      const segment = mediaSegment(this.videoInfo, this.sequence, samples.slice(from, to), next);
      this.sequence += 1;
      return segment;
    });
  }

  private buildAudio(): Uint8Array | null {
    if (!this.audioInfo || this.pendingAudio.length === 0) return null;

    // Audio is never reordered, so there is nothing to reconstruct — but there is something to
    // undo. Matroska laces: one block holds several audio frames, and every frame in it carries
    // the block's timestamp. Eight E-AC-3 frames sharing one timestamp is normal. Taking the gap
    // between consecutive frames as their duration therefore yields zero for most of them, and
    // the sound then plays far faster than the picture.
    const runs: { timestamp: number; frames: MediaSample[] }[] = [];
    for (const sample of this.pendingAudio) {
      const last = runs[runs.length - 1];
      if (last && last.timestamp === sample.timestampUs) last.frames.push(sample);
      else runs.push({ timestamp: sample.timestampUs, frames: [sample] });
    }

    const delay = this.presentationDelayUs ?? 0;
    const samples: MuxSample[] = [];
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      const next = runs[r + 1];
      // The distance to the next block, split across the frames packed into this one, is the
      // frame duration — no knowledge of the codec's block layout needed. The last run of a
      // segment has no successor, so it reuses the duration measured from the runs before it.
      const frameDuration = next
        ? (next.timestamp - run.timestamp) / run.frames.length
        : (this.audioFrameUs ?? FALLBACK_AUDIO_FRAME_US);
      if (next && run.frames.length > 0) this.audioFrameUs = frameDuration;

      for (let i = 0; i < run.frames.length; i++) {
        // Re-anchored on the block's own timestamp rather than accumulated from the previous
        // segment, so a rounding error cannot build up into audible drift over a two-hour film.
        const decode = Math.round(run.timestamp + i * frameDuration) + delay;
        samples.push({
          data: run.frames[i].data,
          decodeTime: decode,
          duration: Math.max(1, Math.round(frameDuration)),
          compositionOffset: 0,
          isKeyframe: true,
        });
      }
    }

    return mediaSegment(this.audioInfo, this.sequence, samples);
  }
}

export const __testing = {
  planFragments,
  /** Pictures that must be read before the next fragment can be handed over. */
  settledAfter: (delayUs: number | null, frameUs: number | null) =>
    FRAGMENT_SAMPLES + reorderLookahead(delayUs, frameUs) + 1,
};
