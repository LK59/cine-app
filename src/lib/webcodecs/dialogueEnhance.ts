/**
 * « Améliorer les dialogues » — le traitement des voix dans la chaîne audio du lecteur natif
 * (11/10/2026, bêta, administrateur seulement).
 *
 * Pourquoi ici et pas dans Web Audio : la sonde 8.39.0 l'a montré sur iPhone, WebKit ne fait pas
 * passer le son d'un élément nourri par ManagedMediaSource dans `createMediaElementSource` — le
 * contexte tourne, les niveaux restent à −∞, le film joue sans traitement. Le seul endroit où le son
 * passe entre nos mains sur tous les navigateurs, c'est le ré-encodage : décodé, puis rendu à
 * l'encodeur (`AudioTranscoder`). Le traitement s'insère là, après le repli éventuel (`fold`) et avant
 * la permutation propre à l'encodeur d'Apple (`toCodecChannelOrder`) : les plans y sont dans l'ordre
 * standard L R C LFE Ls Rs (ou L R C LFE Lrs Rrs Ls Rs), celui du décodeur.
 *
 * **Les canaux de sortie sont ceux que la chaîne a choisis** — demande de Louis : un 5.1 reste un
 * 5.1, la stéréo reste stéréo, rien n'est replié pour traiter. La spatialisation est gardée ; on
 * déplace l'équilibre, pas les sons :
 * - 5.1 / 7.1 / 3.0 : le centre (où vivent presque toutes les voix) est égalisé et remonté, les
 *   faces et les ambiances un peu baissées, le caisson davantage (le grave des explosions est ce qui
 *   couvre les voix le soir) ;
 * - stéréo : pas de canal des voix, mais la voix est au milieu — mid/side : le milieu égalisé et
 *   remonté, les côtés baissés, puis rendus en L/R ;
 * - mono : le canal égalisé ;
 * - toute autre disposition (4.0, 5.0, 6.1…) : le canal de rang 2 n'est pas sûrement un centre
 *   (CLAUDE.md, « le nombre de canaux ne nomme pas la disposition ») — compression seule, aucun
 *   canal favorisé.
 * Puis un compresseur lié (un seul gain pour tous les canaux : l'image ne bouge pas), un gain de
 * rattrapage, et un limiteur sous −1 dBFS pour qu'aucun échantillon n'arrive saturé à l'encodeur.
 *
 * Désactivé, ce module n'est même pas instancié : `AudioTranscoder` ne reçoit pas de processeur et
 * le chemin est celui d'avant, à l'octet près (banc `aac-regress-bench`).
 */

export type DialogueMode = "off" | "on" | "strong";

/** Les réglages d'un mode, en dB sauf mention. Exportés pour les tests. */
export interface DialogueTuning {
  center: number;
  front: number;
  surround: number;
  lfe: number;
  mid: number;
  side: number;
  /** Présence des voix : un pic à 3 kHz. */
  presence: number;
  /** Médium : un pic plus large à 1 kHz. */
  body: number;
  /** Grave boueux : une étagère basse à 150 Hz (négative). */
  low: number;
  threshold: number;
  ratio: number;
  makeup: number;
}

/**
 * Réglés sur six scènes 5.1 réelles (« Interstellar », « Manchester by the Sea », 11/10/2026 —
 * mesure : niveau d'ensemble, 10e et 95e centiles du niveau par fenêtre de 400 ms, centre contre
 * faces). « Améliorer » : niveau moyen −0,6 dB, scènes calmes +1 à +7 dB, voix +4 dB sur les faces.
 * « Encore plus fort » : niveau moyen −2 dB, scènes calmes jusqu'à +11 dB, les plus fortes −10 à
 * −19 dB, voix +5,7 dB. Aucune crête au-dessus de −1 dBFS. Les seuils sont en puissance totale
 * (somme des canaux), pas en crête — voir le détecteur.
 */
