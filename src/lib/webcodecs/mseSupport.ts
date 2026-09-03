// What this browser will actually take, asked rather than assumed.
//
// Every answer here is a question put to the platform at runtime. None of it can be answered from
// a list: an iPhone takes AC-3 inside a MediaSource and Chrome takes none at all, Firefox plays
// AAC and cannot encode a byte of it, and a browser that accepts an API call is not the same as
// one that does something useful with it — which is why the last function here exists and why
// its answer is measured and then not believed.

import type { RemuxPlan } from "./remuxer";

/** A source that has not opened by now is not going to answer the rebuild question either. */
const PROBE_TIMEOUT_MS = 300;

export type MediaSourceCtor = typeof MediaSource | typeof ManagedMediaSource;

export function sourceConstructor(): MediaSourceCtor | null {
  if (typeof window === "undefined") return null;
  // Preferred on iPhone: plain MediaSource is absent there, and the managed one lets the system
  // evict buffered media under pressure instead of the tab being killed.
  return window.ManagedMediaSource ?? (typeof MediaSource !== "undefined" ? MediaSource : null);
}

/** Whether the player will take this codec inside a MediaSource, which is not the same question
 * as whether it can decode the codec at all: Chrome plays AC-3 nowhere, Safari plays it in both. */
export function containerAccepts(mimeType: string): boolean {
  const Source = sourceConstructor();
  if (!Source) return false;
  try {
    return Source.isTypeSupported(mimeType);
  } catch {
    return false;
  }
}

/**
 * Whether this browser will let an audio buffer be taken out and a new one put in its place,
 * mid-playback, without losing the MediaSource.
 *
 * The third of three ways to change what the sound decodes by, and the only one not yet tried.
 * `changeType` is accepted here and then answered with a decode failure that closes the source;
 * rebuilding the whole MediaSource detaches the element, and Safari does not reliably come back.
 * Removing one source buffer and adding another keeps both the element and the picture's buffer.
 *
 * Asked of a throwaway source on a detached element — which never has to be in the document to
 * reach "open" — so the answer costs a few milliseconds once, and no guess is made on behalf of
 * a browser nobody has tested.
 */
let rebuildAnswer: Promise<boolean> | null = null;

/** Candidates for the probe below, in the order they are worth trying. */
const AUDIO_PROBE_TYPES = [
  'audio/mp4; codecs="mp4a.40.2"',
  'audio/mp4; codecs="ac-3"',
  'audio/mp4; codecs="opus"',
  'audio/mp4; codecs="ec-3"',
];

export function canRebuildAudioBuffer(videoMime: string): Promise<boolean> {
  rebuildAnswer ??= (async () => {
    const Source = sourceConstructor();
    // No document means no element to attach a source to, and a source that never opens cannot
    // answer this. Nothing is guessed on its behalf.
    if (!Source || typeof document === "undefined") return false;

    // Two types this browser actually takes, chosen here rather than named in advance. Asking an
    // iPhone to swap to Opus — which it does not accept in a MediaSource at all — made
    // addSourceBuffer throw over the codec rather than over the swap, and the answer came back
    // "no" to a question that was never put. With fewer than two, no file can change audio codec
    // mid-playback anyway, so there is nothing to refuse.
    const usable = AUDIO_PROBE_TYPES.filter((type) => containerAccepts(type));
    if (usable.length < 2) return true;
    const [first, second] = usable;
    const video = document.createElement("video");
    video.disableRemotePlayback = true;
    const source = new Source();
    try {
      const opened = new Promise<boolean>((resolve) => {
        source.addEventListener("sourceopen", () => resolve(true), { once: true });
        setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
      });
      (video as unknown as { srcObject: unknown }).srcObject = source;
      if (!(await opened)) return false;

      // The picture's buffer is there for realism: an implementation may treat the last buffer
      // leaving differently from one of two.
      source.addSourceBuffer(videoMime);
      const audio = source.addSourceBuffer(first);
      source.removeSourceBuffer(audio);
      source.addSourceBuffer(second);
      return true;
    } catch {
      return false;
    } finally {
      try {
        (video as unknown as { srcObject: unknown }).srcObject = null;
      } catch {
        /* nothing left to detach */
      }
    }
  })();
  return rebuildAnswer;
}

/** Whether this browser can play what the remuxer would produce, checked before any work starts. */
export function playabilityOf(plan: RemuxPlan): { ok: true } | { ok: false; reason: string } {
  const Source = sourceConstructor();
  if (!Source) return { ok: false, reason: "Ce navigateur ne propose pas MediaSource." };
  if (!Source.isTypeSupported(plan.videoMimeType)) {
    return { ok: false, reason: `Vidéo non prise en charge par ce navigateur : ${plan.videoMimeType}` };
  }
  if (plan.audioMimeType && !Source.isTypeSupported(plan.audioMimeType)) {
    return { ok: false, reason: `Audio non pris en charge par ce navigateur : ${plan.audioMimeType}` };
  }
  return { ok: true };
}
