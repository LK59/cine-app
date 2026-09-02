// A façade that makes the WebCodecs engine look like a <video> element.
//
// The point is to leave PlayerControls alone. Those 1300 lines encode a great deal of
// hard-earned behaviour — menu focus handling, seek-bar commit semantics, the mobile gestures —
// and forking them for a second player would mean maintaining two of everything and letting them
// drift. Instead the engine grows the small surface the controls actually touch, measured rather
// than guessed: currentTime, duration, paused, volume, muted, playbackRate, buffered, textTracks,
// play/pause, and add/removeEventListener.
//
// Everything the controls only use behind a feature check (remote playback, AirPlay's picker) is
// deliberately absent, so those features disable themselves the way they already do on a browser
// that lacks them.

import type { PlaybackEngine } from "./engine";

type Listener = EventListenerOrEventListenerObject;

function call(listener: Listener, event: Event): void {
  if (typeof listener === "function") listener(event);
  else listener.handleEvent(event);
}

export class MediaElementFacade {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly unsubscribes: (() => void)[] = [];
  private rate = 1;

  constructor(private readonly engine: PlaybackEngine) {
    // Engine events are re-emitted under the DOM names the controls already listen for, so the
    // same handlers work unchanged.
    const forward = (engineEvent: Parameters<PlaybackEngine["on"]>[0], domEvent: string) => {
      this.unsubscribes.push(engine.on(engineEvent, () => this.dispatch(domEvent)));
    };
    forward("playing", "play");
    forward("playing", "playing");
    forward("pause", "pause");
    forward("waiting", "waiting");
    forward("ended", "ended");
    forward("timeupdate", "timeupdate");
    forward("loadedmetadata", "loadedmetadata");
    forward("loadedmetadata", "durationchange");
  }

  private dispatch(type: string): void {
    const event = new Event(type);
    for (const listener of this.listeners.get(type) ?? []) call(listener, event);
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  get currentTime(): number {
    return this.engine.currentTime;
  }

  set currentTime(seconds: number) {
    void this.engine.seek(seconds);
  }

  get duration(): number {
    return this.engine.duration;
  }

  get paused(): boolean {
    return this.engine.paused;
  }

  get volume(): number {
    return this.engine.volume;
  }

  set volume(value: number) {
    this.engine.setVolume(value, this.engine.muted);
    this.dispatch("volumechange");
  }

  get muted(): boolean {
    return this.engine.muted;
  }

  set muted(value: boolean) {
    this.engine.setVolume(this.engine.volume, value);
    this.dispatch("volumechange");
  }

  get playbackRate(): number {
    return this.rate;
  }

  set playbackRate(value: number) {
    // Accepted and reported back so the speed menu stays consistent, but the engine plays at 1x
    // for now: varying the rate means resampling the audio, and a pitch-shifted soundtrack is a
    // worse answer than an honest "not yet".
    this.rate = value;
    this.dispatch("ratechange");
  }

  /**
   * What the engine has decoded ahead, in the shape the seek bar reads. One range starting at 0
   * is a simplification — the engine only ever buffers forward from the playhead — and it is the
   * shape the controls already handle.
   */
  get buffered(): TimeRanges {
    const end = this.engine.currentTime;
    return {
      length: 1,
      start: () => 0,
      end: () => end,
    } as unknown as TimeRanges;
  }

  /** Subtitles are rendered by the engine, not by the element, so this stays empty. */
  get textTracks(): TextTrackList {
    return { length: 0, [Symbol.iterator]: function* () {} } as unknown as TextTrackList;
  }

  play(): Promise<void> {
    return this.engine.play();
  }

  pause(): void {
    this.engine.pause();
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.listeners.clear();
  }
}

/**
 * The controls are typed against HTMLVideoElement. This is the one place that lie is told, and it
 * is told explicitly rather than by typing the controls loosely — which would weaken them for the
 * stable player too.
 */
export function asVideoElement(facade: MediaElementFacade): HTMLVideoElement {
  return facade as unknown as HTMLVideoElement;
}
