// Ce que le lecteur fait quand le lien ne porte pas le film (DECISIONS.md §78).
//
// `slowLink.ts` mesure ; ce module décide, pour les deux lecteurs à la fois — le natif
// (ExperimentalPlayerHost) et le lecteur serveur quand il passe par hls.js (PlayerHost) —, quoi
// dire et quoi faire : l'indice sous la ligne de chargement, le préchauffage puis la bascule automatique
// bloquantes de l'ouverture et de la lecture, l'écran de renoncement, et le débit de la « version
// allégée » palier par palier. Une seule copie de chaque règle : deux lecteurs qui décident chacun
// de leur côté finissent par ne plus dire la même chose (CLAUDE.md, « The same decision is made in
// several places »).
//
// Règles de Louis (12/10/2026) : jamais de chiffres de débit à l'écran (ils vont au journal et au
// panneau technique) ; jamais d'erreur tant que la lecture continue ; jamais de « version allégée »
// pour une coupure nette — seulement pour un débit faible, mesuré.
//
// Pur et sans horloge propre : chaque fonction reçoit l'instant et les mesures. Rien ici ne lève.

import { MIN_MEASURED_MS, MIN_RECEIVED_BYTES, NOTICE_SHARE, SLOW_SHARE, HINT_MEASURED_MS, slowLinkVerdict, type LinkMeasure, type SlowLink } from "@/lib/slowLink";
import { CRAWL } from "@/lib/networkBitrate";
import { pushSlowLinkEvent } from "@/lib/slowLinkMonitor";

// --- l'ouverture (avant la première image), ou un saut traité comme elle ---------------------------

/** Préchauffer dès 8 s si la mesure est mauvaise (§78, Louis) — assez tôt pour qu'à 10 s tout soit prêt. */
export const PREWARM_AFTER_MS = 8_000;
/** Très lente (< 25 % du besoin) : bascule à 10 s, ou dès que le préchauffage est prêt s'il l'est plus tard. */
export const SWITCH_VERY_SLOW_MS = 10_000;
/** Moyenne (25–50 %) : elle a le temps de se rattraper — bascule à 20 s sans image. */
export const SWITCH_MEDIUM_MS = 20_000;

export interface OpeningAdvice {
  /** « Connexion lente… » sous la ligne de chargement. */
  hint: boolean;
  /** Préchauffer la version allégée (en « Automatique » seulement — c'est l'hôte qui le sait). */
  prewarm: boolean;
  /** Basculer maintenant, si le préchauffage est prêt (sinon dès qu'il le sera). */
  switchNow: boolean;
  /** Le débit mesuré (moyenne de la réception) et le besoin, pour le journal. */
  recvBps: number | null;
  needBps: number | null;
}

const NOTHING: OpeningAdvice = { hint: false, prewarm: false, switchNow: false, recvBps: null, needBps: null };

/**
 * Ce que l'ouverture dit du lien, lu chaque seconde (DECISIONS.md §78) — et ce qu'elle en fait en
 * qualité « Automatique » : préchauffer, puis basculer sur la version allégée.
 *
 * Le débit est la **moyenne** de toute la réception de l'ouverture (union des requêtes, des en-têtes
 * au dernier octet) : Louis préfère la moyenne au minimum, et une ouverture dure au plus 35 s — sa
 * moyenne *est* la moyenne récente. Une fenêtre glissante de dix secondes aurait oscillé : le lecteur
 * natif compte ses morceaux de 1 Mio une fois arrivés (le corps se lit d'un bloc, §77), et à 0,3
 * Mbit/s un morceau met vingt-huit secondes — une fenêtre courte n'en voit aucun, puis un seul.
 *
 * - `unstable` (une coupure : des tentatives échouent, ou le navigateur se dit hors ligne) : rien.
 *   Une coupure a son propre message, et jamais la version allégée.
 * - indice : 5 s de réception, des octets, sous la moitié du besoin.
 * - préchauffage : la même mesure, à partir de 8 s.
 * - bascule : les preuves du verdict (10 s de réception, 256 Kio) et sous le quart du besoin dès 10 s,
 *   ou sous la moitié à 20 s.
 */
