/**
 * Les décisions d'ouverture et de reconstruction du lecteur natif, hors de React.
 *
 * Elles vivaient dans `ExperimentalPlayerHost`, réparties sur une douzaine de références lues et
 * écrites à des dizaines d'endroits : le budget de reconstructions, la position qu'une
 * reconstruction doit rouvrir, la règle « même endroit deux fois », celle qui garde un film en
 * pause, le nombre de nouveaux essais réseau, le passage de main au lecteur serveur. Aucune de
 * ces règles n'était écrite en un seul endroit, et c'est là que naissaient les régressions : une
 * correction modifiait une référence sans voir les autres chemins qui la lisaient (voir
 * docs/cycle-de-vie-lecteur.md).
 *
 * Ici, elles sont réunies et nommées. L'hôte garde toute la mécanique — le pipeline, l'élément, les
 * minuteurs, le journal, l'état React — et demande à cet objet ce qui est permis et ce qu'il faut
 * faire. Rien ici ne touche au DOM ni au réseau : tout se teste sans navigateur.
 *
 * Déplacé à l'identique le 27/09/2026 (étape 2 du découpage) : le comportement est celui que
 * figent les tests « cycle de vie — comportement figé » de l'hôte.
 */

/** Combien de reconstructions une séance s'accorde avant de tenir une perte pour une panne. */
export const MAX_REBUILDS = 3;

/**
 * Et combien de temps une série de reconstructions compte pour une seule série.
 *
 * Un budget qui ne se renouvelle jamais, c'est un budget qu'un long film épuise par hasard : trois
 * accrocs à une heure d'intervalle ne sont pas la panne que cette limite existe pour arrêter.
 */
export const REBUILD_WINDOW_MS = 180_000;

/**
 * De combien une reconstruction saute au-delà d'une position qui a déjà tué la source.
 *
 * Relire exactement les mêmes octets, c'est mourir de nouveau à coup sûr, et le journal le prouve :
 * trois reconstructions ont relu le même segment de 5,5 Mo et perdu la source dix millisecondes
 * après l'avoir envoyé. Plus que le plus long intervalle entre images clés de la bibliothèque, pour
 * que la lecture reprenne sur un autre segment.
 */
export const REBUILD_STEP_SECONDS = 12;

/** Deux positions de reconstruction aussi proches sont le même endroit. */
export const SAME_PLACE_SECONDS = 3;

/** Ce qu'il faut faire d'une source perdue en pleine lecture. */
export type LossDecision =
  | {
      kind: "rebuild";
      /** Où rouvrir — au-delà du passage fautif s'il vient d'échouer une seconde fois. */
      at: number;
      /** Le passage a été sauté : le spectateur doit en être averti. */
      skipped: boolean;
      /** Le numéro de cette reconstruction dans la série en cours. */
      attempt: number;
    }
  | { kind: "giveUp" };

export class PlayerLifecycle {
  /**
   * La position qu'une reconstruction en cours doit rouvrir — nulle quand aucune n'attend.
   *
   * Effacée seulement quand le pipeline qui l'a consommée est prêt (`ready`), et à aucun autre
   * moment : effacée par un effet qui guettait la disponibilité, elle l'était parfois *après*
   * qu'une panne plus récente eut écrit la suivante — une source perdue dans le même instant que
   * le démarrage faisait repartir le film de zéro.
   */
  rebuildAt: number | null = null;

  /**
   * Le prochain pipeline doit-il rester en pause ?
   *
   * Posé par tout ce qui reconstruit un film à l'arrêt : un changement de piste ou de plafond HDR
   * pendant une pause, le retour d'une veille, le retour d'une diffusion arrêtée d'elle-même.
   * Consommé une fois, par le pipeline qui démarre (`consumeKeepPaused`).
   */
  keepPaused: boolean;

  private rebuilds = 0;
  private lastRebuildTime = 0;
  /** La position de la dernière reconstruction après une perte — ce qui fait « le même endroit ». */
  private lastLossAt: number | null = null;
  private networkRetries = 0;
  private steppedAside = false;
  /** Le fichier est allé au bout, et rien ne l'a relancé depuis. */
  private ended = false;

  constructor(options: { startPaused?: boolean } = {}) {
    this.keepPaused = options.startPaused === true;
  }

  /**
   * Dépense une des reconstructions permises, ou refuse.
   *
   * Le budget se renouvelle : trois pertes étalées sur un film de deux heures l'épuisaient aussi
   * sûrement que trois en neuf secondes, et la quatrième — une heure après la troisième, tout ayant
   * fonctionné entre-temps — confiait le film au lecteur serveur en pleine séance.
   */
  spendRebuild(now: number): boolean {
    if (now - this.lastRebuildTime > REBUILD_WINDOW_MS) this.rebuilds = 0;
    if (this.rebuilds >= MAX_REBUILDS) return false;
    this.rebuilds += 1;
    this.lastRebuildTime = now;
    return true;
  }

  /** Le numéro de la reconstruction qui vient d'être accordée. */
  get rebuildAttempt(): number {
    return this.rebuilds;
  }

