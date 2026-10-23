// Ce que `MseSource` promet à son hôte : les rappels, les faits de reprise pour la ligne `stop`, et
// la zone illisible (§93). Sortis de mseSource.ts, qui les réexporte.

import type { PlayerWarning } from "./playerWarning";
import type { TrackedCue } from "./remuxer";

/** Ce que la ligne `stop` apprend des reprises de la séance — voir `MseSource.recoveryFacts`. */
export interface RecoveryFacts {
  recoveries: number;
  frozenNudges: number;
  escalations: number;
  /** Plages que le navigateur a retirées de lui-même (ManagedMediaSource seulement). */
  evictions: number;
  /** Dont devant la tête : ce que la lecture allait chercher. */
  evictionsAhead: number;
}

/** Une zone illisible atteinte par la lecture en avance (§93), sur l'horloge du lecteur. */
export interface UnreadableZoneNotice {
  /** Le motif exact (`unreadableZoneMessage`). */
  message: string;
  byteOffset: number;
  /** Où la zone commence, à peu près. */
  zoneSeconds: number;
  /** Où passer la main : la fin de ce qui est sûr, moins la marge — jamais avant la tête. */
  switchAt: number;
  /** Le premier point d'index après la zone : un saut au-delà retrouve du film lisible. Null : aucun. */
  resumeAfter: number | null;
}

/** Ce que `onUnreadableZone` dit à l'hôte : une zone tient la lecture, ou un saut l'a quittée. */
export type UnreadableZoneEvent = { kind: "held"; zone: UnreadableZoneNotice } | { kind: "left"; zone: UnreadableZoneNotice; target: number };

export interface MseCallbacks {
  /**
   * Fatal: playback cannot continue on this path. The caller decides what to say and offer.
   *
   * `kind` is what makes that decision possible. A network failure is not a reason to give up on
   * this path — it is a reason to wait, because every other path needs the same network.
   */
  onError: (message: string, kind?: "network" | "playback", facts?: Record<string, unknown>) => void;
  /**
   * Une zone illisible tient la lecture (§93), ou un saut l'a quittée. Prévenu dès que la lecture
   * en avance l'atteint — trente secondes avant la tête, d'ordinaire — pour que l'hôte prépare le
   * relais ; le relais lui-même arrive par `onError`, avec `facts.unreadableZone`, quand la tête
   * atteint `switchAt` (ou tout de suite s'il n'y a rien à jouer avant). Jamais de reprise entre
   * les deux : relire le même endroit relirait les mêmes zéros.
   */
  onUnreadableZone?: (event: UnreadableZoneEvent) => void;
  /** Subtitle lines found in the stretch of file just read, already timed on the player's clock. */
  onSubtitles?: (cues: TrackedCue[]) => void;
  /** Something was refused but playback continues — a seek the file cannot serve, typically. */
  onWarning?: (warning: PlayerWarning) => void;
  /**
   * Play has been pressed and the clock has not moved yet, or null once it has.
   *
   * Reported as a fact rather than as a platform: on iOS the pipeline needs a moment to refill
   * the sound it was told to discard, and on a desktop the same condition clears within a frame.
   * A caller can therefore show that something is happening without ever asking which browser it
   * is in, and without inventing a delay where there is none.
   */
  onStarting?: (startedAt: number | null) => void;
  /**
   * The clock has stood still for `STALL_REPORT_MS` while the element says it is playing — once per
   * stall, for the playback log. Flat facts (see `stallReport`), nothing to act on: the recoveries
   * are already under way, and this is how anyone learns afterwards what they were up against.
   */
  onStall?: (facts: Record<string, unknown>) => void;
}
