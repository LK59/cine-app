import { isWebKitEngine } from "@/lib/webkitEngine";

/**
 * Ce qu'un navigateur garde dans un tampon MediaSource, en octets — et ce qu'on lui demande en
 * conséquence.
 *
 * Le lecteur visait trente secondes d'avance quel que soit le débit, et ne retirait rien derrière
 * la tête tant que le navigateur ne refusait pas un envoi. Sur un iPad, c'est trop pour la 4K :
 * WebKit plafonne chaque SourceBuffer à **105 Mo** sur iOS et iPadOS, 304 Mo sur macOS
 * (`SettingsBaseCocoa.mm`, `defaultMaximumSourceBufferSize`, lu le 25/09/2026), et un tampon sans
 * image n'en reçoit que 5 % (`SourceBuffer::maximumBufferSize`). *Ted Lasso* S04, 27 Mb/s d'image :
 * 105 Mo en tiennent 31 s, derrière et devant réunis. L'iPad lisait donc en permanence contre le
 * plafond — son avance plafonnait à 20-22 s —, chaque envoi forçait WebKit à évincer lui-même au
 * milieu de l'ajout, et c'est dans ce régime que du média déjà chargé a disparu sous un saut de
 * +10 s (24/09/2026). L'éviction de WebKit retire d'abord derrière la tête, puis, si ça ne suffit
 * pas, *devant* elle en partant de la fin.
 *
 * Le budget se mesure donc en octets : une part du plafond pour l'avance, une part pour ce qu'on
 * garde derrière, le reste en marge pour les envois en vol — et le débit est celui qu'on envoie
 * réellement, segment par segment, pas une moyenne du fichier : une scène d'action pèse deux fois
 * un dialogue. Ailleurs que sur WebKit, rien ne change ici : les plafonds de Chrome et de Firefox
 * sont d'autres chiffres, à traiter à part.
 */

/** `defaultMaximumSourceBufferSize`, iOS et iPadOS. */
export const WEBKIT_MOBILE_SOURCE_BUFFER_BYTES = 110_376_422;
/** `defaultMaximumSourceBufferSize`, macOS. */
export const WEBKIT_MAC_SOURCE_BUFFER_BYTES = 318_767_104;
/** Ce qu'un SourceBuffer sans image reçoit du plafond (`bufferBudgetPercentageForAudio`). */
const AUDIO_ONLY_SHARE = 0.05;

/**
 * La part du plafond pour l'avance, pour ce qu'on garde derrière la tête, et pour les deux
 * réunis — le reste est la marge des envois en vol, que WebKit compte avant de les accepter.
 */
const AHEAD_SHARE = 0.6;
const BEHIND_SHARE = 0.2;
const USABLE_SHARE = 0.85;

/** Ce qu'on garde derrière au moins, quand le plafond le permet : un petit pas en arrière sans relire. */
const MIN_BEHIND_SECONDS = 6;

export interface SourceBufferQuota {
  video: number;
  audio: number;
}

/**
 * Le plafond de ce navigateur, quand on le connaît. Un iPad en mode bureau se présente comme un
 * Mac : on le reconnaît à son écran tactile, comme le fait déjà `PlayerControls`.
 */
export function sourceBufferQuota(userAgent: string, maxTouchPoints = 0): SourceBufferQuota | null {
  if (!isWebKitEngine(userAgent)) return null;
  const mobile = /iP(hone|ad|od)/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1);
  const total = mobile ? WEBKIT_MOBILE_SOURCE_BUFFER_BYTES : WEBKIT_MAC_SOURCE_BUFFER_BYTES;
  return { video: total, audio: Math.floor(total * AUDIO_ONLY_SHARE) };
}

export function currentSourceBufferQuota(): SourceBufferQuota | null {
  if (typeof navigator === "undefined") return null;
  return sourceBufferQuota(navigator.userAgent, navigator.maxTouchPoints ?? 0);
}

/** Combien de segments récents servent à mesurer le débit : assez pour lisser, assez peu pour suivre une scène. */
const RATE_WINDOW = 12;

/** Le débit réellement envoyé à un tampon, en octets par seconde de média. */
export class ByteRate {
  private samples: { bytes: number; seconds: number }[] = [];

  record(bytes: number, seconds: number): void {
    // Un segment sans durée mesurable — le premier après un saut, qui repart d'avant la cible — ne
    // dit rien du débit ; compté, il le ferait exploser.
    if (!(seconds >= 0.2) || !(bytes > 0)) return;
    this.samples.push({ bytes, seconds });
    if (this.samples.length > RATE_WINDOW) this.samples.shift();
  }

  /** Octets par seconde, ou null tant que rien n'a été mesuré. Le plus lourd de la fenêtre l'emporte à moitié. */
  get bytesPerSecond(): number | null {
    if (this.samples.length === 0) return null;
    const bytes = this.samples.reduce((n, s) => n + s.bytes, 0);
    const seconds = this.samples.reduce((n, s) => n + s.seconds, 0);
    const mean = bytes / seconds;
    const peak = Math.max(...this.samples.map((s) => s.bytes / s.seconds));
    return (mean + peak) / 2;
  }
}

export interface BufferBudget {
  /** L'avance à ne pas dépasser. */
  aheadSeconds: number;
  /** Ce qu'on garde derrière la tête ; au-delà, on retire nous-mêmes. */
  behindSeconds: number;
}

/**
 * Le budget d'un tampon, en secondes, pour ce débit et ce plafond. Null quand on ne sait rien :
 * le lecteur garde alors ses trente secondes d'avant.
 */
export function laneBudget(quotaBytes: number, bytesPerSecond: number | null, maxAhead: number, maxBehind: number, minAhead: number): BufferBudget | null {
  if (!bytesPerSecond || bytesPerSecond <= 0 || quotaBytes <= 0) return null;
  const usable = (quotaBytes / bytesPerSecond) * USABLE_SHARE;
  const secondsInQuota = quotaBytes / bytesPerSecond;
  const behind = Math.min(maxBehind, Math.max(MIN_BEHIND_SECONDS, secondsInQuota * BEHIND_SHARE));
  const ahead = Math.max(minAhead, Math.min(maxAhead, secondsInQuota * AHEAD_SHARE, usable - behind));
  // Un débit si lourd que l'avance minimale mange déjà le plafond : c'est l'arrière qui cède.
  return { aheadSeconds: ahead, behindSeconds: Math.max(1, Math.min(behind, usable - ahead)) };
}

/** Le plus serré des deux tampons : l'image et le son se lisent ensemble. */
export function tightest(...budgets: (BufferBudget | null)[]): BufferBudget | null {
  const known = budgets.filter((b): b is BufferBudget => b !== null);
  if (known.length === 0) return null;
  return {
    aheadSeconds: Math.min(...known.map((b) => b.aheadSeconds)),
    behindSeconds: Math.min(...known.map((b) => b.behindSeconds)),
  };
}
