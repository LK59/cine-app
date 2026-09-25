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
 * Le budget se mesure donc en octets : une part du plafond pour l'avance, ce qui reste pour ce
 * qu'on garde derrière, une marge pour les envois en vol — et le débit est celui qu'on envoie
 * réellement, segment par segment, pas une moyenne du fichier : une scène d'action pèse deux fois
 * un dialogue.
 *
 * Chaque moteur a ses chiffres, lus dans ses sources et non dans une page qui les résume — la
 * valeur de 304 Mo « pour Safari » qu'on trouve partout est celle des WebKit hors Apple. Un moteur
 * qu'on ne reconnaît pas garde le comportement d'avant : trente secondes, et son éviction à lui.
 */

/** `defaultMaximumSourceBufferSize`, iOS et iPadOS. */
export const WEBKIT_MOBILE_SOURCE_BUFFER_BYTES = 110_376_422;
/** `defaultMaximumSourceBufferSize`, macOS. */
export const WEBKIT_MAC_SOURCE_BUFFER_BYTES = 318_767_104;
/** Ce qu'un SourceBuffer sans image reçoit du plafond (`bufferBudgetPercentageForAudio`). */
const AUDIO_ONLY_SHARE = 0.05;

/**
 * La part du plafond pour l'avance, et pour l'avance et l'arrière réunis — le reste est la marge
 * des envois en vol, que le navigateur compte avant de les accepter.
 */
const AHEAD_SHARE = 0.6;
const USABLE_SHARE = 0.85;

/** Ce qu'on garde derrière au moins, quand le plafond le permet : un petit pas en arrière sans relire. */
const MIN_BEHIND_SECONDS = 6;

/**
 * Chromium, ordinateur (`media/base/demuxer_memory_limit_default.cc`, lu le 25/09/2026) : 150 Mio
 * d'image, 12 Mio de son, par piste. Le palier « appareil modeste » (30 / 2 Mio) n'y est pris
 * qu'avec un drapeau de ligne de commande : on ne le suppose pas.
 */
export const CHROMIUM_DESKTOP = { video: 150 * 1024 * 1024, audio: 12 * 1024 * 1024 };

/**
 * Chromium, Android (`demuxer_memory_limit_android.cc`) : quatre paliers selon la mémoire de
 * l'appareil — par défaut 150 / 12, « mode modeste partiel » (3 Go, ou 4 à 6 Go selon une
 * expérience) 80 / 5, appareil modeste 30 / 2, 512 Mo 15 / 1 Mio. La page n'en voit que
 * `navigator.deviceMemory`, arrondi à une puissance de deux : un 3 Go s'y lit 2, un 6 Go 4. On
 * prend donc le palier le plus bas que cette valeur autorise — trop bas ne coûte qu'un peu
 * d'avance, trop haut rend l'éviction au navigateur.
 */
export const CHROMIUM_ANDROID = {
  default: { video: 150 * 1024 * 1024, audio: 12 * 1024 * 1024 },
  medium: { video: 80 * 1024 * 1024, audio: 5 * 1024 * 1024 },
  low: { video: 30 * 1024 * 1024, audio: 2 * 1024 * 1024 },
  veryLow: { video: 15 * 1024 * 1024, audio: 1 * 1024 * 1024 },
};

/**
 * Gecko (`dom/media/mediasource/TrackBuffersManager.cpp`, lu le 25/09/2026) : 150 Mio d'image et
 * 20 Mio de son, sur toutes les plateformes, Android compris — aucune surcharge dans les
 * préférences livrées. L'image était à 100 Mio jusqu'au bug 1760529 (juillet 2024, Firefox 130) :
 * les chiffres de 100 Mio qui circulent datent d'avant.
 */
export const GECKO = { video: 150 * 1024 * 1024, audio: 20 * 1024 * 1024 };
export const GECKO_BEFORE_130 = { video: 100 * 1024 * 1024, audio: 20 * 1024 * 1024 };

