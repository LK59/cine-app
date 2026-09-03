// The remux path, assembled: file in, a playing <video> element out.
//
// Deliberately shaped like the WebCodecs engine's public surface — same track lists, same track
// selection, same subtitle lookup — so the player component branches once on which path was
// chosen and not again on every operation.

import { HttpByteSource, type ByteSource } from "./byteSource";
import type { EngineTrack } from "./engine";
import { parseMatroska, type MatroskaFile, type MatroskaTrack } from "./matroska";
import { MseSource } from "./mseSource";
import { choosePlaybackPath, describePath, type ChosenPath } from "./pathSelector";
import { Remuxer, playableAudio, type TrackedCue } from "./remuxer";

/** Cues more than this far behind the playhead are dropped: a three-hour film is a lot of lines. */
const CUE_HISTORY_SECONDS = 60;

/**
 * And this far ahead of it.
 *
 * Keeping only a window behind is not enough once seeking is involved: jump backwards and every
 * line gathered further along the film is still "ahead", so nothing is ever dropped and the list
 * grows with each seek. A window on both sides bounds it whatever the viewer does.
 */
const CUE_FUTURE_SECONDS = 120;

export interface RemuxPlaybackOptions {
  streamUrl: string;
  startSeconds: number;
  onError: (message: string) => void;
  onWarning?: (message: string) => void;
  /** Play pressed and the clock not yet moving, or null once it is. See MseCallbacks. */
  onStarting?: (startedAt: number | null) => void;
}

export type PathProbe =
  | { path: "remux"; start: (video: HTMLVideoElement) => Promise<RemuxPlayback> }
  | { path: "webcodecs"; chosen: ChosenPath };

function toEngineTrack(track: MatroskaTrack): EngineTrack {
  return {
    number: track.number,
    codecId: track.codecId,
    language: track.language,
    name: track.name,
    isDefault: track.isDefault,
    isForced: track.isForced,
  };
}

/**
 * The audio track to open on.
 *
 * A track this path can carry comes before the file's own default, because those two disagree
 * more often than one would think: a release marks its highest-quality track as default, and
 * that is regularly DTS — which no browser decodes. Every DTS file in this library carries an
 * AC-3 or AAC track beside it, so preferring the default would refuse, on a technicality, a file
 * that plays perfectly on the track next to it. The default still decides among the ones that
 * work, and if none do the default is returned anyway so the refusal names the real codec.
 */
function preferredAudio(file: MatroskaFile): MatroskaTrack | null {
  const audio = file.tracks.filter((t) => t.type === "audio");
  const playable = audio.filter(playableAudio);
  // Nothing here works: the file's own default is returned so the refusal names its real codec.
  if (playable.length === 0) return audio.find((t) => t.isDefault) ?? audio[0] ?? null;

  const preferred = audio.find((t) => t.isDefault) ?? audio[0];
  const language = preferred?.language ?? null;
  // Language first, then channel count. On this library the default track is regularly DTS in one
  // language with only a stereo track beside it in another — silently switching language is a
  // worse surprise than dropping from surround to stereo, so the language is held onto and the
  // richest track in it wins. The menu still offers everything.
  const sameLanguage = playable.filter((t) => t.language === language);
  const pool = sameLanguage.length > 0 ? sameLanguage : playable;
  return pool.reduce((best, t) => ((t.audio?.channels ?? 0) > (best.audio?.channels ?? 0) ? t : best), pool[0]);
}

/**
 * Works out how this file should be played, without committing to it.
 *
 * The header is read here and, on the WebCodecs path, read again by the engine. That is a handful
 * of ranged requests against a cache, paid only on the path that is already the slower of the
 * two — much cheaper than reshaping the engine to accept a file someone else parsed, which is a
 * thousand lines of working code this has no business destabilising.
 */
export async function probePlaybackPath(options: RemuxPlaybackOptions): Promise<PathProbe> {
  const source = await HttpByteSource.open(options.streamUrl);
  const file = await parseMatroska(source);

  const videoTrack = file.tracks.find((t) => t.type === "video");
  if (!videoTrack) throw new Error("Ce fichier ne contient aucune piste vidéo.");
  const audioTrack = preferredAudio(file);

  const chosen = await choosePlaybackPath({
    source,
    file,
    videoTrack,
    audioTrack,
    dimensions: { width: videoTrack.video?.width ?? 1920, height: videoTrack.video?.height ?? 1080 },
  });

  if (chosen.path !== "remux" || !chosen.remuxer || !chosen.plan) {
    source.close();
    return { path: "webcodecs", chosen };
  }

  return {
    path: "remux",
    start: (video) => RemuxPlayback.start(video, source, file, videoTrack, audioTrack, chosen, options),
  };
}

