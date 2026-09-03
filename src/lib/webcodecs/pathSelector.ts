// Which way to play this file, and why.
//
// There are two working paths and they are not equivalent. Ranking them here, in one place, keeps
// the reasoning out of the player and makes the choice something that can be shown to the viewer
// rather than guessed at from the symptoms.
//
//   1. Remux to fragmented MP4 and hand it to a real <video>.
//      The browser decodes in hardware, composites the picture itself, drives its own audio
//      clock, and displays HDR natively. No pixel and no audio sample passes through JavaScript.
//      This is better on every axis that matters — battery, heat, smoothness, colour — and the
//      only reason it is not the sole path is that it can only carry codecs the browser accepts.
//
//   2. Decode with WebCodecs and paint a canvas.
//      Works where the first cannot: an audio codec the browser will not accept in an MP4 but
//      that can be decoded in software, or a container the remuxer does not handle. It costs a
//      per-frame JavaScript loop, tone mapping in a shader for HDR, and a hand-run audio clock.
//
//   3. Neither. Say so, name the codec, and stop.
//
// What is deliberately absent is a silent fallback. A player that quietly drops from the first
// path to the second looks like it works and hides that the good path never ran — which is
// exactly how a performance problem stays invisible for months.

import type { ByteSource } from "./byteSource";
import { unsupportedReason } from "./codecConfig";
import type { MatroskaFile, MatroskaTrack } from "./matroska";
import { playabilityOf } from "./mseSource";
import { canEncodeAac } from "./audioTranscode";
import { Remuxer, audioDelivery, plannedMimeTypes, playableAudio, remuxableVideo, type RemuxPlan } from "./remuxer";

/** Placeholder for the playability probe, which only ever reads the MIME strings. */
const EMPTY = new Uint8Array(0);

export type PlaybackPathName = "remux" | "webcodecs";

export interface PathAttempt {
  path: PlaybackPathName;
  ok: boolean;
  /** Why this path was not taken. Shown in the technical panel, never swallowed. */
  reason?: string;
}

export interface ChosenPath {
  path: PlaybackPathName;
  /** Present only when the chosen path is the remux one. */
  remuxer: Remuxer | null;
  plan: RemuxPlan | null;
  /** Every path considered, in rank order, with the reason each was rejected. */
  attempts: PathAttempt[];
}

export interface PathInput {
  source: ByteSource;
  file: MatroskaFile;
  videoTrack: MatroskaTrack;
  audioTrack: MatroskaTrack | null;
  dimensions: { width: number; height: number };
}

/** Why the remux path cannot carry this file, or null if it can. */
async function tryRemux(input: PathInput): Promise<{ remuxer: Remuxer; plan: RemuxPlan } | string> {
  const { file, videoTrack, audioTrack, dimensions, source } = input;

  if (!remuxableVideo(videoTrack)) return `vidéo ${videoTrack.codecId} non remultiplexable`;
  if (audioTrack && !playableAudio(audioTrack)) return `audio ${audioTrack.codecId} non remultiplexable`;

  // Asked before a megabyte and a half of decoder is fetched. A track that has to be re-encoded
  // is only carried here if this browser will do the encoding, and finding that out afterwards
  // would mean paying for the download to learn it.
  if (audioTrack && audioDelivery(audioTrack) === "transcode") {
    const rate = audioTrack.audio?.sampleRate ?? 48000;
    const channels = audioTrack.audio?.channels ?? 2;
    if (!(await canEncodeAac(rate, channels))) {
      return `ce navigateur n'accepte pas ${audioTrack.codecId} et n'encode pas l'AAC en ${channels} canaux`;
    }
  }

  // Asked before anything is opened. Describing an AC-3 track means reading a frame out of the
  // file, and there is no reason to pay for that only to be told the browser wanted none of it.
  const mime = plannedMimeTypes(videoTrack, audioTrack);
  const playable = playabilityOf({
    videoMimeType: mime.video ?? "",
    audioMimeType: mime.audio,
    videoInit: EMPTY,
    audioInit: null,
    durationSeconds: 0,
  });
  if (!playable.ok) return playable.reason;

  try {
    const remuxer = await Remuxer.open(source, file, videoTrack, audioTrack, dimensions);
    return { remuxer, plan: remuxer.plan() };
  } catch (error) {
    return error instanceof Error ? error.message : "ouverture impossible";
  }
}

export async function choosePlaybackPath(input: PathInput): Promise<ChosenPath> {
  const attempts: PathAttempt[] = [];

  const remux = await tryRemux(input);
  if (typeof remux !== "string") {
    attempts.push({ path: "remux", ok: true });
    return { path: "remux", remuxer: remux.remuxer, plan: remux.plan, attempts };
  }
  attempts.push({ path: "remux", ok: false, reason: remux });

  // Second choice, and it has to be able to say no as clearly as the first did.
  const webcodecsReason = unsupportedReason(input.videoTrack);
  if (webcodecsReason) {
    attempts.push({ path: "webcodecs", ok: false, reason: webcodecsReason });
    const explained = attempts.map((a) => `${a.path} : ${a.reason}`).join(" · ");
    throw new Error(`Aucun chemin de lecture disponible pour ce fichier. ${explained}`);
  }

  attempts.push({ path: "webcodecs", ok: true });
  return { path: "webcodecs", remuxer: null, plan: null, attempts };
}

/** A one-line summary of the decision, for the technical panel. */
export function describePath(chosen: ChosenPath): string {
  const rejected = chosen.attempts.filter((a) => !a.ok);
  const name = chosen.path === "remux" ? "remultiplexage → lecteur natif" : "WebCodecs → canvas";
  if (rejected.length === 0) return name;
  return `${name} (après : ${rejected.map((a) => `${a.path} refusé — ${a.reason}`).join(" ; ")})`;
}