  /**
   * Une reconstruction commence, à `at`.
   *
   * Elle ne relance pas un film que le spectateur avait mis en pause : seuls le changement de piste
   * et le plafond HDR y veillaient, et un film arrêté, rendu par iOS au retour d'arrière-plan,
   * repartait tout seul (relu le 24/09/2026). Une pause suivie de près par le passage en
   * arrière-plan peut être celle d'iOS lui-même : elle ne compte que si elle le précède d'une
   * seconde au moins.
   */
  restart(at: number, facts: { viewerPausedAt: number | null; hiddenAt: number | null }): void {
    const { viewerPausedAt: pausedAt, hiddenAt } = facts;
    if (pausedAt !== null && (hiddenAt === null || hiddenAt < pausedAt || pausedAt < hiddenAt - 1000)) this.keepPaused = true;
    // Un film fini attend sur son écran de fin, quelle que soit la cause de la reconstruction.
    // Seul le retour d'arrière-plan y veillait (24/09/2026) : une source perdue sur l'écran de fin,
    // ou un nouvel essai après une coupure, reconstruisait en lecture — le film rejouait ses
    // dernières secondes et annonçait sa fin une seconde fois. L'élément fini n'enregistre pas de
    // pause du spectateur, d'où cette règle à part (point 2, docs/cycle-de-vie-lecteur.md).
    if (this.ended) this.keepPaused = true;
    this.rebuildAt = at;
  }

  /** Le fichier est allé au bout. */
  noteEnded(): void {
    this.ended = true;
  }

  /** La lecture reprend après la fin — « Revoir », ou un saut en arrière. */
  noteResumedAfterEnd(): void {
    this.ended = false;
  }

  /** Le pipeline est prêt : la position de reconstruction est consommée, le réseau a répondu. */
  ready(): void {
    this.rebuildAt = null;
    this.networkRetries = 0;
  }

  /** Un saut demandé pendant une reconstruction : c'est là qu'elle doit rouvrir. */
  seekDuringRebuild(seconds: number): void {
    if (this.rebuildAt !== null) this.rebuildAt = seconds;
  }

  /**
   * Où ouvrir le pipeline qui démarre.
   *
   * Une reconstruction qui a demandé une position l'obtient ; sinon le film reprend là où il en est
   * vraiment, et seul un lecteur qui n'a encore rien joué retombe sur la position qu'on lui a
   * donnée. Sans ce dernier point, une reconstruction que personne n'avait demandée — il y en avait
   * une à chaque réduction du lecteur — renvoyait le film à son point de départ.
   */
  openingSeconds(position: number, sessionResumeAt: number | null | undefined, serverResume: number | null | undefined): number {
    return this.rebuildAt ?? (position > 0 ? position : sessionResumeAt ?? serverResume ?? 0);
  }

  /** Le prochain pipeline reste en pause — ou non : un changement de piste sur un film qui joue. */
  setKeepPaused(paused: boolean): void {
    this.keepPaused = paused;
  }

  /** Le pipeline qui démarre doit-il rester en pause ? Une seule fois. */
  consumeKeepPaused(): boolean {
    if (!this.keepPaused) return false;
    this.keepPaused = false;
    return true;
  }

  /**
   * La source est perdue en pleine lecture : la reconstruire, ou y renoncer.
   *
   * Une source fermée n'est pas une panne à signaler, c'est un pipeline à reconstruire — Safari en
   * ferme une de temps à autre sur un échec de décodage qu'il n'explique pas. Seule une perte qui se
   * répète est finalement rapportée. Et le même endroit deux fois, c'est ce que la plateforme ne
   * peut pas prendre : le relire échouerait de même, la lecture reprend au-delà.
   */
  sourceLost(where: number, now: number): LossDecision {
    if (!this.spendRebuild(now)) return { kind: "giveUp" };
    const again = this.lastLossAt !== null && Math.abs(where - this.lastLossAt) < SAME_PLACE_SECONDS;
    this.lastLossAt = where;
    return { kind: "rebuild", at: again ? where + REBUILD_STEP_SECONDS : where, skipped: again, attempt: this.rebuilds };
  }

  /**
   * Au retour d'arrière-plan, la plateforme avait fermé la source : où reconstruire, ou `null`.
   *
   * Rien si une reconstruction attend déjà, ou si le budget est épuisé. Un retour qui laisse la
   * lecture en pause (`hold`) garde la reconstruction en pause, au même endroit un peu en arrière.
   * Un film fini aussi, par la règle de `restart`, qui vaut pour toute reconstruction.
   */
  backgroundLost(facts: { position: number; hold: { at: number } | null }, now: number): number | null {
    if (this.rebuildAt !== null) return null;
    if (!this.spendRebuild(now)) return null;
    if (facts.hold) this.keepPaused = true;
    return facts.hold ? facts.hold.at : facts.position;
  }

  /**
   * Le délai avant le prochain essai, le réseau revenu.
   *
   * Espacé à chaque échec : « en ligne » dit que le téléphone a du réseau, pas que le serveur
   * répond. Pendant un redéploiement, le lecteur relançait toutes les 0,8 s, sans fin (relu le
   * 22/09/2026). 0,8 s, puis 1,6, 3,2… jusqu'à 30 s ; le compte repart à zéro dès qu'une image est
   * revenue (`ready`).
   */
  networkRetryDelay(): number {
    return Math.min(800 * 2 ** this.networkRetries, 30_000);
  }

  /** Un nouvel essai réseau part. */
  noteNetworkRetry(): void {
    this.networkRetries += 1;
  }

  /** Passer la main — au lecteur serveur, ou à l'écran d'erreur. Une seule fois : vrai la première. */
  stepAside(): boolean {
    if (this.steppedAside) return false;
    this.steppedAside = true;
    return true;
  }

  /** La main a-t-elle déjà été passée ? */
  hasSteppedAside(): boolean {
    return this.steppedAside;
  }
}
