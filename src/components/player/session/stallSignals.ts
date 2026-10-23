// Les saccades en pleine lecture, pour la bascule sur la version allégée (DECISIONS.md §78) — la règle
// que le lecteur natif (`startRemux`, `ExperimentalPlayerHost.tsx`) et le lecteur serveur
// (`useServerSessionWaits`) écrivaient chacun, écrite une fois le 23/10/2026 (§115) : un blocage qui
// dure 5 s bascule s'il tient au réseau ; à la fin d'un blocage, le 2e de plus d'une seconde
// préchauffe, le 3e bascule (`StutterWatch.waitEndedSignal`) ; un blocage de plus d'une seconde est
// montré au simulateur de la page de test (`pushSlowLinkEvent`, rien s'il est éteint).
//
// Chaque hôte garde ce qui dit « réseau » (le verdict du diagnostic pour le natif ; pour le serveur,
// moins d'une seconde devant et hls.js seul, qui compte ses octets), son décompte (`SessionTally`),
// sa mesure des sauts et le texte du simulateur.
import { LONG_STALL_MS, type StutterWatch } from "@/lib/slowLinkPolicy";
import { pushSlowLinkEvent } from "@/lib/slowLinkMonitor";

export interface StallSignalHandlers {
  /** Basculer : `"long"` (5 s d'un seul blocage) ou `"repeated"` (le 3e). */
  onSwitch(kind: "long" | "repeated"): void;
  /** Préchauffer sans basculer (le 2e). */
  onPrewarm(): void;
}

/** Une fin de blocage : sa durée, le texte du simulateur, et s'il tenait au réseau (lu après le texte). */
export interface EndedWait {
  ms: number;
  text: string;
  network: () => boolean;
}

export class StallSignals {
  private longTimer: ReturnType<typeof setTimeout> | null = null;

  /** `stutter` est relu à chaque décision : le serveur le tient dans une référence. */
  constructor(
    private readonly stutter: () => StutterWatch,
    private readonly handlers: StallSignalHandlers
  ) {}

  /**
   * Un blocage commence : à 5 s, la bascule s'il tient au réseau. `longIsNetwork` est lu à l'échéance —
   * `null` : plus de blocage en cours, rien à décider.
   */
  started(longIsNetwork: () => boolean | null): void {
    this.cancel();
    this.longTimer = setTimeout(() => {
      this.longTimer = null;
      const network = longIsNetwork();
      if (network !== null && this.stutter().longWait(Date.now(), network)) this.handlers.onSwitch("long");
    }, LONG_STALL_MS);
  }

  /**
   * Le blocage est fini (image, pause) — `null` s'il n'y en avait pas : le minuteur s'arrête, et rien
   * d'autre.
   */
  ended(now: number, wait: EndedWait | null): void {
    this.cancel();
    // Le tableau du simulateur de la page de test, s'il est allumé (rien sinon).
    if (wait && wait.ms > 1000) pushSlowLinkEvent(wait.text);
    if (!wait) return;
    // Le 2e blocage préchauffe, le 3e bascule (§78) — la règle de bascule, elle, est inchangée.
    const signal = this.stutter().waitEndedSignal(now, wait.ms, wait.network());
    if (signal === "switch") this.handlers.onSwitch("repeated");
    else if (signal === "prewarm") this.handlers.onPrewarm();
  }

  /**
   * Le minuteur de 5 s s'arrête sans rien décider : un saut (ses attentes n'y entrent jamais), ou le
   * pipeline / l'effet qui s'en va — il ne doit rien décider pour le suivant.
   */
  cancel(): void {
    if (this.longTimer !== null) clearTimeout(this.longTimer);
    this.longTimer = null;
  }
}