export function openingAdvice(
  measure: LinkMeasure | null | undefined,
  needBps: number | null | undefined,
  elapsedMs: number,
  unstable: boolean
): OpeningAdvice {
  try {
    if (unstable) return NOTHING;
    if (!measure || typeof needBps !== "number" || !Number.isFinite(needBps) || needBps <= 0) return NOTHING;
    const { bytes, receivingMs } = measure;
    if (!Number.isFinite(bytes) || !Number.isFinite(receivingMs) || !(bytes > 0)) return NOTHING;
    if (receivingMs < HINT_MEASURED_MS) return NOTHING;
    const recvBps = (bytes * 8) / (receivingMs / 1000);
    const reading = { recvBps, needBps };
    if (!(recvBps < SLOW_SHARE * needBps)) return { ...NOTHING, ...reading };
    const proven = receivingMs >= MIN_MEASURED_MS && bytes >= MIN_RECEIVED_BYTES;
    const verySlow = recvBps < NOTICE_SHARE * needBps;
    const switchNow = proven && ((verySlow && elapsedMs >= SWITCH_VERY_SLOW_MS) || elapsedMs >= SWITCH_MEDIUM_MS);
    return { hint: true, prewarm: elapsedMs >= PREWARM_AFTER_MS, switchNow, ...reading };
  } catch {
    return NOTHING;
  }
}

// --- la décision : une seule machine pour les deux lecteurs ---------------------------------------

/**
 * Ce que l'hôte doit faire maintenant (§78). Les hôtes n'en décident rien : ils mesurent, appellent
 * `decideOpening` / `decidePlayback`, et exécutent — préchauffer (`lighterPrewarm.ts`), basculer (la
 * reconstruction habituelle : `fallToStable` côté natif, renégociation côté serveur), montrer l'écran
 * final, ou renoncer comme avant.
 *
 *   mesure → indice → préchauffage → bascule → écran final
 *
 * - `none` : rien de plus que l'indice.
 * - `prewarm` : lancer le préchauffage de ce palier (une fois — l'hôte dit s'il y en a déjà un).
 * - `switch` : basculer sur ce palier (le préchauffage est prêt, ou a échoué : le serveur négociera).
 * - `screen` : « Lecture impossible : la connexion est trop lente. » — lenteur prouvée et plus de
 *   bascule possible (réglage « Originale », version allégée non permise, ou plancher atteint).
 * - `giveUp` : le renoncement d'avant, motif d'avant — rien n'est prouvé.
 */
export type SlowAction =
  | { kind: "none" }
  | { kind: "prewarm"; step: LighterStep }
  | { kind: "switch"; step: LighterStep }
  | { kind: "screen"; slow: SlowLink }
  | { kind: "giveUp" };

export type PrewarmStatus = "none" | "running" | "ready" | "failed";

export interface OpeningTick {
  /** Ce que le lien a livré depuis le début de l'ouverture (ou du saut). */
  measure: LinkMeasure | null | undefined;
  needBps: number | null | undefined;
  /** Depuis le début de l'ouverture, du saut, ou du retour au premier plan. */
  elapsedMs: number;
  /** Des tentatives réseau échouent, ou le navigateur est hors ligne : une coupure, pas une lenteur. */
  unstable: boolean;
  /** « Automatique » et version allégée permise (lecteur serveur, transcodage du compte). */
  auto: boolean;
  /** Le préchauffage de cette ouverture. */
  prewarm: PrewarmStatus;
  /** Le palier en cours (lecteur serveur déjà allégé), ou `null` (pleine qualité). */
  currentStep: LighterStep | null;
  /** Le délai du renoncement : 35 s pour le natif, le chien de garde de 20 s pour le serveur. */
  giveUpMs: number;
}

/**
 * Avant la première image — à l'ouverture, ou 10 s après un saut resté sans image. Pure, ne lève pas :
 * en cas de doute, `none` puis l'ancien renoncement.
 */
export function decideOpening(tick: OpeningTick): { advice: OpeningAdvice; action: SlowAction } {
  const advice = openingAdvice(tick.measure, tick.needBps, tick.elapsedMs, tick.unstable);
  try {
    if (tick.elapsedMs >= tick.giveUpMs) {
      // Une coupure en cours : on attend son issue (l'écran « connexion perdue » ou les octets).
      if (tick.unstable) return { advice, action: { kind: "none" } };
      const slow = slowLinkVerdict(tick.measure, tick.needBps);
      if (!slow) return { advice, action: { kind: "giveUp" } };
      const step = tick.auto ? nextLighter(slow.recvBps, slow.needBps, tick.currentStep) : null;
      return { advice, action: step ? { kind: "switch", step } : { kind: "screen", slow } };
    }
    if (!tick.auto || !advice.hint) return { advice, action: { kind: "none" } };
    const step = nextLighter(advice.recvBps, advice.needBps, tick.currentStep);
    if (!step) return { advice, action: { kind: "none" } };
    if (advice.switchNow && (tick.prewarm === "ready" || tick.prewarm === "failed")) return { advice, action: { kind: "switch", step } };
    if (advice.prewarm && tick.prewarm === "none") return { advice, action: { kind: "prewarm", step } };
    return { advice, action: { kind: "none" } };
  } catch {
    return { advice, action: { kind: "none" } };
  }
}

