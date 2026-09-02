// The remux path, assembled: file in, a playing <video> element out.
//
// Deliberately shaped like the WebCodecs engine's public surface — same track lists, same track
// selection, same subtitle lookup — so the player component branches once on which path was
// chosen and not again on every operation.

import { HttpByteSource } from "./byteSource";
import { selectCue, type EngineTrack, type SubtitleCue } from "./engine";
import { parseMatroska, type MatroskaFile, type MatroskaTrack } from "./matroska";
import { MseSource } from "./mseSource";
import { choosePlaybackPath, describePath, type ChosenPath } from "./pathSelector";
import { Remuxer } from "./remuxer";

/** Cues more than this far behind the playhead are dropped: a three-hour film is a lot of lines. */
const CUE_HISTORY_SECONDS = 60;

export interface RemuxPlaybackOptions {
  streamUrl: string;
  startSeconds: number;
  onError: (message: string) => void;
  onWarning?: (message: string) => void;
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

function preferredAudio(file: MatroskaFile): MatroskaTrack | null {
  const audio = file.tracks.filter((t) => t.type === "audio");
  return audio.find((t) => t.isDefault) ?? audio[0] ?? null;
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
  private cues: SubtitleCue[] = [];
  private currentSubtitle: number | null = null;
  private destroyed = false;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly source: HttpByteSource,
    private readonly file: MatroskaFile,
    private readonly videoTrack: MatroskaTrack,
    private audioTrack: MatroskaTrack | null,
    private remuxer: Remuxer,
    private readonly chosen: ChosenPath,
    private readonly options: RemuxPlaybackOptions
  ) {}

  static async start(
    video: HTMLVideoElement,
    source: HttpByteSource,
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
        onSubtitles: (cues) => this.collect(cues),
      },
      // Handed in rather than seeked to afterwards, so the first read happens where the viewer
      // is resuming instead of at the beginning of the file.
      startSeconds
    );
  }

  private collect(cues: SubtitleCue[]): void {
    this.cues.push(...cues);
    const oldest = this.video.currentTime - CUE_HISTORY_SECONDS;
    if (this.cues.length > 400) this.cues = this.cues.filter((cue) => cue.endSeconds >= oldest);
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

  subtitleAt(seconds: number): string | null {
    if (this.currentSubtitle === null) return null;
    return selectCue(this.cues, seconds)?.text ?? null;
  }

  selectSubtitleTrack(trackNumber: number | null): void {
    this.currentSubtitle = trackNumber;
    this.cues = [];
    this.remuxer.setSubtitleTrack(trackNumber);
    // Cues arrive with the segments, so the ones for the stretch already buffered have gone by.
    // Re-reading from where we are is what makes the change take effect now rather than in two
    // seconds' time.
    void this.mse?.seek(this.video.currentTime);
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
    // Nothing may be reading while the remuxer is re-pointed, or one segment would end up
    // describing one track and carrying another's samples.
    await this.mse.quiesce();
    await this.remuxer.setAudioTrack(trackNumber);
    this.audioTrack = track;

    const plan = this.remuxer.plan();
    await this.mse.replaceAudio(plan.audioMimeType, plan.audioInit);
    // Refills from where the viewer is, so the new language starts at the picture on screen
    // rather than wherever the reader happened to have got to.
    await this.mse.seek(at);
  }

  seek(seconds: number): Promise<void> {
    return this.mse?.seek(seconds) ?? Promise.resolve();
  }

  get diagnostics(): Record<string, string> {
    const remux = this.remuxer.diagnostics();
    const buffered = this.video.buffered;
    return {
      Chemin: describePath(this.chosen),
      Décodage: "matériel, par le navigateur",
      Vidéo: `${this.videoTrack.codecId} ${this.videoTrack.video?.width ?? "?"}×${this.videoTrack.video?.height ?? "?"}`,
      Audio: this.audioTrack ? `${this.audioTrack.codecId} ${this.audioTrack.audio?.channels ?? "?"} canaux` : "aucune",
      "Décalage de présentation": `${(remux.presentationDelaySeconds * 1000).toFixed(0)} ms`,
      "Images recalées": String(remux.clampedSamples),
      Tampon: buffered.length > 0 ? `${(buffered.end(buffered.length - 1) - this.video.currentTime).toFixed(1)} s d'avance` : "vide",
      "Sous-titres en mémoire": String(this.cues.length),
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.mse?.destroy();
    this.mse = null;
    this.source.close();
  }
}
