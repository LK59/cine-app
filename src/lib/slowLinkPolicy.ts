// Ce que le lecteur *propose* quand le lien ne porte pas le film (DECISIONS.md §78).
//
// `slowLink.ts` mesure ; ce module décide, pour les deux lecteurs à la fois — le natif
// (ExperimentalPlayerHost) et le lecteur serveur quand il passe par hls.js (PlayerHost) —, quoi
// dire et quoi offrir : l'indice sous la ligne de chargement, les fenêtres (« popups ») non
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

import { MIN_MEASURED_MS, MIN_RECEIVED_BYTES, NOTICE_SHARE, SLOW_SHARE, HINT_MEASURED_MS, type LinkMeasure } from "@/lib/slowLink";
import { CRAWL } from "@/lib/networkBitrate";

// --- l'ouverture (avant la première image) -----------------------------------------------------

/**
 * La connexion « moyenne » — entre le quart et la moitié du besoin — a le temps de se rattraper :
 * on ne propose la version allégée qu'au bout de vingt secondes sans image, le seuil où l'ouverture
 * devient « bloquée » chez le natif (`STUCK_AFTER_MS`) et où le lecteur serveur renonce déjà.
 */
export const MEDIUM_POPUP_AFTER_MS = 20_000;

/** Les deux fenêtres de l'ouverture : très lente (< 25 %), moyenne (25–50 % après 20 s). */
export type OpeningPopup = "lente" | "moyenne";

export interface OpeningAdvice {
  /** « Connexion lente… » sous la ligne de chargement. */
  hint: boolean;
  /** La fenêtre à montrer, ou rien. */
  popup: OpeningPopup | null;
  /** Le débit mesuré (moyenne de la réception de l'ouverture) et le besoin, pour le journal. */
  recvBps: number | null;
  needBps: number | null;
}

const NOTHING: OpeningAdvice = { hint: false, popup: null, recvBps: null, needBps: null };

/**
 * Ce que l'ouverture dit du lien, lu chaque seconde.
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
 * - « lente » : les preuves du verdict (10 s de réception, 256 Kio) sous le quart du besoin.
 *   Montrée, elle reste tant que le débit est sous la moitié (pas de clignotement autour du quart).
 * - « moyenne » : les mêmes preuves, entre le quart et la moitié, et `elapsedMs` ≥ 20 s.
 * - `dismissed` : le spectateur a fermé la fenêtre de cette ouverture — elle ne revient pas ;
 *   l'indice, lui, reste.
 */
export function openingAdvice(
  measure: LinkMeasure | null | undefined,
  needBps: number | null | undefined,
  elapsedMs: number,
  state: { popup: OpeningPopup | null; dismissed: boolean; unstable: boolean }
): OpeningAdvice {
  try {
    if (state.unstable) return NOTHING;
    if (!measure || typeof needBps !== "number" || !Number.isFinite(needBps) || needBps <= 0) return NOTHING;
    const { bytes, receivingMs } = measure;
    if (!Number.isFinite(bytes) || !Number.isFinite(receivingMs) || !(bytes > 0)) return NOTHING;
    if (receivingMs < HINT_MEASURED_MS) return NOTHING;
    const recvBps = (bytes * 8) / (receivingMs / 1000);
    const reading = { recvBps, needBps };
    if (!(recvBps < SLOW_SHARE * needBps)) return { hint: false, popup: null, ...reading };
    const proven = receivingMs >= MIN_MEASURED_MS && bytes >= MIN_RECEIVED_BYTES;
    let popup: OpeningPopup | null = null;
    if (!state.dismissed && proven) {
      if (recvBps < NOTICE_SHARE * needBps || state.popup === "lente") popup = "lente";
      else if (elapsedMs >= MEDIUM_POPUP_AFTER_MS) popup = "moyenne";
    }
    return { hint: true, popup, ...reading };
  } catch {
    return NOTHING;
  }
}

