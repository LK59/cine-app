/**
 * Le décompte d'une séance du lecteur natif, pour son bilan de fin (la ligne `stop`).
 *
 * Le journal n'écrivait un blocage qu'au bout de cinq secondes d'horloge figée (`stall`). Les
 * attentes d'une à quatre secondes — les saccades qu'on ressent vraiment — ne laissaient aucune
 * trace, et une séance ne se résumait nulle part : pour savoir si le lecteur allait mieux d'une
 * semaine à l'autre, il fallait recoller des lignes à la main (23/09/2026).
 *
 * Trois sortes d'attente, et elles ne se mélangent pas : l'ouverture a sa ligne `start`
 * (`openedInMs`), un saut sa ligne `seek` (`tookMs`) et son total ici, et seul ce qui reste — le
 * film qui s'arrête de lui-même en pleine lecture — compte comme une attente. C'est le chiffre
 * qui dit si regarder un film est confortable.
 *
 * Pur, sans horloge à lui : chaque appel reçoit l'instant, ce qui le rend testable.
 */

/** En dessous, une attente ne se voit pas : le navigateur en signale de très brèves en continu. */
export const MIN_WAIT_MS = 250;

export interface TallySummary {
  /** Attentes d'au moins `MIN_WAIT_MS` en pleine lecture, hors sauts et hors ouverture. */
  waits: number;
  waitedMs: number;
  longestWaitMs: number;
  seeks: number;
  /** Le temps total passé à attendre l'arrivée des sauts. */
  seekWaitMs: number;
  audioSwitches: number;
  /**
   * Les passages en arrière-plan : combien, combien de temps en tout, et combien ont coûté une
   * reconstruction au retour (la plateforme avait fermé la source). Une reconstruction au retour
   * n'était écrite que dans la trace — au journal, elle ressemblait à une ouverture de plus.
   */
  backgrounds: number;
  backgroundMs: number;
  backgroundRebuilds: number;
}

export class SessionTally {
  private waits = 0;
  private waitedMs = 0;
  private longestWaitMs = 0;
  private seeks = 0;
  private seekWaitMs = 0;
  private audioSwitches = 0;
  private waitingSince: number | null = null;
  private backgrounds = 0;
  private backgroundMs = 0;
  private backgroundRebuilds = 0;
  private hiddenSince: number | null = null;
  private lastHiddenMs = 0;
  /** Le dernier retour au premier plan — voir `backgroundFacts`. */
  private lastShownAt: number | null = null;

  /** Le film s'arrête de lui-même. Un second signal pendant la même attente ne la redouble pas. */
  waitStarted(now: number): void {
    if (this.waitingSince === null) this.waitingSince = now;
  }

  /** Il repart — ou le spectateur a mis en pause, ou sauté ailleurs : l'attente s'arrête là. */
  waitEnded(now: number): void {
    const since = this.waitingSince;
    if (since === null) return;
    this.waitingSince = null;
    this.count(now - since);
  }

  /** Un saut commence : une attente en cours n'en est plus une, c'est le saut qui compte. */
  waitAbandoned(): void {
    this.waitingSince = null;
  }

  seekArrived(tookMs: number): void {
    this.seeks += 1;
    this.seekWaitMs += Math.max(0, tookMs);
  }

  audioSwitched(): void {
    this.audioSwitches += 1;
  }

  /** La page passe en arrière-plan. Une attente en cours n'en est plus une : c'est l'absence. */
  hidden(now: number): void {
    if (this.hiddenSince !== null) return;
    this.hiddenSince = now;
    this.waitingSince = null;
  }

  /** Elle revient. Rend la durée de cette absence, que la ligne `rebuild` du retour porte. */
  shown(now: number): number {
    const since = this.hiddenSince;
    if (since === null) return 0;
    this.hiddenSince = null;
    this.lastShownAt = now;
    this.backgrounds += 1;
    this.lastHiddenMs = Math.max(0, now - since);
    this.backgroundMs += this.lastHiddenMs;
    return this.lastHiddenMs;
  }

  /**
   * Tout le temps passé en arrière-plan jusqu'ici, absence en cours comprise. Un saut commencé juste
   * avant de quitter l'application et arrivé au retour comptait l'absence entière comme attente :
   * 286 s pour un Mac mis en veille (24/09/2026), ce qui faussait tout bilan de la semaine.
   */
  hiddenMsSoFar(now: number): number {
    return this.backgroundMs + (this.hiddenSince !== null ? now - this.hiddenSince : 0);
  }

