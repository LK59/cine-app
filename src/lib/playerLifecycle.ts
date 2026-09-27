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
      /**
       * Où la source a été perdue. Rendu plutôt que recalculé depuis `at` : le message du journal
       * doit rester exactement celui d'avant le découpage, arrondi compris.
       */
      from: number;
      /** Le passage a été sauté : le spectateur doit en être averti. */
      skipped: boolean;
      /** Le numéro de cette reconstruction dans la série en cours. */
      attempt: number;
    }
  | { kind: "giveUp" }
  /** Le lecteur n'est plus le sien : il a passé la main, ou il se ferme. Rien à faire. */
  | { kind: "ignore" };

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
  /** Le spectateur a fermé : le lecteur vit encore le temps de son fondu, et ne décide plus rien. */
  private closing = false;
  /** Une coupure réseau a été signalée, et aucune reconstruction n'a encore suivi. */
  private networkDown = false;
  /** La ligne `stop` de la séance est partie. */
  private stopReported = false;

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
  restart(at: number, facts: { viewerPausedAt: number | null; hiddenAt: number | null; byViewer?: boolean }): boolean {
    // Le seul point de contrôle des reconstructions automatiques — perte, retour d'arrière-plan,
    // nouvel essai réseau, reprise d'un changement de piste : une fois la main passée ou pendant la
    // fermeture, elles sont refusées ici, au moment même où elles partiraient. Un contrôle posé
    // seulement là où elles se programment laissait passer un minuteur armé avant (relu le
    // 27/09/2026 : le nouvel essai réseau relançait un lecteur en train de se fermer).
    //
    // Une reconstruction demandée par le spectateur (réessayer, une piste, le plafond HDR) passe
    // toujours, et redonne la main au lecteur : ses pannes suivantes doivent de nouveau s'afficher,
    // au lieu d'être ignorées par un lecteur qui se croirait encore abandonné.
    // Pendant la fermeture, rien ne passe — pas même une demande du spectateur : un changement de
    // piste pendant le fondu reconstruisait un lecteur en train de partir, et écrivait une ligne
    // `start` après la ligne `stop`.
    if (this.closing) return false;
    if (facts.byViewer) {
      // Le spectateur relance : le lecteur redevient le sien, avec un budget neuf — il vient de
      // demander un nouvel essai, pas le quatrième d'une série épuisée.
      this.steppedAside = false;
      this.rebuilds = 0;
    } else if (this.isOver()) {
      return false;
    }
    this.networkDown = false;
    const { viewerPausedAt: pausedAt, hiddenAt } = facts;
    if (pausedAt !== null && (hiddenAt === null || hiddenAt < pausedAt || pausedAt < hiddenAt - 1000)) this.keepPaused = true;
    // Un film fini attend sur son écran de fin, quelle que soit la cause de la reconstruction.
    // Seul le retour d'arrière-plan y veillait (24/09/2026) : une source perdue sur l'écran de fin,
    // ou un nouvel essai après une coupure, reconstruisait en lecture — le film rejouait ses
    // dernières secondes et annonçait sa fin une seconde fois. L'élément fini n'enregistre pas de
    // pause du spectateur, d'où cette règle à part (point 2, docs/cycle-de-vie-lecteur.md).
    if (this.ended) this.keepPaused = true;
    this.rebuildAt = at;
    return true;
  }

  /** Le fichier est-il allé au bout, sans rien qui l'ait relancé depuis ? */
  isEnded(): boolean {
    return this.ended;
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
    if (this.isOver()) return { kind: "ignore" };
    if (!this.spendRebuild(now)) return { kind: "giveUp" };
    const again = this.lastLossAt !== null && Math.abs(where - this.lastLossAt) < SAME_PLACE_SECONDS;
    this.lastLossAt = where;
    return { kind: "rebuild", at: again ? where + REBUILD_STEP_SECONDS : where, from: where, skipped: again, attempt: this.rebuilds };
  }

  /**
   * Au retour d'arrière-plan, la plateforme avait fermé la source : où reconstruire, ou `null`.
   *
   * Rien si une reconstruction attend déjà, ou si le budget est épuisé. Un retour qui laisse la
   * lecture en pause (`hold`) garde la reconstruction en pause, au même endroit un peu en arrière.
   * Un film fini aussi, par la règle de `restart`, qui vaut pour toute reconstruction.
   */
  backgroundLost(facts: { position: number; hold: { at: number } | null }, now: number): number | null {
    if (this.isOver() || this.rebuildAt !== null) return null;
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

  /**
   * Une coupure réseau est signalée.
   *
   * Le pipeline qui la signale peut encore finir de s'attacher et avoir quelques secondes en
   * tampon : il ne doit pas les jouer derrière l'écran de coupure — le nouvel essai rouvrira à la
   * position de la coupure, et ces secondes seraient entendues deux fois (relu le 27/09/2026).
   */
  noteNetworkLost(): void {
    this.networkDown = true;
  }

  /** Une coupure attend son nouvel essai : rien ne doit jouer d'ici là. */
  isNetworkLost(): boolean {
    return this.networkDown;
  }

  /** Une reconstruction automatique serait-elle permise maintenant ? À demander avant d'en préparer une. */
  mayRebuild(): boolean {
    return !this.isOver();
  }

  /** Un nouvel essai réseau part. */
  noteNetworkRetry(): void {
    this.networkRetries += 1;
  }

  /**
   * Passer la main — au lecteur serveur, ou à l'écran d'erreur. Une seule fois : vrai la première.
   *
   * Et jamais pendant la fermeture : une panne qui tombait dans les 200 ms du fondu (le minuteur
   * d'abandon, un pipeline qui meurt) écrivait une ligne `fallback` après la ligne `stop`, et
   * rangeait le film parmi ceux que le lecteur natif ne sait pas lire — le lecteur serveur le
   * rouvrait ensuite jusqu'au rechargement de l'app (point 5, docs/cycle-de-vie-lecteur.md).
   */
  stepAside(): boolean {
    if (this.steppedAside || this.closing) return false;
    this.steppedAside = true;
    return true;
  }

  /**
   * La ligne `stop` peut-elle partir ? Vrai une seule fois — et jamais après avoir passé la main :
   * la ligne `fallback` a déjà raconté la fin de la séance ici, le lecteur serveur prend la suite.
   */
  claimStop(): boolean {
    if (!this.keepsUnsentStop()) return false;
    this.stopReported = true;
    return true;
  }

  /**
   * Le bilan gardé sur l'appareil (au cas où iOS tuerait la page) doit-il encore être réécrit ?
   * Tant que la séance vit : ni après son arrêt, ni après avoir passé la main.
   */
  keepsUnsentStop(): boolean {
    return !this.stopReported && !this.steppedAside;
  }

  /**
   * La page revient du cache du navigateur (retour arrière) et le film reprend : son arrêt réel,
   * plus tard, doit être noté lui aussi — il ne l'était jamais (23/09/2026).
   */
  reopenStop(): void {
    this.stopReported = false;
  }

  /** Le spectateur ferme le lecteur. */
  noteClosing(): void {
    this.closing = true;
  }

  /**
   * Le lecteur a-t-il cessé de décider pour lui-même ?
   *
   * Après avoir passé la main ou pendant la fermeture, plus aucune initiative : ni reconstruction
   * après une perte, ni reconstruction au retour d'arrière-plan, ni nouvel essai réseau. Sans lecteur
   * serveur, un abandon affiche son erreur — et un retour d'arrière-plan qui trouvait la source
   * fermée reconstruisait quand même, effaçant l'erreur et relançant un film abandonné (point 4).
   * Une relance demandée par le spectateur, elle, reste permise : elle ne passe pas par ici.
   */
  isOver(): boolean {
    return this.steppedAside || this.closing;
  }


}
