"use client";

// L'exécution des décisions de la connexion lente (DECISIONS.md §78), commune aux deux lecteurs — le
// natif (`ExperimentalPlayerHost`) et le lecteur serveur (`ActivePlayer`, PlayerHost.tsx).
//
// `slowLinkPolicy.ts` décide (pur, sans horloge) ; ceci exécute : tenir le préchauffage, le lancer, le
// laisser tomber, montrer l'écran final, et suivre un saut resté sans image. Chaque hôte ne garde que ce
// qui lui est propre — basculer (`fallToStable` côté natif, `startPlayback` côté serveur), son écran, sa
// mesure. Écrit deux fois, la même règle avait déjà divergé (un saut posé en pause traité comme une
// ouverture d'un côté seulement, un intervalle permanent de chaque côté).
//
// Rien ici ne lève : une erreur dans la décision n'interrompt jamais une lecture.

import { cancelPrewarm, prewarmGone, prewarmStatusOf, startPrewarm, type Prewarm } from "@/lib/lighterPrewarm";
import {
  EARLY_PREWARM_MS,
  SEEK_AS_OPENING_MS,
  SEEK_GIVE_UP_MS,
  decideOpening,
  mbps,
  type LighterStep,
  type PrewarmStatus,
  type SlowAction,
  type SlowLog,
  type SwitchCause,
} from "@/lib/slowLinkPolicy";
import { slowLinkVerdict, type LinkMeasure, type SlowLink } from "@/lib/slowLink";

export interface LinkReadingBps {
  recvBps: number | null;
  needBps: number | null;
}

/** Le signal d'un saut sans image depuis 10 s : l'indice « Connexion lente… » sous la roue. */
export interface SeekSignal extends LinkReadingBps {
  at: number;
  hint: boolean;
}

/** Ce que chaque hôte fournit (`attach`). Relu à chaque appel : l'hôte le tient à jour. */
export interface SlowLinkHost {
  itemId: string;
  log(): SlowLog;
  /** La piste audio à préchauffer, en index Jellyfin. */
  audioStreamIndex(): number | undefined;
  /** Le lecteur ne peut plus rien entreprendre (le natif a déjà passé la main). */
  over(): boolean;
  trace?(text: string): void;
  /** Basculer sur ce palier, à cette position — la seule chose que les deux hôtes font différemment. */
  switchTo(step: LighterStep, resumeAt: number, cause: SwitchCause, held: Prewarm | null, reading: LinkReadingBps): void;
  /** « Lecture impossible : la connexion est trop lente. » — le journal et l'écran de l'hôte. */
  screen(slow: SlowLink, cause: SwitchCause): void;
  /** Le renoncement d'avant, motif d'avant (natif seulement : le serveur a son chien de garde). */
  giveUp(): void;
  /** Un préchauffage de saccades prêt (ou en échec) : la décision en pleine lecture, rappelée. */
  playbackDecision(): void;

  // --- un saut resté sans image ---
  /** Rien à décider maintenant : erreur à l'écran, page cachée, rien de mesurable. */
  seekBlocked(): boolean;
  /** L'élément est en pause : un saut posé en pause n'attend rien (§78). */
  paused(): boolean;
  /** Ce que le lien a livré depuis le saut. */
  seekMeasure(elapsedMs: number): LinkMeasure | null;
  needBps(): number | null;
  unstable(): boolean;
  auto(): boolean;
  currentStep(): LighterStep | null;
  position(): number;
  seekSignal(signal: SeekSignal | null): void;
}

/**
 * L'écart toléré entre la position d'un préchauffage et celle qu'un saut attend : une seconde, le jeu des
 * arrondis — au-delà, c'est un autre endroit du film (voir `seekTick`).
 */
const SEEK_PREWARM_SLACK_S = 1;

export class SlowLinkRunner {
  /** Le préchauffage de la version allégée en cours (`lighterPrewarm.ts`), et pour quoi. */
  held: { prewarm: Prewarm; cause: SwitchCause } | null = null;
  private seekAt: number | null = null;
  private seekTimer: ReturnType<typeof setInterval> | null = null;
  private shown: { at: number; hint: boolean } | null = null;
  private current: SlowLinkHost | null = null;
  /**
   * En pleine lecture, la règle de bascule a joué (`StutterWatch` : 5 s, ou le 3e blocage) : le
   * préchauffage prêt bascule. Faux tant que seul le 2e blocage a parlé — il préchauffe, sans plus.
   */
  private playbackArmed = false;
  /** L'annulation du préchauffage du 2e blocage, si la bascule ne vient pas (`EARLY_PREWARM_MS`). */
  private earlyTimer: ReturnType<typeof setTimeout> | null = null;