export const DIALOGUE_TUNING: Record<Exclude<DialogueMode, "off">, DialogueTuning> = {
  // « Améliorer les dialogues » : on comprend mieux, le film garde sa dynamique.
  on: { center: 4, front: -1, surround: -2, lfe: -4, mid: 3, side: -3, presence: 4, body: 1.5, low: -3, threshold: -24, ratio: 2.5, makeup: 3 },
  // « Encore plus fort » : pour regarder bas — les explosions ne dépassent presque plus les voix.
  strong: { center: 6, front: -3, surround: -5, lfe: -10, mid: 4, side: -6, presence: 6, body: 2, low: -5, threshold: -32, ratio: 5, makeup: 9 },
};

const dbToGain = (db: number) => Math.pow(10, db / 20);
const CEILING = dbToGain(-1);
const KNEE_DB = 6;

/** Un filtre biquadratique (formules RBJ), forme directe I, état gardé d'un bloc à l'autre. */
class Biquad {
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;
  private constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number
  ) {}

  static peaking(sampleRate: number, freq: number, q: number, gainDb: number): Biquad {
    const a = Math.pow(10, gainDb / 40);
    const w = (2 * Math.PI * freq) / sampleRate;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    const a0 = 1 + alpha / a;
    return new Biquad((1 + alpha * a) / a0, (-2 * cos) / a0, (1 - alpha * a) / a0, (-2 * cos) / a0, (1 - alpha / a) / a0);
  }

  static lowShelf(sampleRate: number, freq: number, gainDb: number): Biquad {
    const a = Math.pow(10, gainDb / 40);
    const w = (2 * Math.PI * freq) / sampleRate;
    const cos = Math.cos(w);
    // Pente S = 1.
    const alpha = (Math.sin(w) / 2) * Math.SQRT2;
    const sq = 2 * Math.sqrt(a) * alpha;
    const a0 = a + 1 + (a - 1) * cos + sq;
    return new Biquad(
      (a * (a + 1 - (a - 1) * cos + sq)) / a0,
      (2 * a * (a - 1 - (a + 1) * cos)) / a0,
      (a * (a + 1 - (a - 1) * cos - sq)) / a0,
      (-2 * (a - 1 + (a + 1) * cos)) / a0,
      (a + 1 + (a - 1) * cos - sq) / a0
    );
  }

  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/** La chaîne d'égalisation des voix, appliquée au signal qui les porte (centre, milieu ou mono). */
class VoiceEq {
  private readonly stages: Biquad[];
  constructor(sampleRate: number, t: DialogueTuning) {
    this.stages = [
      Biquad.lowShelf(sampleRate, 150, t.low),
      Biquad.peaking(sampleRate, 1000, 0.8, t.body),
      Biquad.peaking(sampleRate, 3000, 0.9, t.presence),
    ];
  }
  run(x: number): number {
    let y = x;
    for (const s of this.stages) y = s.run(y);
    return y;
  }
  reset(): void {
    for (const s of this.stages) s.reset();
  }
}

type Layout = "mono" | "stereo" | "centre" | "other";

function layoutOf(channels: number): Layout {
  if (channels === 1) return "mono";
  if (channels === 2) return "stereo";
  // 3.0 (L R C), 5.1 et 7.1 : le rang 2 est le centre dans l'ordre standard. Les autres comptes
  // ne le garantissent pas — voir l'en-tête.
  if (channels === 3 || channels === 6 || channels === 8) return "centre";
  return "other";
}

export class DialogueEnhancer {
  private readonly layout: Layout;
  private readonly eq: VoiceEq;
  /** Gain fixe par canal (plans hors centre), selon la disposition. */
  private readonly gains: number[];
  private readonly midGain: number;
  private readonly sideGain: number;
  private readonly threshold: number;
  private readonly ratio: number;
  private readonly makeup: number;
  private readonly compAttack: number;
  private readonly compRelease: number;
  private readonly limRelease: number;
  /** Enveloppe du détecteur du compresseur, en linéaire. */
  private env = 0;
  /** Gain courant du limiteur (≤ 1). */
  private limGain = 1;