/** Firefox et ses dérivés, avec leur version — jamais sur iOS, où Firefox est WebKit. */
export function geckoVersion(userAgent: string): number | null {
  if (isWebKitEngine(userAgent) || !/Gecko\/\d/.test(userAgent)) return null;
  const match = /Firefox\/(\d+)/.exec(userAgent);
  return match ? Number(match[1]) : null;
}

export interface SourceBufferQuota {
  /** Le moteur reconnu, pour la trace. */
  engine: string;
  video: number;
  audio: number;
}

/** Ce qu'on sait de l'appareil en plus de son agent. */
export interface DeviceHints {
  /** `navigator.maxTouchPoints` : un iPad en mode bureau se dit Mac. */
  maxTouchPoints?: number;
  /** `navigator.deviceMemory`, en Go, arrondi — Chromium seulement. */
  deviceMemory?: number;
}

function chromiumAndroidTier(deviceMemory: number | undefined): { video: number; audio: number } {
  // Absent : on ne sait rien, et le palier du milieu est le pari prudent.
  if (deviceMemory === undefined) return CHROMIUM_ANDROID.medium;
  if (deviceMemory <= 0.5) return CHROMIUM_ANDROID.veryLow;
  if (deviceMemory <= 1) return CHROMIUM_ANDROID.low;
  if (deviceMemory <= 4) return CHROMIUM_ANDROID.medium;
  return CHROMIUM_ANDROID.default;
}

/** Chromium sous un nom ou un autre — Chrome, Edge, Opera, Brave, Samsung Internet. Jamais sur iOS, où tout est WebKit. */
export function isChromiumEngine(userAgent: string): boolean {
  return !isWebKitEngine(userAgent) && /Chrom(e|ium)\/\d/.test(userAgent);
}

/**
 * Le plafond de ce navigateur, quand on le connaît. Un iPad en mode bureau se présente comme un
 * Mac : on le reconnaît à son écran tactile, comme le fait déjà `PlayerControls`.
 */
export function sourceBufferQuota(userAgent: string, hints: DeviceHints = {}): SourceBufferQuota | null {
  if (isWebKitEngine(userAgent)) {
    const mobile = /iP(hone|ad|od)/i.test(userAgent) || (/Macintosh/i.test(userAgent) && (hints.maxTouchPoints ?? 0) > 1);
    const total = mobile ? WEBKIT_MOBILE_SOURCE_BUFFER_BYTES : WEBKIT_MAC_SOURCE_BUFFER_BYTES;
    return { engine: mobile ? "WebKit mobile" : "WebKit macOS", video: total, audio: Math.floor(total * AUDIO_ONLY_SHARE) };
  }
  if (isChromiumEngine(userAgent)) {
    if (/Android/i.test(userAgent)) return { engine: "Chromium Android", ...chromiumAndroidTier(hints.deviceMemory) };
    return { engine: "Chromium", ...CHROMIUM_DESKTOP };
  }
  const gecko = geckoVersion(userAgent);
  if (gecko !== null) return { engine: "Gecko", ...(gecko >= 130 ? GECKO : GECKO_BEFORE_130) };
  return null;
}

export function currentSourceBufferQuota(): SourceBufferQuota | null {
  if (typeof navigator === "undefined") return null;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return sourceBufferQuota(navigator.userAgent, {
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    ...(typeof memory === "number" ? { deviceMemory: memory } : {}),
  });
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
  const secondsInQuota = quotaBytes / bytesPerSecond;
  const usable = secondsInQuota * USABLE_SHARE;
  // L'avance d'abord, en laissant de quoi faire un petit pas en arrière.
  const ahead = Math.max(minAhead, Math.min(maxAhead, secondsInQuota * AHEAD_SHARE, usable - MIN_BEHIND_SECONDS));
  // L'arrière prend ce qui reste sous le plafond, jusqu'aux trente secondes d'avant. Une part fixe
  // du plafond le rognait pour rien sur un fichier léger : 17,6 s gardées derrière sur Chrome quand
  // 87 s tenaient (banc du 25/09/2026). Un débit si lourd que l'avance minimale mange déjà le
  // plafond : c'est lui qui cède, jusqu'à une seconde.
  return { aheadSeconds: ahead, behindSeconds: Math.max(1, Math.min(maxBehind, usable - ahead)) };
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