/**
 * En pleine lecture (§78). `triggered` : la règle de bascule de `StutterWatch` a joué (un blocage de
 * plus de 5 s, ou le 3e de plus d'1 s en 3 min) — préchauffer s'il n'y a rien, puis basculer dès que le
 * préchauffage est prêt (ou a échoué). `early` : le 2e blocage seulement — préchauffer, **jamais**
 * basculer : un préchauffage prêt sans déclenchement attend (et l'exécution l'annule au bout de
 * `EARLY_PREWARM_MS`). En « Originale », sans version allégée permise, ou au plancher : rien — jamais
 * d'erreur tant que la lecture continue.
 */
export function decidePlayback(tick: {
  triggered: boolean;
  early?: boolean;
  auto: boolean;
  prewarm: PrewarmStatus;
  recvBps: number | null;
  needBps: number | null;
  currentStep: LighterStep | null;
}): SlowAction {
  try {
    if (!tick.auto) return { kind: "none" };
    const step = nextLighter(tick.recvBps, tick.needBps, tick.currentStep);
    if (!step) return { kind: "none" };
    if (tick.triggered && (tick.prewarm === "ready" || tick.prewarm === "failed")) return { kind: "switch", step };
    if ((tick.triggered || tick.early) && tick.prewarm === "none") return { kind: "prewarm", step };
    return { kind: "none" };
  } catch {
    return { kind: "none" };
  }
}

// --- la version allégée -----------------------------------------------------------------------

/** Un saut sans image depuis dix secondes est traité comme une ouverture (§78, choix de Louis), dans les deux lecteurs. */
export const SEEK_AS_OPENING_MS = 10_000;
/** Et son renoncement, celui de l'ouverture du natif : 35 s, et seulement sur une lenteur prouvée. */
export const SEEK_GIVE_UP_MS = 35_000;

/** Ce qui fait basculer : l'ouverture, un saut traité comme elle, ou des saccades en pleine lecture. */
export type SwitchCause = "ouverture" | "saut" | "lecture";

/** Le plus bas débit demandé au serveur : `CRAWL`, 1,5 Mbit/s. */
export const LIGHTER_FLOOR_BPS = CRAWL;

/** Un palier de version allégée : le débit demandé à Jellyfin, et son rang (1 = le premier). */
export interface LighterStep {
  targetBps: number;
  tier: number;
}

/**
 * Le palier suivant — ou `null` quand il n'y en a plus.
 *
 * Premier palier : la moitié du débit mesuré (la marge : un tampon qui se remplit tout juste au
 * rythme de la lecture ne se remplit jamais), jamais sous le plancher de 1,5 Mbit/s — même quand le
 * lien mesure moins, c'est voulu (Louis : on demande alors 1,5). Fichier 30 Mbit/s, mesuré 5 → 2,5 ;
 * fichier 16, mesuré 10 → 5 ; mesuré 0,3 → 1,5.
 *
 * Paliers suivants (la version allégée n'a pas suffi) : `max(1,5, min(précédent / 2, mesuré / 2))`.
 * Au plancher, plus de palier : il ne reste que Réessayer et Fermer.
 *
 * Toujours sous le besoin du fichier : un palier qui ne l'est pas ne serait pas plus léger (le cas
 * d'un fichier sous 1,5 Mbit/s) — `null`.
 */