export class RemuxPlayback {
  private mse: MseSource | null = null;
  private cues: TrackedCue[] = [];
  private currentSubtitle: number | null = null;
  private destroyed = false;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly source: ByteSource,
    private readonly file: MatroskaFile,
    private readonly videoTrack: MatroskaTrack,
    private audioTrack: MatroskaTrack | null,
    private remuxer: Remuxer,
    private readonly chosen: ChosenPath,
    private readonly options: RemuxPlaybackOptions
  ) {}

  static async start(
    video: HTMLVideoElement,
    source: ByteSource,
    file: MatroskaFile,
    videoTrack: MatroskaTrack,
    audioTrack: MatroskaTrack | null,
    chosen: ChosenPath,
    options: RemuxPlaybackOptions
  ): Promise<RemuxPlayback> {
    const playback = new RemuxPlayback(video, source, file, videoTrack, audioTrack, chosen.remuxer!, chosen, options);
    await playback.attach(chosen.plan!, options.startSeconds);
    return playback;
  }

  private async attach(plan: Parameters<typeof MseSource.attach>[2], startSeconds: number): Promise<void> {
    this.mse = await MseSource.attach(
      this.video,
      this.remuxer,
      plan,
      {
        onError: this.options.onError,
        onWarning: this.options.onWarning,
        onStarting: this.options.onStarting,
        onSubtitles: (cues) => this.collect(cues),
      },
      // Handed in rather than seeked to afterwards, so the first read happens where the viewer
      // is resuming instead of at the beginning of the file.
      startSeconds
    );
  }

  private collect(cues: TrackedCue[]): void {
    this.cues.push(...cues);
    if (this.cues.length <= 600) return;
    const now = this.video.currentTime;
    this.cues = this.cues.filter(
      (cue) => cue.endSeconds >= now - CUE_HISTORY_SECONDS && cue.startSeconds <= now + CUE_FUTURE_SECONDS
    );
  }

  get audioTracks(): EngineTrack[] {
    return this.remuxer.audioTracks().map(toEngineTrack);
  }

  get subtitleTracks(): EngineTrack[] {
    return this.remuxer.subtitleTracks().map(toEngineTrack);
  }

  get currentAudioTrack(): number | null {
    return this.audioTrack?.number ?? null;
  }

  get currentSubtitleTrack(): number | null {
    return this.currentSubtitle;
  }

  /**
   * Scanned in place, on purpose.
   *
   * This is asked several times a second while a film plays. Filtering to the chosen track first
   * allocated a fresh array of every line held, every time — and handed it to a helper that
   * prunes its argument as it goes, so the pruning was thrown away with the copy. A direct scan
   * allocates nothing and does not care that seeking leaves the lines out of order.
   */
  subtitleAt(seconds: number): string | null {
    const track = this.currentSubtitle;
    if (track === null) return null;
    for (const cue of this.cues) {
      if (cue.track === track && cue.startSeconds <= seconds && seconds <= cue.endSeconds) return cue.text;
    }
    return null;
  }

  /**
   * Changing subtitles is a change of filter and nothing else.
   *
   * Every text track's lines are already in hand, so there is nothing to fetch and nothing to
   * disturb. Re-reading the file for the newly chosen track — which is what this did first —
   * meant re-appending media the browser had already played, and it catches that up at speed:
   * choosing a subtitle came with a second of fast-forward before playback settled.
   */
  selectSubtitleTrack(trackNumber: number | null): void {
    this.currentSubtitle = trackNumber;
  }

  /**
   * Changes audio language without interrupting the picture.
   *
   * Only the description of the sound and which samples are picked out of the stream change; the
   * MediaSource, the video source buffer and the element itself are left alone. Tearing the whole
   * thing down and rebuilding it — which is what this did first — detaches the element, and on
   * Safari it does not reliably come back: playback simply stops.
   */
  async selectAudioTrack(trackNumber: number): Promise<void> {
    const track = this.file.tracks.find((t) => t.number === trackNumber && t.type === "audio");
    if (!track || this.destroyed || track.number === this.audioTrack?.number || !this.mse) return;

    const at = this.video.currentTime;
    const mse = this.mse;
    // One indivisible step. Describing the new track, re-pointing the buffer and refilling are
    // three operations on the same buffers, and a seek landing between any two of them reaches
    // those buffers from the other side — which is the freeze seen when changing language just
    // as a seek was settling.
    await mse.runExclusive(async () => {
      await this.remuxer.setAudioTrack(trackNumber);
      this.audioTrack = track;
      const plan = this.remuxer.plan();
      await mse.replaceAudio(plan.audioMimeType, plan.audioInit);
    });
    // Only the sound is read again, and only from where the viewer is. An ordinary seek would
    // clear the picture too and send it back over what has already been played, which the
    // browser catches up on at speed.
    await mse.refillAudio(at);
  }

  seek(seconds: number): Promise<void> {
    return this.mse?.seek(seconds) ?? Promise.resolve();
  }

  get diagnostics(): Record<string, string> {
    const remux = this.remuxer.diagnostics();
    return {
      Chemin: describePath(this.chosen),
      Décodage: "matériel, par le navigateur",
      Vidéo: `${this.videoTrack.codecId} ${this.videoTrack.video?.width ?? "?"}×${this.videoTrack.video?.height ?? "?"}`,
      Audio: this.audioTrack ? `${this.audioTrack.codecId} ${this.audioTrack.audio?.channels ?? "?"} canaux` : "aucune",
      // Worth stating plainly: on this path the sound is the one thing that may not be the
      // file's own bytes, and knowing which of the two is happening explains everything else.
      "Traitement audio": remux.transcodedAudio ? "décodé puis ré-encodé en AAC" : "copié tel quel",
      "Décalage de présentation": `${(remux.presentationDelaySeconds * 1000).toFixed(0)} ms`,
      "Images recalées": String(remux.clampedSamples),
      Index: `${this.remuxer.videoCuePoints} points vidéo / ${this.file.cues.length}`,
      // The spans themselves, not one number derived from them. A single figure hid which range
      // it was measured against, and read as a large negative number while the player was in
      // fact working correctly on a range it had not been told about.
      ...(this.mse?.debug ?? {}),
      "Sous-titres en mémoire": String(this.cues.length),
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mse?.destroy();
    this.mse = null;
    // Releases the software decoder and the encoder, when the sound was going through both.
    this.remuxer.close();
    this.source.close();
  }
}
