// Le départ d'une ouverture depuis le début, retenu jusqu'à la première image (26/10/2026).
//
// Le constat, dans les journaux de production : 57 départs de 0 sur 377 restaient figés juste après
// avoir démarré, contre 0 reprise sur 221 — 69 % sur iPhone quand la vidéo part en Dolby Vision
// (`dvh1`), environ 12 % sur iPhone hors DV, 5 % sur Safari Mac, 17 % ailleurs. Les étapes de la
// ligne `opening` disaient toujours la même chose : l'hôte appelle `play()` dès l'attache, avant le
// moindre média ; le premier fragment arrive, sa première image est à 0,21 s (image clé de CTO
// 210 000 µs, tfdt 0) ; l'atterrissage pose la tête à 0,25 s **pendant que l'élément joue déjà** ;
// `playing` arrive (« élément : repart à 0.25 s ») et l'horloge ne bouge pas, jusqu'à ce que la
// poussée de l'ouverture (+0,08 s) la libère 750 à 1 000 ms plus tard. Une reprise ne se fige jamais :
// la tête y est posée avant le départ, et Safari décode jusqu'à la cible avant d'annoncer `playing`.
// Les octets du remultiplexeur ont été vérifiés sur le vrai fichier (bench.spec.ts) : ils ne sont pas
// en cause, et rien ici n'y touche.
//
// D'où ceci : pour une ouverture depuis le début (celle qui ne passe pas par `remuxer.seekTo`), la
// tête atterrit **élément à l'arrêt**, et l'hôte n'appelle `play()` — le même appel qu'avant, au
// même endroit de `startRemux`, donc sous la même politique de lecture automatique — qu'une fois le
// saut d'atterrissage achevé et une image décodée sous la tête. Le départ ressemble alors à celui
// d'une reprise. Borné dans le temps des deux côtés : un événement qui ne vient pas ne laisse jamais
// le film à l'arrêt, il retrouve seulement le départ d'avant, et les poussées de l'horloge figée
// restent le filet.
//
// Les constantes vivent ici plutôt que dans mseTuning.ts : elles n'ont de sens que pour cette
// retenue, et ne règlent rien d'autre.

import { trace } from "./trace";

/**
 * Une fois la tête posée sur le média, le plus long que le départ attende son image.
 *
 * Le décodage d'une image clé posée au bord du média prend quelques dizaines de millisecondes ; la
 * poussée qui libérait le gel arrivait, elle, 750 à 1 000 ms après l'atterrissage. Une seconde ne
 * coûte donc jamais plus que l'ancien gel, et au-delà le départ se fait comme avant — la poussée de
 * l'horloge figée et la position redemandée de l'ouverture reprennent alors leur rôle.
 */
export const START_HOLD_LANDED_MS = 1000;

/**
 * Et depuis l'ouverture, le plus long qu'il attende tout court, premier média compris.
 *
 * Le même que la fenêtre où la garde insiste encore pour démarrer un film (`START_WINDOW_MS`,
 * playbackGuard.ts) : au-delà, le départ est demandé quoi qu'il arrive, et ce qui suit est le
 * chemin d'avant — `play()` sur un élément sans média, que la garde relance à l'arrivée du média.
 */
export const START_HOLD_MAX_MS = 15000;

/** Ce que la retenue lit de la source. */
export interface StartHoldHost {
  readonly video: HTMLVideoElement;
  /** La tête est sur du média jouable — pas seulement « du média est arrivé ». */
  headOnMedia(): boolean;
  /** Le départ est permis ; `timedOut` quand c'est une borne qui l'a permis, pas l'image. */
  released(timedOut: boolean): void;
}

/** Les événements de l'élément qui peuvent dire que l'image est là, ou que le départ a déjà eu lieu. */
const EVENTS = ["seeked", "loadeddata", "canplay", "play"] as const;

/** `HTMLMediaElement.HAVE_CURRENT_DATA`, écrit en clair : le module tourne aussi sans DOM (tests). */
const HAVE_CURRENT_DATA = 2;

type FrameVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export class OpeningStartHold {
  /** Résolue quand le départ est permis — ou quand la source est détruite. */
  readonly released: Promise<void>;
  private release: (() => void) | null = null;
  private readonly armedAt = Date.now();
  private landedTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly maxTimer: ReturnType<typeof setTimeout>;
  private frameCallback: number | null = null;

  constructor(private readonly host: StartHoldHost) {
    this.released = new Promise<void>((resolve) => {
      this.release = resolve;
    });
    for (const type of EVENTS) host.video.addEventListener(type, this.check);
    this.maxTimer = setTimeout(() => this.open(`aucune image en ${START_HOLD_MAX_MS / 1000} s`, true), START_HOLD_MAX_MS);
  }

  /** Vrai tant que le départ attend : `play()` n'a pas à être appelé, ni par l'hôte ni par la garde. */
  get holding(): boolean {
    return this.release !== null;
  }

  /**
   * Relu après chaque envoi (la tête vient peut-être d'être posée) et à chaque événement de
   * l'élément qui peut annoncer l'image.
   */
  readonly check = (): void => {
    if (!this.holding) return;
    const video = this.host.video;
    // Quelqu'un d'autre a lancé l'élément (le spectateur, un autre hôte) : il n'y a plus de départ à
    // retenir, seulement à ne pas en demander un second.
    if (!video.paused) return this.open("élément déjà lancé", false);
    // Le premier média n'est pas encore sous la tête : l'atterrissage (`nudgeIntoBuffer`, qu'une
    // licence permet élément à l'arrêt) l'y posera à l'envoi suivant.
    if (!this.host.headOnMedia()) return;
    // Le saut d'atterrissage est fini et l'image de la position est décodée : c'est ce qu'une reprise
    // obtient avant son `playing`, et ce que le départ du début n'avait jamais.
    if (!video.seeking && video.readyState >= HAVE_CURRENT_DATA) return this.open("image prête", false);
    // Posée, l'image en route : la borne courte part d'ici, une seule fois.
    if (this.landedTimer !== null) return;
    this.landedTimer = setTimeout(() => this.open(`pas d'image ${START_HOLD_LANDED_MS} ms après l'atterrissage`, true), START_HOLD_LANDED_MS);
    this.watchFrame();
  };

  /**
   * L'image présentée elle-même, là où le navigateur sait la signaler : un élément à l'arrêt en
   * présente une à la fin d'un saut. Un appoint aux événements, jamais une condition.
   */
  private watchFrame(): void {
    const video = this.host.video as FrameVideo;
    const request = video.requestVideoFrameCallback?.bind(video);
    if (!request) return;
    const step = () => {
      this.frameCallback = null;
      if (!this.holding) return;
      // Une image présentée pendant le saut est encore celle d'avant : on attend la suivante.
      if (video.seeking) {
        this.frameCallback = request(step);
        return;
      }
      this.open("image présentée", false);
    };
    this.frameCallback = request(step);
  }

  private open(why: string, timedOut: boolean): void {
    const release = this.release;
    if (release === null) return;
    const video = this.host.video;
    trace(
      `ouverture : départ permis (${why}) — tête à ${video.currentTime.toFixed(2)} s, ` +
        `readyState ${video.readyState}${video.seeking ? ", saut en cours" : ""}, après ${Date.now() - this.armedAt} ms`
    );
    this.stop();
    release();
    this.host.released(timedOut);
  }

  private stop(): void {
    this.release = null;
    for (const type of EVENTS) this.host.video.removeEventListener(type, this.check);
    clearTimeout(this.maxTimer);
    if (this.landedTimer !== null) clearTimeout(this.landedTimer);
    this.landedTimer = null;
    if (this.frameCallback !== null) (this.host.video as FrameVideo).cancelVideoFrameCallback?.(this.frameCallback);
    this.frameCallback = null;
  }

  /**
   * La source meurt : la promesse se résout quand même — une attente que personne ne lève est un
   * chargement sans fin —, et l'hôte, qui revérifie après elle, ne lance rien.
   */
  destroy(): void {
    const release = this.release;
    if (release === null) return;
    this.stop();
    release();
  }
}
