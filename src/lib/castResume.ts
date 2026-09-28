/**
 * La position de reprise, reposée sur le téléviseur quand il ne l'a pas prise (28/09/2026).
 *
 * Le lecteur serveur n'applique la reprise qu'à `loadeddata` — plus tôt, Safari coupait le premier
 * segment que Jellyfin préparait (voir `startPlayback`, PlayerHost.tsx). Une diffusion AirPlay
 * établie *avant* cet instant emmène l'élément à 0 : la télé charge l'adresse depuis le début, et
 * le saut posé ensuite sur l'élément local peut se perdre pendant qu'elle charge. *Ted Lasso*
 * S01E05, 26/09/2026 : relais demandé à 1246 s, diffusion établie 2,8 s plus tard à 0, arrêt quatre
 * minutes après à 315 s — la télé était repartie du début. La veille, même épisode, la reprise avait
 * tenu : c'est une course, pas une règle.
 *
 * La cible est oubliée dès que l'élément se montre près d'elle ; tant qu'elle ne l'est pas, le
 * premier `playing` après l'établissement de la route — la télé a fini de charger — la repose.
 */

/** Plus près que cela de la cible, la reprise a tenu. */
export const CAST_RESUME_TOLERANCE_SECONDS = 10;
/**
 * Au-delà, la cible ne vaut plus : la course se joue dans les secondes de l'ouverture. Gardée plus
 * longtemps, une reprise jamais « vue » — le spectateur a sauté ailleurs pendant qu'elle se posait —
 * renvoyait la télé à cette position une heure plus tard (relecture du 28/09/2026).
 */
export const CAST_RESUME_WINDOW_MS = 60_000;

export class CastResume {
  private target: number | null = null;
  private plannedAt = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Une lecture part à cette position (0 ou absente : du début, rien à surveiller). */
  planned(seconds: number | undefined): void {
    this.target = seconds !== undefined && Number.isFinite(seconds) && seconds > CAST_RESUME_TOLERANCE_SECONDS ? seconds : null;
    this.plannedAt = this.now();
  }

  private expire(): void {
    if (this.target !== null && this.now() - this.plannedAt > CAST_RESUME_WINDOW_MS) this.target = null;
  }

  /** L'élément se montre à cette position : près de la cible, elle a tenu et on l'oublie. */
  observed(currentTime: number): void {
    if (this.target !== null && Number.isFinite(currentTime) && Math.abs(currentTime - this.target) < CAST_RESUME_TOLERANCE_SECONDS) this.target = null;
  }

  /** La cible à reposer maintenant, ou null. Une seule fois : rendue, elle est oubliée. */
  take(currentTime: number): number | null {
    this.expire();
    const target = this.target;
    if (target === null) return null;
    this.target = null;
    return Number.isFinite(currentTime) && Math.abs(currentTime - target) < CAST_RESUME_TOLERANCE_SECONDS ? null : target;
  }

  /** La cible en attente, pour le journal. */
  get pending(): number | null {
    this.expire();
    return this.target;
  }
}