export function nextLighter(measuredBps: number | null | undefined, needBps: number | null | undefined, previous: LighterStep | null | undefined): LighterStep | null {
  try {
    const measured = typeof measuredBps === "number" && Number.isFinite(measuredBps) && measuredBps > 0 ? measuredBps : null;
    let target: number;
    if (previous) {
      if (previous.targetBps <= LIGHTER_FLOOR_BPS) return null;
      const half = previous.targetBps / 2;
      target = Math.max(LIGHTER_FLOOR_BPS, measured !== null ? Math.min(half, measured / 2) : half);
    } else {
      target = Math.max(LIGHTER_FLOOR_BPS, measured !== null ? measured / 2 : LIGHTER_FLOOR_BPS);
    }
    // Arrondi aux 100 kbit/s : un chiffre lisible au journal, sans effet sur ce que Jellyfin produit.
    target = Math.max(LIGHTER_FLOOR_BPS, Math.round(target / 100_000) * 100_000);
    if (typeof needBps === "number" && Number.isFinite(needBps) && needBps > 0 && target >= needBps) return null;
    return { targetBps: target, tier: (previous?.tier ?? 0) + 1 };
  } catch {
    return null;
  }
}

/**
 * La version allégée en HEVC quand l'appareil le lit (Louis, 12/10/2026), sinon en H.264 ; en SDR
 * (le HDR est ramené par mappage de tons) ; jamais au-delà du 1080p. Mesuré sur la prod le même jour
 * (i7-8700, QSV) : Jellyfin encode le HEVC par `hevc_qsv` en Main 8 bits, balise `hvc1`, mappage
 * `tonemap_opencl` ; premier segment en 1,35 à 1,75 s, comme en H.264 (1,31 à 1,84 s).
 *
 * La largeur maximale demandée à Jellyfin pour un palier — une condition `Width` du profil
 * (`buildDeviceProfile`), le seul moyen vérifié (`MaxWidth` dans le corps ou la requête de
 * PlaybackInfo est ignoré). Jellyfin réduit déjà de lui-même aux bas débits (1,5 et 2,5 Mbit/s →
 * 720p), mais pas de façon monotone en H.264 — 3 Mbit/s donnait du 1080p, 4 et 5 Mbit/s de nouveau du
 * 720p, 8 à 10 du 1440p pour un 4K. Le barème rend la chose régulière :
 * - HEVC : 720p jusqu'à 2,5 Mbit/s, 1080p au-dessus — le HEVC tient le 1080p dès ~3 Mbit/s, et un
 *   1080p à 2 Mbit/s de vidéo est plus flou à l'œil qu'un 720p net ;
 * - H.264 : 720p sous 6 Mbit/s, 1080p au-dessus — Jellyfin ne sort de toute façon pas de 1080p en H.264
 *   sous 6 Mbit/s, même autorisé (mesuré le 12/10/2026 : 720p à 4 et 5 Mbit/s avec `Width` ≤ 1920).
 * Une source 4K descend donc en 1080p au plus ; une source déjà plus petite garde sa taille (c'est un
 * plafond, pas une consigne).
 */
export function lighterMaxWidth(targetBps: number, hevc: boolean): number {
  if (hevc) return targetBps <= 2_500_000 ? 1280 : 1920;
  return targetBps < 6_000_000 ? 1280 : 1920;
}

// --- pendant la lecture : les saccades --------------------------------------------------------

/** Un blocage visible de plus de 5 s, causé par le réseau, déclenche à lui seul. */
export const LONG_STALL_MS = 5_000;
/** Sinon, le troisième blocage de plus d'une seconde… */
export const SHORT_STALL_MS = 1_000;
export const STALLS_TO_TRIGGER = 3;
/**
 * Le préchauffage part dès le 2e de ces blocages (12/10/2026) : attendre le 3e pour le lancer ajoutait
 * son délai (~1,3 s, plus sur un lien lent) à l'interruption de la bascule. La bascule, elle, attend
 * toujours la règle ci-dessus.
 */
export const STALLS_TO_PREWARM = 2;
/** Un préchauffage du 2e blocage que la règle de bascule n'a pas suivi en une minute est annulé. */
export const EARLY_PREWARM_MS = 60_000;
/**
 * …dans une fenêtre de trois minutes : un blocage par minute se remarque à coup sûr, et c'est la
 * fenêtre que le lecteur natif donne déjà à son budget de reconstructions (3 par 180 s,
 * `PlayerLifecycle`). Trois attentes éparses dans un film de deux heures n'ont rien d'un lien qui
 * ne suit pas.
 */
export const STALL_WINDOW_MS = 3 * 60_000;
/**
 * La fenêtre de mesure du débit en pleine lecture : les 30 dernières secondes, celles de la ligne
 * `stall` (`STALL_WINDOW_MS`, playbackDiagnosis.ts) — les chiffres du journal et ceux de la décision
 * sont les mêmes. Dix secondes, plus proches de « la moyenne récente », ne suffisent pas : le lecteur
 * natif note une requête une fois finie, et à 1 ou 2 Mbit/s un morceau de 1 Mio met quatre à huit
 * secondes — dix secondes n'en contiendraient parfois aucun. La moyenne se prend sur le temps de
 * réception (des en-têtes au dernier octet), pas sur l'horloge : les silences de la réserve entre
 * deux rafales ne comptent pas contre le lien.
 */
