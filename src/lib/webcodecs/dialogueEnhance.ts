/**
 * « Améliorer les dialogues » — le traitement, dans la chaîne audio (DECISIONS §68).
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
 * 5.1, la stéréo reste stéréo, rien n'est replié pour traiter. Toute disposition autre que 1/2/3/6/8
 * canaux (4.0, 5.0, 6.1…) n'a pas sûrement de centre au rang 2 (CLAUDE.md, « le nombre de canaux ne
 * nomme pas la disposition ») : compression du fond seule, aucun canal favorisé.
 *
 * Désactivé, ce module n'est même pas instancié : `AudioTranscoder` ne reçoit pas de processeur et
 * le chemin est celui d'avant, à l'octet près (banc `aac-regress-bench`).
 *
 * v2 (12/10/2026). La v1 avait UN compresseur lié sur la puissance de tous les canaux et un rattrapage
 * de +3/+9 dB : en « Améliorer davantage », sur l'explosion du vaisseau d'« Interstellar », la voix
 * baissait avec le reste (−11 dB mesurés), et dans les passages calmes le rattrapage remontait
 * musique et ambiances — « ça boost pas que les voix » (Louis, au casque). La v2 sépare la voix du
 * fond et ne fait plus jamais dépendre la voix du fond :
 * - **voix** (centre en 3.0/5.1/7.1, milieu en stéréo, le canal en mono) : l'égalisation (coupe-bas
 *   150 Hz, corps 1 kHz, présence 3 kHz), un gain fixe, un **niveleur** qui ne fait que remonter une
 *   voix faible (jamais sous 0 dB, piloté par la voix seule, pas un silence), et une compression
 *   haute qui ne touche que les cris et les effets très forts du centre ;
 * - **fond** (tout le reste) : un gain fixe modéré, un **retrait pendant la parole** piloté par un
 *   détecteur de parole sur le canal des voix (énergie 300–3400 Hz contre pleine bande), un plafond
 *   relatif à la voix pendant la parole, et un compresseur du fond seul — le « mode nuit » s'applique
 *   aux explosions, jamais aux voix, et rien n'est jamais remonté ;
 * - deux limiteurs sous −1 dBFS, la voix et le fond, en dernier recours.
 * Validée à l'oreille par Louis sur trois scènes (Interstellar 2:08:50, Tenet 0:10:00 et 2:00:20) en
 * comparaison directe avec la v1 ; mesures dans DECISIONS §68.
 */

export type DialogueMode = "off" | "on" | "strong";

export interface DialogueTuning {
  /** Gains fixes, dB. */
  center: number;
  front: number;
  surround: number;
  lfe: number;
  mid: number;
  side: number;
  /** Égalisation des voix (comme la v1). */
  presence: number;
  body: number;
  low: number;
  /** Niveleur des voix : niveau visé (dBFS, puissance) et remontée maximale (dB). Ne baisse jamais. */
  voiceTarget: number;
  voiceMaxUp: number;
  /** Compression haute de la voix : seuil (dBFS) et rapport — cris, effets forts au centre. */
  voiceCeil: number;
  voiceCeilRatio: number;
  /** Retrait du fond pendant la parole (dB, négatif). */
  duck: number;
  /**
   * Fond relatif à la voix, pendant la parole : le fond n'a pas le droit de dépasser la voix de plus
   * de `margin` dB ; au-delà, il est comprimé au rapport `relRatio`. Relatif, parce que les mixages
   * n'ont pas le même niveau (Interstellar VF ~10 dB plus fort que Tenet au même endroit) : un seuil
   * absolu écrasait l'un et ignorait l'autre.
   */
  margin: number;
  relRatio: number;
  /** Compresseur absolu du fond (explosions, avec ou sans parole) : seuil (dBFS) et rapport. */
  bgThreshold: number;
  bgRatio: number;
}

