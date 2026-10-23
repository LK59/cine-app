// La zone illisible (§93) vue de `MseSource` : la lecture en avance l'a atteinte, plus rien n'est
// lu, la tête finit ce qui est sûr, et la main passe à l'hôte au relais (`switchAt`). Sorti de
// mseSource.ts tel quel ; la source lui prête une vue étroite d'elle-même (`ZoneHost`) et garde
// pour elle ce qu'un saut en fait (`performSeek`).

import { trace } from "./trace";
import type { Remuxer } from "./remuxer";
import type { UnreadableZone } from "./unreadableZone";
import type { MseCallbacks, UnreadableZoneEvent, UnreadableZoneNotice } from "./mseTypes";
import { ZONE_MARGIN_SECONDS } from "./mseTuning";

/** Ce que la zone lit de la source — l'avance passe par la sienne, que rien ici ne recalcule. */
export interface ZoneHost {
  readonly destroyed: boolean;
  readonly delaySeconds: number;
  readonly anchor: number;
  readonly lead: number;
  bufferedEnd(): number;
  readonly video: HTMLVideoElement;
  readonly remuxer: Remuxer;
  readonly callbacks: MseCallbacks;
  elementState(): string;
}

export class UnreadableZoneHold {
  constructor(private readonly host: ZoneHost) {}

  /**
   * La zone illisible qui tient la lecture (§93) : plus rien n'est lu, la tête finit ce qui est là,
   * et le relais part à `switchAt`. Levée par un saut qui la quitte.
   */
  zone: UnreadableZoneNotice | null = null;
  /** Le relais pour une zone est parti : cette source n'a plus rien à faire. */
  zoneHanded = false;

  /**
   * La lecture en avance vient d'atteindre une zone illisible (§93). Plus rien n'est lu ; ce qui est
   * dans les tampons se joue jusqu'à la fin de ce qui est sûr (`switchAt`), où la main passe. Rien à
   * jouer avant — une ouverture, un saut tombé dedans — : tout de suite.
   */
  holdAtZone(error: UnreadableZone): void {
    if (this.zoneHanded || this.host.destroyed) return;
    const delay = this.host.delaySeconds;
    const head = this.host.anchor;
    const lead = this.host.lead;
    const safe = error.safeSeconds + delay - ZONE_MARGIN_SECONDS;
    const switchAt = lead > ZONE_MARGIN_SECONDS ? Math.max(head, Math.min(safe, this.host.bufferedEnd() - ZONE_MARGIN_SECONDS)) : head;
    let resumeAfter: number | null = null;
    try {
      const after = this.host.remuxer.resumeAfterByte(error.byteOffset);
      resumeAfter = after === null ? null : after + delay;
    } catch {
      resumeAfter = null;
    }
    this.zone = { message: error.message, byteOffset: error.byteOffset, zoneSeconds: error.seconds + delay, switchAt, resumeAfter };
    trace(
      `${error.message} — tête à ${head.toFixed(1)} s, ${lead.toFixed(1)} s d'avance, relais à ${switchAt.toFixed(1)} s` +
        (resumeAfter !== null ? `, film lisible de nouveau à ${resumeAfter.toFixed(1)} s` : ", aucun point d'index après")
    );
    this.notifyZone({ kind: "held", zone: this.zone });
    this.checkZoneArrival();
  }

  notifyZone(event: UnreadableZoneEvent): void {
    // Une préparation qui lève ne doit pas devenir l'échec de la lecture.
    try {
      this.host.callbacks.onUnreadableZone?.(event);
    } catch {
      /* rien */
    }
  }

  /** La tête est-elle au relais — ou n'y a-t-il plus rien à jouer avant ? Passe la main si oui. */
  checkZoneArrival(): boolean {
    const zone = this.zone;
    if (!zone || this.zoneHanded || this.host.destroyed) return false;
    if (this.host.anchor < zone.switchAt && this.host.lead > 0) return false;
    this.arriveAtZone(zone.switchAt, "tête arrivée au relais");
    return true;
  }

  /** Une fois : la main passe à l'hôte (`onError`, `facts.unreadableZone`), qui relaie au lecteur serveur. */
  arriveAtZone(resumeAt: number, why: string): void {
    const zone = this.zone;
    if (!zone || this.zoneHanded || this.host.destroyed) return;
    this.zoneHanded = true;
    const head = this.host.video.currentTime;
    trace(`zone illisible : ${why} à ${head.toFixed(1)} s — relais à ${resumeAt.toFixed(1)} s ${this.host.elementState()}`);
    this.host.callbacks.onError(zone.message, "playback", {
      unreadableZone: true,
      zoneByte: zone.byteOffset,
      zoneSeconds: Math.round(zone.zoneSeconds * 10) / 10,
      resumeAt: Math.round(resumeAt * 1000) / 1000,
      at: Math.round(head * 10) / 10,
      ...(zone.resumeAfter !== null ? { resumeAfter: Math.round(zone.resumeAfter * 10) / 10 } : {}),
    });
  }
}