  /** La durée de la dernière absence terminée. */
  get lastBackgroundMs(): number {
    return this.lastHiddenMs;
  }

  /**
   * Où en est la page vis-à-vis de l'arrière-plan, pour une ligne d'incident.
   *
   * Deux « Media failed to decode » sur *Red Dragon* chez un iPhone passé dix-huit fois en
   * arrière-plan dans la séance (24/09/2026) : un flux sain, décodé sans erreur par FFmpeg comme
   * nos propres octets, et aucun moyen de savoir si la panne suivait un déverrouillage — rien de
   * l'arrière-plan n'était écrit. `shownAgoMs` petit, c'est une panne au retour ; absent, la page
   * n'a jamais quitté l'écran. Rien quand il n'y a rien à dire.
   */
  backgroundFacts(now: number): Record<string, number | boolean> {
    if (this.hiddenSince !== null) return { hiddenNow: true, hiddenForMs: now - this.hiddenSince };
    if (this.lastShownAt === null) return {};
    return { shownAgoMs: now - this.lastShownAt, lastHiddenMs: this.lastHiddenMs };
  }

  backgroundRebuilt(): void {
    this.backgroundRebuilds += 1;
  }

  /** Le bilan à cet instant, attente en cours comprise — la séance peut finir en pleine attente. */
  summary(now: number): TallySummary {
    const ongoing = this.waitingSince !== null ? now - this.waitingSince : 0;
    const counted = ongoing >= MIN_WAIT_MS;
    return {
      waits: this.waits + (counted ? 1 : 0),
      waitedMs: Math.round(this.waitedMs + (counted ? ongoing : 0)),
      longestWaitMs: Math.round(Math.max(this.longestWaitMs, counted ? ongoing : 0)),
      seeks: this.seeks,
      seekWaitMs: Math.round(this.seekWaitMs),
      audioSwitches: this.audioSwitches,
      // Une séance qui finit en arrière-plan — l'application tuée — compte son absence en cours.
      backgrounds: this.backgrounds + (this.hiddenSince !== null ? 1 : 0),
      backgroundMs: Math.round(this.backgroundMs + (this.hiddenSince !== null ? now - this.hiddenSince : 0)),
      backgroundRebuilds: this.backgroundRebuilds,
    };
  }

  private count(ms: number): void {
    if (ms < MIN_WAIT_MS) return;
    this.waits += 1;
    this.waitedMs += ms;
    this.longestWaitMs = Math.max(this.longestWaitMs, ms);
  }
}

/**
 * Un identifiant court par séance, porté par chacune de ses lignes.
 *
 * Les lignes se recollaient par compte et par heure : deux appareils du même compte en même
 * temps, ou une reconstruction — qui réécrit une ligne `start` —, et le recollage se trompait.
 * Huit caractères suffisent à distinguer les séances d'un foyer.
 */
export function newPlayerSessionId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID().slice(0, 8);
  } catch {
    // Contexte non sécurisé : `randomUUID` y manque.
  }
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Le temps passé à jouer, pas l'écart entre la position d'arrivée et celle de départ : un saut de
 * quarante minutes n'est pas quarante minutes regardées.
 *
 * Partagé par les deux lecteurs. Le lecteur serveur n'en tenait aucun : son `stop` ne portait que
 * sa position, si bien qu'une séance passée par lui — repli ou diffusion vers la télé — se lisait à
 * zéro seconde regardée sur la page Activité (24/09/2026).
 */
export class WatchedClock {
  private total = 0;
  private since: number | null = null;

  run(now: number): void {
    if (this.since === null) this.since = now;
  }

  halt(now: number): void {
    if (this.since === null) return;
    this.total += Math.max(0, now - this.since);
    this.since = null;
  }

  /** En secondes, arrondi — l'unité de la ligne `stop`. */
  seconds(now: number): number {
    return Math.round((this.total + (this.since !== null ? Math.max(0, now - this.since) : 0)) / 1000);
  }

  /**
   * Lire et repartir de zéro : chaque ligne qui porte `watched` rend compte de sa part seulement,
   * et la séance en fait la somme (`seances.ts`). Une diffusion rendue puis un arrêt ne comptent
   * pas deux fois le même film.
   */
  take(now: number): number {
    const seconds = this.seconds(now);
    this.total = 0;
    if (this.since !== null) this.since = now;
    return seconds;
  }
}
