"use client";

// Le relais préparé avant une zone illisible (DECISIONS.md §93), côté lecteur natif.
//
// La lecture en avance atteint la zone une trentaine de secondes avant la tête (`MseSource`,
// `onUnreadableZone`). Plutôt que de passer la main tout de suite — trente secondes de lecture
// native jetées —, la lecture continue jusqu'à la fin de ce qui est sûr (`switchAt`), et pendant
// ce temps le lecteur serveur est **préchauffé** à cette position : la négociation et le premier
// segment, par la mécanique de la connexion lente (§78, `lighterPrewarm.ts` — même réemploi exact,
// même arrêt chez Jellyfin), mais en négociation ordinaire (`step: null`), sans débit abaissé.
// Quand la tête arrive au relais (`onError`, `facts.unreadableZone`), le lecteur serveur reprend ce
// préchauffage (`takeOrdinaryPrewarm`) et part de son segment.
//
// Trois façons de faire, selon où l'on est (`mode`) :
// - `prepare` : un lecteur serveur existe et lit par hls.js — préchauffer, passer la main à la tête ;
// - `immediate` : WebKit en HLS natif — passer la main tout de suite, sans préchauffage. Safari y
//   relit son segment 0 puis saute (deux démarrages de ffmpeg, mesuré au §78 : le préchauffage n'y
//   épargne que la négociation), et une seconde séance HLS ouverte dans une page qui a servi le
//   lecteur natif y a déjà échoué (code 4) ; le relais ordinaire dans la page, lui, y marche. Le
//   plus sûr là-bas reste le relais immédiat, qui laisse au lecteur serveur trente secondes de
//   marge avant la zone ;
// - `wait` : pas de lecteur serveur (`PLAYER_SERVER_FALLBACK=false`), ou le banc d'essai — rien à
//   préparer : la lecture va jusqu'au relais, où l'erreur propre (ou le repli du banc) arrive.
//
// Le préchauffage est abandonné — arrêté chez Jellyfin, rien ne fuit — à la pause, à la fermeture,
// et quand un saut quitte la zone (au-delà, ou plus de 90 s avant). Il repart à la reprise de la
// lecture, et se garde à travers une reconstruction qui retrouve la même zone.

import { cancelPrewarm, prewarmGone, startPrewarm, type Prewarm } from "@/lib/lighterPrewarm";
import type { UnreadableZoneEvent, UnreadableZoneNotice } from "@/lib/webcodecs/mseSource";

export type ZoneMode = "prepare" | "immediate" | "wait";

/** Un saut plus loin que cela avant le relais : le préchauffage ne sert plus, il est arrêté. */
export const ZONE_PREWARM_KEEP_S = 90;
/** L'écart toléré entre deux annonces de la même zone (une reconstruction la retrouve). */
const SAME_ZONE_SLACK_S = 1;

export interface ZoneHandoverHost {
  itemId: string;
  mode(): ZoneMode;
  /** La piste audio à préchauffer, en index Jellyfin — celle que le relais emportera. */
  audioStreamIndex(): number | undefined;
  /** Le plafond de la négociation ordinaire du lecteur serveur (`pickMaxBitrate`). */
  maxBitrate(): number;
  paused(): boolean;
  trace(text: string): void;
}

export class ZoneHandover {
  private held: { prewarm: Prewarm; zone: UnreadableZoneNotice; audio: number | undefined } | null = null;
  /** La zone qui tient la lecture, préchauffée ou non (en pause : pas encore). */
  private zone: UnreadableZoneNotice | null = null;
  private current: ZoneHandoverHost | null = null;

  /** L'hôte, tel qu'il est à son dernier rendu (posé par un effet, comme `SlowLinkRunner.attach`). */
  attach(host: ZoneHandoverHost): void {
    this.current = host;
  }

  private get host(): ZoneHandoverHost {
    if (!this.current) throw new Error("lecteur non rattaché");
    return this.current;
  }