  constructor(
    readonly sampleRate: number,
    readonly channels: number,
    readonly mode: Exclude<DialogueMode, "off">
  ) {
    const t = DIALOGUE_TUNING[mode];
    this.layout = layoutOf(channels);
    this.eq = new VoiceEq(sampleRate, t);
    this.gains = Array.from({ length: channels }, (_, i) => {
      if (this.layout !== "centre") return 1;
      if (i === 0 || i === 1) return dbToGain(t.front);
      if (i === 2) return dbToGain(t.center);
      if (i === 3 && channels > 3) return dbToGain(t.lfe);
      return dbToGain(t.surround);
    });
    this.midGain = dbToGain(t.mid);
    this.sideGain = dbToGain(t.side);
    this.threshold = t.threshold;
    this.ratio = t.ratio;
    this.makeup = dbToGain(t.makeup);
    const coef = (ms: number) => Math.exp(-1 / ((ms / 1000) * sampleRate));
    this.compAttack = coef(30);
    this.compRelease = coef(300);
    this.limRelease = coef(80);
  }

  /** Le gain du compresseur pour un niveau de détecteur, genou doux. */
  private compGain(levelDb: number): number {
    const over = levelDb - this.threshold;
    let reduction: number;
    if (over <= -KNEE_DB / 2) reduction = 0;
    else if (over >= KNEE_DB / 2) reduction = over * (1 - 1 / this.ratio);
    else {
      const x = over + KNEE_DB / 2;
      reduction = ((1 - 1 / this.ratio) * x * x) / (2 * KNEE_DB);
    }
    return dbToGain(-reduction);
  }

  /**
   * Traite un bloc. Rend des plans neufs, de même nombre et de même longueur : les plans reçus
   * peuvent appartenir au décodeur, on n'y écrit jamais.
   */
  process(planes: Float32Array[]): Float32Array[] {
    const n = planes.length;
    if (n !== this.channels || n === 0) return planes;
    const frames = planes[0].length;
    const out = planes.map(() => new Float32Array(frames));
    const frame = new Float64Array(n);
    for (let i = 0; i < frames; i++) {
      // 1. Mise en forme des voix, selon la disposition.
      if (this.layout === "stereo") {
        const l = planes[0][i];
        const r = planes[1][i];
        const mid = this.eq.run((l + r) * 0.5) * this.midGain;
        const side = (l - r) * 0.5 * this.sideGain;
        frame[0] = mid + side;
        frame[1] = mid - side;
      } else if (this.layout === "mono") {
        frame[0] = this.eq.run(planes[0][i]);
      } else if (this.layout === "centre") {
        for (let c = 0; c < n; c++) {
          const x = planes[c][i];
          frame[c] = (c === 2 ? this.eq.run(x) : x) * this.gains[c];
        }
      } else {
        for (let c = 0; c < n; c++) frame[c] = planes[c][i];
      }
      // 2. Compresseur lié : un seul gain pour tous les canaux. Le détecteur suit la *puissance*
      // (somme des carrés des canaux), lissée — le niveau qu'on entend. Un détecteur de crête,
      // essayé d'abord, comprimait presque tout le temps : les crêtes d'un film passent 12 à 15 dB
      // au-dessus du niveau des voix, et le son entier baissait de 10 dB et plus (mesuré sur
      // « Interstellar », 11/10/2026).
      let power = 0;
      for (let c = 0; c < n; c++) power += frame[c] * frame[c];
      this.env = power > this.env ? this.compAttack * this.env + (1 - this.compAttack) * power : this.compRelease * this.env + (1 - this.compRelease) * power;
      const levelDb = this.env > 1e-12 ? 10 * Math.log10(this.env) : -180;
      const g = this.compGain(levelDb) * this.makeup;
      // 3. Limiteur sous −1 dBFS : attaque immédiate, relâche douce.
      let outPeak = 0;
      for (let c = 0; c < n; c++) {
        frame[c] *= g;
        const a = Math.abs(frame[c]);
        if (a > outPeak) outPeak = a;
      }
      const need = outPeak > CEILING ? CEILING / outPeak : 1;
      this.limGain = need < this.limGain ? need : this.limRelease * this.limGain + (1 - this.limRelease) * Math.min(1, need);
      if (this.limGain > need) this.limGain = need;
      for (let c = 0; c < n; c++) out[c][i] = frame[c] * this.limGain;
    }
    return out;
  }

  /** Après un saut : aucune mémoire du passage d'avant (filtres, enveloppes). */
  reset(): void {
    this.eq.reset();
    this.env = 0;
    this.limGain = 1;
  }
}
