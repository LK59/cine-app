/**
 * Garder la sortie audio de l'appareil éveillée pendant une pause (Lumen serveur, essai du 17/11/2026).
 *
 * Mesuré sur un enregistrement d'écran d'iPhone (30 reprises, *Mr. Robot* en HLS natif) : la pause coupe le son en
 * ~0,12 s, mais à la reprise l'image repart aussitôt et le son ~0,45 s plus tard (médiane, 0,40 à 3,25 s) — la
 * demi-seconde de son est perdue. YouTube dans Safari fait de même ; les apps Photos et TV d'Apple, non. Une pause de
 * 0,08 s a repris avec 0,05 s de retard : la sortie audio n'est donc pas encore endormie juste après une pause, et
 * c'est son réveil qui coûte. Le lecteur actuel le cache autrement (MediaSource : l'horloge suit le son, l'image
 * attend), ce que le HLS natif ne fait pas — et Safari ne dit pas quand le son sort réellement.
 *
 * L'essai : pendant une pause, un son inaudible (−100 dB) joué par Web Audio garde la sortie éveillée ; à la reprise,
 * il s'arrête une seconde après que le film a repris. Borné à une minute de pause (au-delà, la demi-seconde revient,
 * mais une longue pause n'a pas de réplique coupée à défendre). Tout échec (pas de Web Audio, contexte refusé sans
 * geste) laisse le comportement ordinaire : rien ne dépend de ce module.
 */

/** Au-delà, la veille s'arrête : une pause longue n'a pas à garder la sortie audio allumée. */
export const KEEP_AWAKE_MAX_MS = 60_000;
/** Après la reprise, la veille dure encore un peu : le son du film prend le relais avant qu'elle se taise. */
export const KEEP_AWAKE_TAIL_MS = 1_000;

type AudioContextCtor = new () => AudioContext;

export class AudioKeepAwake {
  private context: AudioContext | null = null;
  private source: OscillatorNode | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;

  /** À la pause : la veille démarre (ou continue), pour au plus `KEEP_AWAKE_MAX_MS`. */
  start(): void {
    try {
      const Ctor = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext) as AudioContextCtor | undefined;
      if (!Ctor) return;
      if (!this.context) this.context = new Ctor();
      const context = this.context;
      if (!this.source) {
        const source = context.createOscillator();
        const gain = context.createGain();
        // −100 dB : inaudible, mais pas zéro — un gain nul peut être court-circuité et laisser la sortie s'endormir.
        gain.gain.value = 0.00001;
        source.connect(gain).connect(context.destination);
        source.start();
        this.source = source;
      }
      void context.resume().catch(() => {});
      this.arm(KEEP_AWAKE_MAX_MS);
    } catch {
      // Web Audio absent ou refusé : la reprise ordinaire.
    }
  }

  /** À la reprise : la veille se tait une seconde plus tard, le son du film ayant repris. */
  release(): void {
    if (this.context) this.arm(KEEP_AWAKE_TAIL_MS);
  }

  /** À la fermeture du lecteur. */
  dispose(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = null;
    this.halt();
    try {
      void this.context?.close().catch(() => {});
    } catch {
      // déjà fermé
    }
    this.context = null;
  }

  private arm(ms: number): void {
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      this.halt();
    }, ms);
  }

  private halt(): void {
    try {
      this.source?.stop();
      this.source?.disconnect();
    } catch {
      // déjà arrêté
    }
    this.source = null;
    try {
      void this.context?.suspend().catch(() => {});
    } catch {
      // contexte fermé
    }
  }
}