export const PLAYBACK_MEASURE_WINDOW_MS = 30_000;

/**
 * Le débit mesuré pendant la lecture est-il sous le besoin ? Faux sans preuve : au moins deux
 * secondes de réception et 256 Kio dans la fenêtre — un lien qui n'a rien livré est une coupure,
 * pas une lenteur.
 */
export function playbackLinkSlow(measure: LinkMeasure | null | undefined, needBps: number | null | undefined): boolean {
  try {
    if (!measure || typeof needBps !== "number" || !(needBps > 0)) return false;
    if (!(measure.receivingMs >= 2_000) || !(measure.bytes >= MIN_RECEIVED_BYTES)) return false;
    return (measure.bytes * 8) / (measure.receivingMs / 1000) < needBps;
  } catch {
    return false;
  }
}

/** Le débit d'une mesure, en bits par seconde, ou `null`. */
export function measuredBps(measure: LinkMeasure | null | undefined): number | null {
  if (!measure || !(measure.receivingMs > 0) || !(measure.bytes > 0)) return null;
  const bps = (measure.bytes * 8) / (measure.receivingMs / 1000);
  return Number.isFinite(bps) ? bps : null;
}

/**
 * Quand basculer en pleine lecture (§78). Nourrie par l'hôte : un blocage qui dure (`longWait`, à 5 s),
 * un blocage fini (`waitEnded`). `network` : la cause classée *réseau* par le diagnostic
 * (`playbackDiagnosis`) **et** un débit mesuré sous le besoin. Une attente de calcul ou de décodeur ne
 * compte jamais, ni celle d'un saut (l'hôte ne les lui donne pas). Un déclenchement remet le compte à
 * zéro : la version allégée suivante (dégressive) repart de rien.
 */
export class StutterWatch {
  private waits: number[] = [];

  /** Un blocage en cours atteint 5 s. Vrai : basculer. */
  longWait(_now: number, network: boolean): boolean {
    if (!network) return false;
    this.waits = [];
    return true;
  }

  /** Un blocage fini, de `ms` millisecondes. Vrai : basculer (le 3e de plus d'1 s en 3 min). */
  waitEnded(now: number, ms: number, network: boolean): boolean {
    return this.waitEndedSignal(now, ms, network) === "switch";
  }

  /**
   * Le même, avec le palier intermédiaire : `"prewarm"` au 2e blocage de la fenêtre (préchauffer sans
   * basculer), `"switch"` au 3e, `"none"` sinon.
   */
  waitEndedSignal(now: number, ms: number, network: boolean): "none" | "prewarm" | "switch" {
    if (!network || !(ms > SHORT_STALL_MS)) return "none";
    this.waits = this.waits.filter((at) => now - at < STALL_WINDOW_MS);
    this.waits.push(now);
    if (this.waits.length === STALLS_TO_PREWARM) return "prewarm";
    if (this.waits.length < STALLS_TO_TRIGGER) return "none";
    this.waits = [];
    return "switch";
  }
}

// --- le journal --------------------------------------------------------------------------------

/** Ce que le spectateur a fait de l'écran final. */
export type SlowChoice = "réessayer" | "fermer";

/** `1.234e6` → `"1.2"` ; sous 10, une décimale (deux sous 1). */
export function mbps(bps: number | null | undefined): string {
  if (typeof bps !== "number" || !Number.isFinite(bps)) return "?";
  const value = bps / 1e6;
  return value < 1 ? value.toFixed(2) : value < 10 ? value.toFixed(1) : String(Math.round(value));
}

/**
 * Ce que la lenteur a fait apparaître pendant une séance, et ce que le spectateur en a fait — porté
 * par les lignes qui partent de toute façon (`opening`, `stall`, `fallback`, `error`, `stop`, et
 * `start` du serveur), jamais par une ligne de plus : deux champs, `slowLink` (le fil des
 * événements, une chaîne bornée) et `slowChoice` (le dernier choix, ou « aucun »).
 *
 * Chaque événement dit quoi, quand (`+12.3 s` depuis la demande, ou `à 1234 s` dans le film), et le
 * débit mesuré / le besoin en Mb/s. Exemple :
 * `indice +5.0 s (0.32/3.9) | préchauffage (ouverture) à 0 s : 1.5 Mb/s palier 1 (0.32/3.9) | bascule (ouverture) à 0 s, 1.5 Mb/s palier 1`.
 */
