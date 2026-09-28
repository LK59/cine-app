import { seekArrived } from "@/lib/webcodecs/seekArrival";

/**
 * Les sauts vus par l'hôte natif : ce que le spectateur a demandé et pas encore atteint, et la
 * mesure du saut en cours pour la ligne `seek` du journal.
 *
 * Le saut lui-même appartient au moteur (`MseSource`, `SeekLifecycle`) : c'est lui qui vide les
 * tampons, repositionne la lecture et atterrit. L'hôte n'en garde que deux faits, qui vivaient dans
 * deux références lues et écrites à six endroits de `ExperimentalPlayerHost` : la **cible
 * demandée** — la position à laquelle reconstruire si une piste change pendant le saut — et la
 * **mesure** du saut, pour le journal. Réunis ici le 27/09/2026 (étape 4 du découpage,
 * docs/cycle-de-vie-lecteur.md), à l'identique ; le journal reste écrit par l'hôte.
 */

/** Ce qu'on mesure d'un saut, de la demande à l'arrivée. */
export interface SeekTiming {
  from: number;
  to: number;
  startedAt: number;
  /** Le temps passé en arrière-plan au moment de la demande — retranché de la durée mesurée. */
  hiddenAtStart: number;
  /** La cible était-elle déjà en tampon au moment de la demande ? */
  buffered: boolean;
  /** Les plages en tampon les plus proches de la cible, écrites court. */
  ranges: string;
}

export class HostSeek {
  /**
   * La dernière position demandée et pas encore atteinte.
   *
   * Deux gestes rapprochés ne doivent pas en perdre un : un saut encore en chargement suivi d'un
   * changement de piste reconstruisait le lecteur à la position d'*avant* le saut, et un saut fait
   * pendant la reconstruction était écrasé par la position de départ du nouveau lecteur (22/09/2026).
   */
  private requested: number | null = null;
  /** Le saut en cours de mesure — le dernier demandé seulement. */
  private timing: SeekTiming | null = null;

  /** Un saut est demandé : c'est la cible qui compte désormais. */
  request(seconds: number): void {
    this.requested = seconds;
  }

  /** Un saut demandé n'est-il pas encore atteint ? Une attente pendant ce temps n'en est pas une. */
  pending(): boolean {
    return this.requested !== null;
  }

  /**
   * Rend la mesure en cours et l'oublie — celle qu'un nouveau saut remplace.
   *
   * Un saut qui n'arrivait pas là où il était demandé n'écrivait rien : la ligne ne partait qu'à
   * l'arrivée — 2012 sur iPhone (22/09/2026), une tête passée de 2141 à 1681 s sans une trace. La
   * mesure remplacée est rendue pour que l'hôte l'écrive, avec l'endroit où elle est tombée, avant
   * de commencer la suivante.
   */
  takeMeasure(): SeekTiming | null {
    const superseded = this.timing;
    this.timing = null;
    return superseded;
  }

  /** Commence la mesure d'un saut. */
  startMeasure(timing: SeekTiming): void {
    this.timing = timing;
  }

  /**
   * Plus de mesure en cours — hors du chemin natif, rien ne la fermerait : le saut suivant l'aurait
   * écrite en ligne fausse, tombée à 0, jamais arrivée (22/09/2026).
   */
  dropMeasure(): void {
    this.timing = null;
  }

  /**
   * Où en est le film selon ce que le spectateur a demandé, pas seulement selon ce qu'il a vu.
   *
   * Un saut lancé par autre chose que les commandes (le système, la télécommande) : l'élément dit
   * déjà où il va, la position lue ne le saura qu'une fois le saut fini.
   */
  intendedPosition(element: { seeking: boolean; currentTime: number } | null, position: number): number {
    if (this.requested !== null) return this.requested;
    if (element?.seeking) return element.currentTime;
    return position;
  }

  /**
   * L'élément dit le saut arrivé (`seeked`) à `currentTime`. La cible atteinte est oubliée ; la
   * mesure, si elle est arrivée, est rendue pour être écrite.
   */
  seeked(currentTime: number): SeekTiming | null {
    if (this.requested !== null && seekArrived(currentTime, this.requested)) this.requested = null;
    const timing = this.timing;
    if (timing && seekArrived(currentTime, timing.to)) {
      this.timing = null;
      return timing;
    }
    return null;
  }

  /**
   * Posé ailleurs que la cible — sur le premier média, sur l'image clé suivante — mais arrivé selon
   * le moteur : la cible demandée ne vaut plus. Restée en mémoire, elle servait de position au
   * changement de piste suivant, fût-il vingt minutes plus tard (audit du 22/09/2026).
   */
  settled(engineSeekPending: boolean | undefined, elementSeeking: boolean): SeekTiming | null {
    if (engineSeekPending !== false || elementSeeking) return null;
    if (this.requested !== null) this.requested = null;
    // Et sa mesure, rendue pour être écrite : un saut posé loin de sa cible — vers 0 sur un film dont
    // le son commence à 12 s, la tête posée sur le premier média — ne laissait aucune ligne `seek`,
    // n'était compté nulle part, et une position de fermeture « en retard » passait pour figée
    // (enquête du 28/09/2026).
    const timing = this.timing;
    this.timing = null;
    return timing;
  }

  /**
   * Le pipeline qui démarre est prêt, ouvert à `startSeconds`. Rend la cible à honorer maintenant —
   * un saut demandé pendant la reconstruction, ailleurs que là où elle a rouvert —, ou `null` si
   * l'ouverture l'a déjà atteinte (et alors elle est oubliée).
   */
  consumeAtReady(startSeconds: number): number | null {
    const asked = this.requested;
    if (asked !== null && Math.abs(asked - startSeconds) > 0.5) return asked;
    this.requested = null;
    return null;
  }
}

/**
 * La durée d'un saut, sans le temps passé en arrière-plan pendant qu'il attendait.
 *
 * Un saut lancé juste avant de quitter l'application et arrivé au retour comptait l'absence
 * entière : 286 s pour un Mac mis en veille (24/09/2026), ce qui faussait tout bilan des attentes.
 */
export function seekDuration(timing: Pick<SeekTiming, "startedAt" | "hiddenAtStart">, now: number, hiddenMsSoFar: number): number {
  return Math.max(0, now - timing.startedAt - (hiddenMsSoFar - timing.hiddenAtStart));
}

/**
 * Ce qu'il y avait en tampon autour d'une cible, au moment de la demander.
 *
 * Les plages elles-mêmes, pas seulement « la cible y est » (24/09/2026) : trois sauts notés
 * `buffered` ont trouvé leur cible vide 0,7 s plus tard, et la ligne ne permettait pas de dire ce
 * qu'il y avait autour. Les quatre plus proches de la cible, écrites court.
 */
export function describeBufferedAround(buffered: { length: number; start(i: number): number; end(i: number): number } | null, seconds: number): { buffered: boolean; ranges: string } {
  let inside = false;
  const near: [number, number][] = [];
  for (let i = 0; buffered && i < buffered.length; i++) {
    const start = buffered.start(i);
    const end = buffered.end(i);
    if (start <= seconds && seconds < end) inside = true;
    near.push([start, end]);
  }
  const ranges =
    near
      .sort((a, b) => Math.abs((a[0] + a[1]) / 2 - seconds) - Math.abs((b[0] + b[1]) / 2 - seconds))
      .slice(0, 4)
      .sort((a, b) => a[0] - b[0])
      .map(([start, end]) => `${start.toFixed(1)}–${end.toFixed(1)}`)
      .join(" · ") || "vide";
  return { buffered: inside, ranges };
}