// --- la version allégée -----------------------------------------------------------------------

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
 * - H.264 : 720p sous 4,5 Mbit/s (un 1080p à 2,5 Mbit/s de vidéo en H.264 est pâteux), 1080p au-dessus.
 * Une source 4K descend donc en 1080p au plus ; une source déjà plus petite garde sa taille (c'est un
 * plafond, pas une consigne).
 */
export function lighterMaxWidth(targetBps: number, hevc: boolean): number {
  if (hevc) return targetBps <= 2_500_000 ? 1280 : 1920;
  return targetBps < 4_500_000 ? 1280 : 1920;
}

/**
 * Le palier en cours, par titre et pour dix minutes : le temps du relais du natif au serveur et de
 * quelques essais, pas davantage — un lien qui se rétablit ne doit pas brider le film suivant.
 */
const LIGHTER_TTL_MS = 10 * 60_000;
const steps = new Map<string, LighterStep & { at: number }>();

export function noteLighter(itemId: string, step: LighterStep, now = Date.now()): void {
  try {
    steps.set(itemId, { ...step, at: now });
  } catch {
    /* rien */
  }
}

/** Le palier en cours pour ce titre, s'il est récent. */
export function lighterFor(itemId: string, now = Date.now()): LighterStep | null {
  try {
    const step = steps.get(itemId);
    if (!step || now - step.at > LIGHTER_TTL_MS) return null;
    return { targetBps: step.targetBps, tier: step.tier };
  } catch {
    return null;
  }
}

/**
 * Le plafond à demander à Jellyfin pour ce titre : celui de `pickMaxBitrate`, abaissé au palier en
 * cours — et inchangé sans palier, c'est-à-dire dans tous les cas ordinaires.
 */
export function capForLighter(itemId: string, maxBitrate: number, now = Date.now()): { maxBitrate: number; step: LighterStep | null } {
  const step = lighterFor(itemId, now);
  return step ? { maxBitrate: Math.min(maxBitrate, step.targetBps), step } : { maxBitrate, step: null };
}

/** Pour les tests. */
export function forgetLighters(): void {
  steps.clear();
}

// --- pendant la lecture : les saccades --------------------------------------------------------

/** Un blocage visible de plus de 5 s, causé par le réseau, déclenche à lui seul. */
export const LONG_STALL_MS = 5_000;
/** Sinon, le troisième blocage de plus d'une seconde… */
export const SHORT_STALL_MS = 1_000;
export const STALLS_TO_TRIGGER = 3;
/**
 * …dans une fenêtre de trois minutes : un blocage par minute se remarque à coup sûr, et c'est la
 * fenêtre que le lecteur natif donne déjà à son budget de reconstructions (3 par 180 s,
 * `PlayerLifecycle`). Trois attentes éparses dans un film de deux heures n'ont rien d'un lien qui
 * ne suit pas.
 */
export const STALL_WINDOW_MS = 3 * 60_000;
/** Une seconde fenêtre seulement trois minutes après la fermeture de la première ; deux au plus. */
export const POPUP_GAP_MS = 3 * 60_000;
export const MAX_STUTTER_POPUPS = 2;

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
 * Quand proposer la version allégée en pleine lecture. Nourrie par l'hôte : un blocage qui dure
 * (`longWait`, à 5 s), un blocage fini (`waitEnded`), et le sort de la fenêtre (`shown`, `closed`).
 * `network` : la cause classée *réseau* par le diagnostic (`playbackDiagnosis`) **et** un débit
 * mesuré sous le besoin. Une attente de calcul ou de décodeur ne compte jamais.
 */
export class StutterWatch {
  private waits: number[] = [];
  private popups = 0;
  private open = false;
  private closedAt: number | null = null;

  /** Un nouveau popup est-il permis à cet instant ? */
  private allowed(now: number): boolean {
    if (this.open || this.popups >= MAX_STUTTER_POPUPS) return false;
    return this.closedAt === null || now - this.closedAt >= POPUP_GAP_MS;
  }

  /** Un blocage en cours atteint 5 s. Vrai : montrer la fenêtre. */
  longWait(now: number, network: boolean): boolean {
    return network && this.allowed(now);
  }

