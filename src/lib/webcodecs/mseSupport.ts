// What this browser will actually take, asked rather than assumed.
//
// Every answer here is a question put to the platform at runtime. None of it can be answered from
// a list: an iPhone takes AC-3 inside a MediaSource and Chrome takes none at all, Firefox plays
// AAC and cannot encode a byte of it, and a browser that accepts an API call is not the same as
// one that does something useful with it.
//
// There used to be one more probe here — will this browser let the audio buffer be swapped
// mid-playback? Safari said yes and then played silence, so the answer was measured and ignored.
// Removed on 2026-09-22 with the in-buffer track change it served: every track change now
// rebuilds the player.

import type { RemuxPlan } from "./remuxer";

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