  /** L'hôte, tel qu'il est à son dernier rendu (posé par un effet). */
  attach(host: SlowLinkHost): void {
    this.current = host;
  }

  private host(): SlowLinkHost {
    if (!this.current) throw new Error("lecteur non rattaché");
    return this.current;
  }

  /** L'état du préchauffage pour la décision (`decideOpening` / `decidePlayback`). */
  status(cause: SwitchCause): PrewarmStatus {
    // Pris par une renégociation du lecteur serveur, ou abandonné ailleurs : plus le nôtre. Le garder
    // bloquait le préchauffage suivant (`execute` n'en lance pas tant qu'un est tenu).
    if (this.held && prewarmGone(this.held.prewarm)) {
      this.held = null;
      this.clearEarlyTimer();
    }
    return prewarmStatusOf(this.held, cause);
  }

  /**
   * La décision en pleine lecture est-elle armée ? `triggered` : la règle de bascule vient de jouer —
   * elle le reste jusqu'à la bascule. Lu par les deux hôtes avant `decidePlayback`.
   */
  armPlayback(triggered: boolean): boolean {
    if (triggered) {
      this.playbackArmed = true;
      this.clearEarlyTimer();
    }
    return this.playbackArmed;
  }

  private clearEarlyTimer(): void {
    if (this.earlyTimer !== null) clearTimeout(this.earlyTimer);
    this.earlyTimer = null;
  }

  /** Le préchauffage ne sert plus (une image, une fermeture) : arrêté chez Jellyfin, noté. */
  drop(why: string): void {
    const held = this.held;
    if (!held) return;
    this.held = null;
    this.clearEarlyTimer();
    try {
      cancelPrewarm(held.prewarm);
      const host = this.host();
      host.log().note(`préchauffage annulé (${why})`);
      host.trace?.(`connexion lente : préchauffage annulé — ${why}`);
    } catch {
      /* rien */
    }
  }

  /** Exécute ce que la décision dit : préchauffer, basculer, l'écran final, ou renoncer comme avant. */
  execute(action: SlowAction, cause: SwitchCause, at: number, reading: LinkReadingBps): void {
    try {
      const host = this.host();
      const log = host.log();
      if (action.kind === "prewarm") {
        if (this.held || host.over()) return;
        const prewarm = startPrewarm({ itemId: host.itemId, step: action.step, startSeconds: at, audioStreamIndex: host.audioStreamIndex() });
        this.held = { prewarm, cause };
        // En pleine lecture sans déclenchement : le 2e blocage. Préchauffé d'avance, annulé si la règle
        // de bascule ne suit pas dans la minute — aucun transcodage tenu pour rien.
        const early = cause === "lecture" && !this.playbackArmed;
        if (early) {
          this.clearEarlyTimer();
          this.earlyTimer = setTimeout(() => {
            this.earlyTimer = null;
            if (this.held?.prewarm === prewarm && !this.playbackArmed) this.drop(`pas de bascule en ${EARLY_PREWARM_MS / 1000} s`);
          }, EARLY_PREWARM_MS);
        }
        log.note(`préchauffage (${early ? "2e blocage" : cause}) à ${Math.round(at)} s : ${mbps(action.step.targetBps)} Mb/s palier ${action.step.tier} (${mbps(reading.recvBps)}/${mbps(reading.needBps)})`);
        host.trace?.(`connexion lente : préchauffage de la version allégée (${cause}) — ${action.step.targetBps} b/s à ${at.toFixed(1)} s`);
        void prewarm.ready.then((ok) => {
          if (prewarm.state === "cancelled") return;
          log.note(ok ? `préchauffage prêt en ${Math.round((prewarm.readyAt ?? 0) - prewarm.startedAt)} ms` : "préchauffage en échec");
          // En pleine lecture, la bascule suit le préchauffage dès qu'il est prêt.
          if (cause === "lecture") this.host().playbackDecision();
        });
        return;
      }
      if (action.kind === "switch") {
        const held = this.held;
        this.held = null;
        this.clearEarlyTimer();
        if (cause === "lecture") this.playbackArmed = false;
        // Un préchauffage d'ouverture ou de saut fixe la position : le lecteur serveur part de son segment.
        const resumeAt = held && cause !== "lecture" ? held.prewarm.startSeconds : at;
        log.note(`bascule (${cause}) à ${Math.round(resumeAt)} s, ${mbps(action.step.targetBps)} Mb/s palier ${action.step.tier}${held ? "" : ", sans préchauffage"}`);
        host.trace?.(`connexion lente : bascule en version allégée (${cause}) à ${resumeAt.toFixed(1)} s`);
        this.seekDone();
        host.switchTo(action.step, resumeAt, cause, held?.prewarm ?? null, reading);
        return;
      }
      if (action.kind === "screen") {
        this.drop("écran final");
        const slow = action.slow;
        log.note(`écran trop lente (${cause}) à ${Math.round(at)} s (${mbps(slow.recvBps)}/${mbps(slow.needBps)})`);
        host.screen(slow, cause);
        return;
      }
      if (action.kind === "giveUp") {
        this.drop("renoncement sans lenteur prouvée");
        host.giveUp();
      }
    } catch {
      /* la décision n'est pas la lecture */
    }
  }