  /**
   * Ce que la source dit de la zone. Rend `"immediate"` quand l'hôte doit passer la main sur-le-champ
   * (WebKit en HLS natif), sinon `null` : la source passera la main elle-même à la tête.
   */
  event(event: UnreadableZoneEvent): "immediate" | null {
    try {
      if (event.kind === "left") {
        this.zone = null;
        const held = this.held;
        if (!held) return null;
        const past = event.zone.resumeAfter !== null ? event.target >= event.zone.resumeAfter : false;
        if (past || held.zone.switchAt - event.target > ZONE_PREWARM_KEEP_S) this.drop(past ? "saut au-delà de la zone" : "saut loin avant la zone");
        else this.zone = held.zone;
        return null;
      }
      const mode = this.host.mode();
      this.zone = event.zone;
      if (mode === "immediate") return "immediate";
      if (mode !== "prepare") return null;
      this.prepare();
    } catch {
      /* une préparation n'est pas la lecture */
    }
    return null;
  }

  /** L'élément s'est mis en pause : le préchauffage est arrêté chez Jellyfin, la zone reste connue. */
  paused(): void {
    if (this.held) this.drop("pause");
  }

  /** La lecture reprend : la zone toujours devant, le préchauffage repart. */
  played(): void {
    try {
      if (this.zone && !this.held && this.host.mode() === "prepare") this.prepare();
    } catch {
      /* rien */
    }
  }

  /**
   * La tête est au relais : le préchauffage passe au lecteur serveur (qui le reprend par
   * `takeOrdinaryPrewarm`). Plus tenu d'ici — la fermeture de ce lecteur, qui suit le relais, ne
   * l'arrête donc pas. Préparé ailleurs qu'à `resumeAt` (un saut dans la zone) : arrêté.
   */
  take(resumeAt: number): Prewarm | null {
    const held = this.held;
    this.held = null;
    this.zone = null;
    if (!held || prewarmGone(held.prewarm)) return null;
    if (Math.abs(held.prewarm.startSeconds - resumeAt) > SAME_ZONE_SLACK_S) {
      cancelPrewarm(held.prewarm);
      this.note(`zone illisible : préchauffage à ${held.prewarm.startSeconds.toFixed(1)} s arrêté, le relais part de ${resumeAt.toFixed(1)} s`);
      return null;
    }
    return held.prewarm;
  }

  /** Le lecteur se ferme : rien d'orphelin chez Jellyfin. */
  dispose(): void {
    this.zone = null;
    if (this.held) this.drop("lecteur fermé");
  }

  /** Le préchauffage tenu, pour les tests et le journal. */
  get prewarm(): Prewarm | null {
    return this.held?.prewarm ?? null;
  }

  private prepare(): void {
    const zone = this.zone;
    if (!zone) return;
    const audio = this.host.audioStreamIndex();
    const held = this.held;
    // La même zone retrouvée (une reconstruction, un saut en arrière qui y revient) : rien à refaire.
    if (
      held &&
      !prewarmGone(held.prewarm) &&
      held.zone.byteOffset === zone.byteOffset &&
      Math.abs(held.zone.switchAt - zone.switchAt) <= SAME_ZONE_SLACK_S &&
      held.audio === audio
    ) {
      return;
    }
    if (held) this.drop("autre zone ou autre piste");
    if (this.host.paused()) return;
    const prewarm = startPrewarm({ itemId: this.host.itemId, step: null, startSeconds: zone.switchAt, audioStreamIndex: audio, maxBitrate: this.host.maxBitrate() });
    this.held = { prewarm, zone, audio };
    this.note(`zone illisible : lecteur serveur préchauffé à ${zone.switchAt.toFixed(1)} s`);
  }

  private drop(why: string): void {
    const held = this.held;
    this.held = null;
    if (!held) return;
    cancelPrewarm(held.prewarm);
    this.note(`zone illisible : préchauffage annulé — ${why}`);
  }

  private note(text: string): void {
    try {
      this.current?.trace(text);
    } catch {
      /* rien */
    }
  }
}