  /** Un blocage fini, de `ms` millisecondes. Vrai : montrer la fenêtre (le 3e de plus d'1 s en 3 min). */
  waitEnded(now: number, ms: number, network: boolean): boolean {
    if (!network || !(ms > SHORT_STALL_MS)) return false;
    this.waits = this.waits.filter((at) => now - at < STALL_WINDOW_MS);
    this.waits.push(now);
    return this.waits.length >= STALLS_TO_TRIGGER && this.allowed(now);
  }

  shown(): void {
    this.open = true;
    this.popups += 1;
    this.waits = [];
  }

  closed(now: number): void {
    this.open = false;
    this.closedAt = now;
    this.waits = [];
  }

  get count(): number {
    return this.popups;
  }
}

// --- le journal --------------------------------------------------------------------------------

/** Ce que le spectateur a fait d'une fenêtre ou d'un écran. */
export type SlowChoice = "allégée" | "réessayer" | "fermer";

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
 * `indice +5.0 s (0.32/3.9) | lente +10.0 s (0.32/3.9) | choix allégée +14.2 s | allégée 1.5 Mb/s palier 1`.
 */
export class SlowLog {
  private events: string[] = [];
  private choice: SlowChoice | null = null;

  note(event: string): void {
    try {
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

// --- d'une lecture à la suivante : la règle des deux minutes ---------------------------------------

/**
 * Une lecture lancée moins de deux minutes après une séance passée en version allégée — quel que
 * soit le titre — démarre directement en allégée, au dernier palier (Louis, 12/10/2026) : en deux
 * minutes la connexion n'a pas changé, et la reprendre au lecteur natif referait attendre trente-cinq
 * secondes pour rien. Au-delà, ou sans séance allégée récente, la lecture repart normalement.
 *
 * Ce n'est pas un apprentissage par appareil (écarté par Louis) : la mémoire vit deux minutes, dans
 * la page et dans `sessionStorage` (elle survit au rechargement WebKit d'un changement de piste,
 * jamais à la fermeture de l'onglet), et rien n'est écrit pour durer.
 */
export const LIGHTER_CARRY_MS = 2 * 60_000;
const CARRY_KEY = "cine:lighter-carry";
let carry: (LighterStep & { at: number }) | null = null;

/** Une séance allégée s'arrête (fermée, épisode suivant, page quittée) : retenue deux minutes. */
export function rememberLighter(step: LighterStep, now = Date.now()): void {
  carry = { ...step, at: now };
  try {
    sessionStorage.setItem(CARRY_KEY, JSON.stringify(carry));
  } catch {
    /* la mémoire de la page suffit */
  }
}

/** Le palier à reprendre pour une lecture qui commence maintenant, ou `null`. */
export function carriedLighter(now = Date.now()): LighterStep | null {
  let known = carry;
  if (!known) {
    try {
      const raw = JSON.parse(sessionStorage.getItem(CARRY_KEY) ?? "null") as (LighterStep & { at: number }) | null;
      if (raw && typeof raw.targetBps === "number" && typeof raw.tier === "number" && typeof raw.at === "number") known = raw;
    } catch {
      known = null;
    }
  }
  if (!known || now - known.at > LIGHTER_CARRY_MS || now < known.at) return null;
  return { targetBps: known.targetBps, tier: known.tier };
}

/** Oublier la séance allégée : le lien a retrouvé de quoi porter la lecture classique (`LinkRecovery`). */
export function forgetLighterCarry(): void {
  carry = null;
  try {
    sessionStorage.removeItem(CARRY_KEY);
  } catch {
    /* rien */
  }
}

/**
 * Le lien a-t-il retrouvé de quoi porter la lecture *classique* ? Pendant une lecture allégée, on
 * continue de mesurer ; si la **capacité** du lien atteint 110 % du besoin du fichier d'origine en
 * pleine qualité, de façon soutenue, la mémoire des deux minutes est effacée : la lecture suivante
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