  // --- un saut traité comme une ouverture -------------------------------------------------------

  /**
   * Un saut commence (`seeking`, après la première image) : suivi chaque seconde, et seulement tant
   * qu'il attend son image — aucun minuteur le reste du temps. Un nouveau saut repart de zéro.
   */
  seekStarted(now = Date.now()): void {
    this.seekAt = now;
    if (this.seekTimer === null) this.seekTimer = setInterval(() => this.seekTick(), 1000);
  }

  /** L'image est là, ou le saut s'est posé en pause : plus rien n'attend. */
  seekDone(): void {
    this.seekAt = null;
    if (this.seekTimer !== null) clearInterval(this.seekTimer);
    this.seekTimer = null;
    if (this.held?.cause === "saut") this.drop("image après le saut");
    if (this.shown) {
      this.shown = null;
      try {
        this.host().seekSignal(null);
      } catch {
        /* rien */
      }
    }
  }

  /** Le lecteur se démonte : le minuteur seulement — plus d'état à écrire. */
  dispose(): void {
    this.clearEarlyTimer();
    if (this.seekTimer !== null) clearInterval(this.seekTimer);
    this.seekTimer = null;
    this.seekAt = null;
    this.shown = null;
  }

  /** L'instant du saut qui attend son image, ou `null`. */
  get seekPending(): number | null {
    return this.seekAt;
  }

  /**
   * Dix secondes après le saut sans image, `decideOpening` sur la mesure prise depuis le saut — indice,
   * préchauffage, bascule ; à 35 s, la bascule ou l'écran si la lenteur est prouvée (sans lenteur
   * prouvée, rien : le saut garde son propre cycle).
   */
  private seekTick(): void {
    try {
      const at = this.seekAt;
      if (at === null) return this.seekDone();
      const host = this.host();
      // Un saut posé en pause n'attend rien : il ne devient jamais une ouverture (§78).
      if (host.paused()) return this.seekDone();
      const now = Date.now();
      if (now - at < SEEK_AS_OPENING_MS || host.seekBlocked()) {
        if (this.shown) {
          this.shown = null;
          host.seekSignal(null);
        }
        return;
      }
      const elapsed = now - at;
      const measure = host.seekMeasure(elapsed);
      const needBps = host.needBps();
      if (elapsed >= SEEK_GIVE_UP_MS && !slowLinkVerdict(measure, needBps)) return;
      // Un préchauffage fait pour une autre position — un saut précédent, ou le 2e blocage d'avant le
      // saut — ne sert plus : la bascule partait de SA position (`held.prewarm.startSeconds`), et un
      // spectateur qui avait sauté de 1000 à 3000 s pendant l'attente revenait à 1000 s (13/10/2026). Il
      // est refermé ; le préchauffage suivant se fait à la position demandée.
      const position = host.position();
      if (this.held && this.held.cause !== "ouverture" && !(Math.abs(this.held.prewarm.startSeconds - position) <= SEEK_PREWARM_SLACK_S)) {
        this.drop("saut ailleurs");
      }
      const { advice, action } = decideOpening({
        measure,
        needBps,
        elapsedMs: elapsed,
        unstable: host.unstable(),
        auto: host.auto(),
        prewarm: this.status("saut"),
        currentStep: host.currentStep(),
        giveUpMs: SEEK_GIVE_UP_MS,
      });
      this.execute(action, "saut", position, advice.recvBps !== null ? advice : action.kind === "screen" ? action.slow : advice);
      // Le délai du renoncement : ce saut a eu sa décision.
      if (elapsed >= SEEK_GIVE_UP_MS || action.kind === "switch") return this.seekDone();
      if (this.shown && this.shown.at === at && this.shown.hint === advice.hint) return;
      if (advice.hint && !this.shown?.hint) host.log().note(`indice après un saut, +${(elapsed / 1000).toFixed(1)} s (${mbps(advice.recvBps)}/${mbps(advice.needBps)})`);
      this.shown = { at, hint: advice.hint };
      host.seekSignal({ at, hint: advice.hint, recvBps: advice.recvBps, needBps: advice.needBps });
    } catch {
      /* la décision n'est pas la lecture */
    }
  }
}