export class SlowLog {
  private events: string[] = [];
  private choice: SlowChoice | null = null;

  note(event: string): void {
    try {
      // Le tableau du simulateur de la page de test, s'il est allumé (rien sinon).
      pushSlowLinkEvent(event);
      this.events.push(event);
      if (this.events.length > 16) this.events.splice(0, this.events.length - 16);
    } catch {
      /* rien */
    }
  }

  /** Un événement daté depuis la demande, avec ses débits. */
  noteAt(what: string, afterMs: number, recvBps?: number | null, needBps?: number | null): void {
    const figures = recvBps !== undefined || needBps !== undefined ? ` (${mbps(recvBps)}/${mbps(needBps)})` : "";
    this.note(`${what} +${(Math.max(0, afterMs) / 1000).toFixed(1)} s${figures}`);
  }

  choose(choice: SlowChoice, afterMs: number): void {
    this.choice = choice;
    this.noteAt(`choix ${choice}`, afterMs);
  }

  get empty(): boolean {
    return this.events.length === 0;
  }

  /** Les deux champs de la ligne — rien quand rien n'a paru (une lecture ordinaire n'en porte aucun). */
  fields(): Record<string, string> {
    if (this.events.length === 0) return {};
    return { slowLink: this.events.join(" | ").slice(-480), slowChoice: this.choice ?? "aucun" };
  }
}

// --- d'une lecture à la suivante ----------------------------------------------------------------

/**
 * Le lien a-t-il retrouvé de quoi porter la lecture *classique* ? Pendant une lecture allégée, on
 * continue de mesurer ; si la **capacité** du lien atteint 110 % du besoin du fichier d'origine en
 * pleine qualité, de façon soutenue, la mémoire des deux minutes (`playbackQuality.ts`) est effacée : la lecture suivante
 * revient au lecteur natif. Le film en cours, lui, reste en allégée jusqu'à sa fin (pas de remontée
 * en pleine lecture).
 *
 * La capacité, pas le débit consommé : en allégée, le lecteur ne télécharge que le petit débit du
 * palier, par rafales. Ce qui se mesure est donc le débit *pendant* la réception (octets / temps où
 * des octets arrivaient, des en-têtes au dernier octet — le `linkMbps` de `diag`), sur les 10
 * dernières secondes.
 *
 * Soutenue : le critère tient à chaque lecture pendant au moins 10 s d'affilée — un segment rapide
 * isolé (une rafale servie d'un cache) ne suffit pas, et dix secondes sont la fenêtre même de la
 * mesure, assez pour voir plusieurs segments de 3 s. Une lecture sans assez de réception (le tampon
 * plein, hls.js se tait) ne compte ni pour ni contre ; une seule lecture sous 110 % remet à zéro.
 */
export const RECOVERY_SHARE = 1.1;
export const RECOVERY_SUSTAINED_MS = 10_000;
export const RECOVERY_WINDOW_MS = 10_000;

export class LinkRecovery {
  private since: number | null = null;
  private good = 0;
  private done = false;
  /** La capacité qui a décidé, en bits par seconde. */
  capacityBps: number | null = null;

  /**
   * Une lecture (chaque seconde). `measure` : la fenêtre récente ; `classicNeedBps` : le besoin du
   * fichier d'origine. Vrai une fois, quand la capacité a tenu 110 % pendant 10 s.
   */
  check(now: number, measure: LinkMeasure | null | undefined, classicNeedBps: number | null | undefined): boolean {
    try {
      if (this.done || typeof classicNeedBps !== "number" || !(classicNeedBps > 0)) return false;
      if (!measure || measure.receivingMs < 500 || measure.bytes < MIN_RECEIVED_BYTES) return false;
      const capacity = (measure.bytes * 8) / (measure.receivingMs / 1000);
      if (!(capacity >= RECOVERY_SHARE * classicNeedBps)) {
        this.since = null;
        this.good = 0;
        return false;
      }
      this.since ??= now;
      this.good += 1;
      if (now - this.since >= RECOVERY_SUSTAINED_MS && this.good >= 2) {
        this.done = true;
        this.capacityBps = capacity;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  get recovered(): boolean {
    return this.done;
  }
}