export const DIALOGUE_TUNING: Record<Exclude<DialogueMode, "off">, DialogueTuning> = {
  on: {
    center: 3, front: -1, surround: -2, lfe: -4, mid: 2, side: -2,
    presence: 4, body: 1.5, low: -3,
    voiceTarget: -26, voiceMaxUp: 6, voiceCeil: -10, voiceCeilRatio: 2,
    duck: -2, margin: 4, relRatio: 2, bgThreshold: -10, bgRatio: 1.5,
  },
  strong: {
    center: 5, front: -2, surround: -3, lfe: -9, mid: 3, side: -3,
    presence: 6, body: 2, low: -5,
    voiceTarget: -22, voiceMaxUp: 9, voiceCeil: -10, voiceCeilRatio: 2,
    duck: -4, margin: 0, relRatio: 3, bgThreshold: -16, bgRatio: 2.5,
  },
};

const dbToGain = (db: number) => Math.pow(10, db / 20);
const CEILING = dbToGain(-1);
const KNEE_DB = 6;

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

  static peaking(sr: number, freq: number, q: number, gainDb: number): Biquad {
    const a = Math.pow(10, gainDb / 40);
    const w = (2 * Math.PI * freq) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const cos = Math.cos(w);
    const a0 = 1 + alpha / a;
    return new Biquad((1 + alpha * a) / a0, (-2 * cos) / a0, (1 - alpha * a) / a0, (-2 * cos) / a0, (1 - alpha / a) / a0);
  }

  static lowShelf(sr: number, freq: number, gainDb: number): Biquad {
    const a = Math.pow(10, gainDb / 40);
    const w = (2 * Math.PI * freq) / sr;
    const cos = Math.cos(w);
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

  static highPass(sr: number, freq: number, q = Math.SQRT1_2): Biquad {
    const w = (2 * Math.PI * freq) / sr;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    return new Biquad((1 + cos) / 2 / a0, -(1 + cos) / a0, (1 + cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  static lowPass(sr: number, freq: number, q = Math.SQRT1_2): Biquad {
    const w = (2 * Math.PI * freq) / sr;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    return new Biquad((1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0, (-2 * cos) / a0, (1 - alpha) / a0);
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

class Chain {
  constructor(private readonly stages: Biquad[]) {}
  run(x: number): number {
    let y = x;
    for (const s of this.stages) y = s.run(y);
    return y;
  }
  reset(): void {
    for (const s of this.stages) s.reset();
  }
}

/** Le gain (linéaire) d'un compresseur à genou doux pour un niveau en dB. */
function compGain(levelDb: number, threshold: number, ratio: number): number {
  const over = levelDb - threshold;
  let reduction: number;
  if (over <= -KNEE_DB / 2) reduction = 0;
  else if (over >= KNEE_DB / 2) reduction = over * (1 - 1 / ratio);
  else {
    const x = over + KNEE_DB / 2;
    reduction = ((1 - 1 / ratio) * x * x) / (2 * KNEE_DB);
  }
  return dbToGain(-reduction);
}

const smoothstep = (lo: number, hi: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};

const toDb = (power: number) => (power > 1e-12 ? 10 * Math.log10(power) : -120);

type Layout = "mono" | "stereo" | "centre" | "other";

function layoutOf(channels: number): Layout {
  if (channels === 1) return "mono";
  if (channels === 2) return "stereo";
  if (channels === 3 || channels === 6 || channels === 8) return "centre";
  return "other";
}

/** Une enveloppe de puissance à attaque et relâche distinctes. */
class Envelope {
  value = 0;
  constructor(private readonly attack: number, private readonly release: number) {}
  run(x: number): number {
    const k = x > this.value ? this.attack : this.release;
    this.value = k * this.value + (1 - k) * x;
    return this.value;
  }
}

export class DialogueEnhancer {
  private readonly layout: Layout;
  private readonly t: DialogueTuning;
  private readonly eq: Chain;
  /** Bande de la parole (300–3400 Hz), sur le canal des voix avant égalisation : le détecteur. */
  private readonly band: Chain;
  /** Gains fixes par plan (le canal des voix compris : son gain fixe). */
  private readonly gains: number[];
  private readonly voiceIndex: number;
  private readonly coef: (ms: number) => number;

  // États.
  private bandEnv!: Envelope;
  private fullEnv!: Envelope;
  private voiceEnv!: Envelope;
  private ceilEnv!: Envelope;
  private bgEnv!: Envelope;
  /** Niveau de la voix mise en forme, lent : la référence du fond relatif. */
  private refEnv!: Envelope;
  /** Gain du niveleur, en dB (≥ 0). */
  private levelUp = 0;
  /** Part de parole détectée, lissée (0…1). */
  private speech = 0;
  private limGain = 1;
  private voiceLim = 1;
  private readonly k: { speechUp: number; speechDown: number; levelDown: number; levelUp: number; lim: number };

  constructor(readonly sampleRate: number, readonly channels: number, readonly mode: Exclude<DialogueMode, "off">) {
    const t = (this.t = DIALOGUE_TUNING[mode]);
    this.layout = layoutOf(channels);
    this.coef = (ms: number) => Math.exp(-1 / ((ms / 1000) * sampleRate));
    const c = this.coef;
    this.k = { speechUp: c(40), speechDown: c(450), levelDown: c(60), levelUp: c(800), lim: c(80) };
    this.eq = new Chain([
      Biquad.lowShelf(sampleRate, 150, t.low),
      Biquad.peaking(sampleRate, 1000, 0.8, t.body),
      Biquad.peaking(sampleRate, 3000, 0.9, t.presence),
    ]);
    this.band = new Chain([Biquad.highPass(sampleRate, 300), Biquad.lowPass(sampleRate, 3400)]);
    this.voiceIndex = this.layout === "centre" ? 2 : 0;
    this.gains = Array.from({ length: channels }, (_, i) => {
      if (this.layout === "centre") {
        if (i === 0 || i === 1) return dbToGain(t.front);
        if (i === 2) return dbToGain(t.center);
        if (i === 3 && channels > 3) return dbToGain(t.lfe);
        return dbToGain(t.surround);
      }
      return 1;
    });
    this.reset();
  }

  reset(): void {
    const c = this.coef;
    this.eq.reset();
    this.band.reset();
    this.bandEnv = new Envelope(c(10), c(120));
    this.fullEnv = new Envelope(c(10), c(120));
    this.voiceEnv = new Envelope(c(50), c(400));
    this.ceilEnv = new Envelope(c(10), c(150));
    this.bgEnv = new Envelope(c(20), c(250));
    this.refEnv = new Envelope(c(50), c(600));
    this.levelUp = 0;
    this.speech = 0;
    this.limGain = 1;
    this.voiceLim = 1;
  }

  /** Part de parole dans le signal des voix (0…1), lissée : vite pour s'effacer, lentement pour revenir. */
  private detect(raw: number): number {
    const b = this.band.run(raw);
    const band = this.bandEnv.run(b * b);
    const full = this.fullEnv.run(raw * raw);
    const ratio = full > 1e-12 ? band / full : 0;
    // La parole met l'essentiel de son énergie entre 300 et 3400 Hz ; une explosion, une basse ou un
    // souffle non. Et rien sous le plancher : un silence n'est pas une voix.
    const target = smoothstep(0.3, 0.6, ratio) * smoothstep(-55, -45, toDb(band));
    const k = target > this.speech ? this.k.speechUp : this.k.speechDown;
    this.speech = k * this.speech + (1 - k) * target;
    return this.speech;
  }

  /**
   * Le gain du fond (linéaire) pour une puissance de fond et la part de parole : gain fixe à part,
   * le retrait et la compression relative pèsent selon la parole, le compresseur absolu toujours.
   */
  private backgroundGain(bgPower: number, s: number): number {
    const t = this.t;
    const bg = toDb(this.bgEnv.run(bgPower));
    const ref = toDb(this.refEnv.value);
    const over = bg - (ref + t.margin);
    const rel = over > 0 ? over * (1 - 1 / t.relRatio) : 0;
    return compGain(bg, t.bgThreshold, t.bgRatio) * dbToGain(s * (t.duck - rel));
  }

  /** Le signal des voix, mis en forme : égalisé, gain fixe, niveleur (vers le haut seulement), plafond. */
  private shapeVoice(raw: number, fixedGain: number): number {
    const t = this.t;
    const v = this.eq.run(raw) * fixedGain;
    // Niveleur : visé sur la puissance de la voix seule. Il ne remonte que ce qui est sous la cible,
    // et pas un silence (sous −60 dBFS rien n'est remonté).
    const level = toDb(this.voiceEnv.run(v * v));
    const want = Math.min(t.voiceMaxUp, Math.max(0, t.voiceTarget - level)) * smoothstep(-62, -50, level);
    const k = want < this.levelUp ? this.k.levelDown : this.k.levelUp;
    this.levelUp = k * this.levelUp + (1 - k) * want;
    let y = v * dbToGain(this.levelUp);
    // Plafond : seulement au-dessus de voiceCeil (cris, explosion au centre). La voix ordinaire n'y
    // arrive pas.
    const ceil = toDb(this.ceilEnv.run(y * y));
    y *= compGain(ceil, t.voiceCeil, t.voiceCeilRatio);
    this.refEnv.run(y * y);
    return y;
  }

  /** Un pas de limiteur : attaque immédiate, relâche douce. */
  private limit(gain: number, peak: number): number {
    const need = peak > CEILING ? CEILING / peak : 1;
    const g = need < gain ? need : this.k.lim * gain + (1 - this.k.lim) * Math.min(1, need);
    return g > need ? need : g;
  }

  process(planes: Float32Array[]): Float32Array[] {
    const n = planes.length;
    if (n !== this.channels || n === 0) return planes;
    const frames = planes[0].length;
    const out = planes.map(() => new Float32Array(frames));
    const frame = new Float64Array(n);
    const t = this.t;
    for (let i = 0; i < frames; i++) {
      if (this.layout === "centre") {
        const raw = planes[2][i];
        const s = this.detect(raw);
        const voice = this.shapeVoice(raw, this.gains[2]);
        let bgPower = 0;
        for (let c = 0; c < n; c++) {
          if (c === 2) continue;
          const x = planes[c][i] * this.gains[c];
          frame[c] = x;
          bgPower += x * x;
        }
        const bgGain = this.backgroundGain(bgPower, s);
        for (let c = 0; c < n; c++) if (c !== 2) frame[c] *= bgGain;
        frame[2] = voice;
      } else if (this.layout === "stereo") {
        const l = planes[0][i];
        const r = planes[1][i];
        const midRaw = (l + r) * 0.5;
        const s = this.detect(midRaw);
        const mid = this.shapeVoice(midRaw, dbToGain(t.mid));
        let side = (l - r) * 0.5 * dbToGain(t.side);
        side *= this.backgroundGain(side * side * 2, s);
        frame[0] = mid + side;
        frame[1] = mid - side;
      } else if (this.layout === "mono") {
        frame[0] = this.shapeVoice(planes[0][i], 1);
      } else {
        // Disposition inconnue : aucun canal n'est sûrement la voix — le compresseur du fond, lié,
        // sur tout, sans rattrapage.
        let power = 0;
        for (let c = 0; c < n; c++) power += planes[c][i] * planes[c][i];
        const g = compGain(toDb(this.bgEnv.run(power)), t.bgThreshold, t.bgRatio);
        for (let c = 0; c < n; c++) frame[c] = planes[c][i] * g;
      }
      // Limiteurs sous −1 dBFS, en dernier recours — deux : la voix seule, et le fond (lié). Un
      // limiteur commun faisait baisser la voix à chaque coup de feu des faces (Tenet, la bataille :
      // 44 % du temps sous −1 dB en « davantage »), et le fond à chaque crête du centre.
      const v = this.voiceIndex;
      const hasVoice = this.layout === "centre" || this.layout === "mono";
      let peak = 0;
      for (let c = 0; c < n; c++) {
        if (hasVoice && c === v) continue;
        const a = Math.abs(frame[c]);
        if (a > peak) peak = a;
      }
      this.limGain = this.limit(this.limGain, peak);
      if (hasVoice) this.voiceLim = this.limit(this.voiceLim, Math.abs(frame[v]));
      for (let c = 0; c < n; c++) out[c][i] = frame[c] * (hasVoice && c === v ? this.voiceLim : this.limGain);
    }
    return out;
  }
}
