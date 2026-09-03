// ManagedMediaSource, Apple's MediaSource variant, shipped in iOS 17.1 and not yet in the DOM lib.
//
// It exists because MediaSource proper was withheld from iPhones for years: the plain API lets a
// page buffer as much as it likes, which Apple was unwilling to allow. The managed version hands
// that decision to the system — it tells the page when to stream and when to stop, and may evict
// buffered media on its own — and in exchange it works on the phone.

interface ManagedSourceBuffer extends SourceBuffer {}

declare class ManagedMediaSource extends EventTarget {
  static isTypeSupported(type: string): boolean;
  readonly sourceBuffers: SourceBufferList;
  readonly activeSourceBuffers: SourceBufferList;
  readonly readyState: "closed" | "open" | "ended";
  duration: number;
  /** True while the system wants the page to fetch. Ignoring it is what gets a page throttled. */
  readonly streaming: boolean;
  addSourceBuffer(type: string): ManagedSourceBuffer;
  removeSourceBuffer(buffer: SourceBuffer): void;
  endOfStream(error?: "network" | "decode"): void;
  setLiveSeekableRange(start: number, end: number): void;
  clearLiveSeekableRange(): void;
  onsourceopen: ((this: ManagedMediaSource, ev: Event) => unknown) | null;
  onstartstreaming: ((this: ManagedMediaSource, ev: Event) => unknown) | null;
  onendstreaming: ((this: ManagedMediaSource, ev: Event) => unknown) | null;
}

interface Window {
  ManagedMediaSource?: typeof ManagedMediaSource;
}

interface HTMLMediaElement {
  /** Required before a ManagedMediaSource will attach: AirPlay cannot carry a managed stream. */
  disableRemotePlayback: boolean;
}

/**
 * Frame-accurate notification that a picture has been presented — in Safari since 15.4 and in
 * Chromium, but not yet in the DOM lib. It is the only signal that says "the image moved": the
 * playing event fires before playback has actually begun, and timeupdate arrives about four
 * times a second, long after.
 */
interface VideoFrameCallbackMetadata {
  presentationTime: number;
  expectedDisplayTime: number;
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
}

interface HTMLVideoElement {
  requestVideoFrameCallback?(
    callback: (now: number, metadata: VideoFrameCallbackMetadata) => void
  ): number;
  cancelVideoFrameCallback?(handle: number): void;
}
