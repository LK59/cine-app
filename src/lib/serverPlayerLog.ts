/**
 * Ce que le lecteur serveur écrit dans le journal du lecteur.
 *
 * Il n'écrivait rien jusqu'au 23/09/2026 : ni sa prise de main, ni une négociation refusée, ni une
 * diffusion établie. Un repli vers lui se lisait donc comme une fin de séance — la dernière ligne
 * était le `fallback` du lecteur natif —, et l'AirPlay figé du 22/09 n'a pu être compris qu'au
 * journal du relais, en cherchant des requêtes sans laissez-passer. Ces lignes disent à la place :
 * il a pris la main (par quelle voie, pour un téléviseur ou non), il n'a pas pu, le téléviseur
 * s'est connecté.
 *
 * Des fonctions pures, parce que le composant qui les appelle ne se monte pas dans un test : ce
 * qu'elles décident — les champs, et le nom du lecteur sur chaque ligne — se vérifie ici.
 */

import type { SleepMode } from "@/lib/sleepTimer";
import type { TallySummary } from "@/lib/playerSessionTally";

/**
 * Pourquoi le lecteur serveur (re)négocie son flux — le `why` de sa ligne `start`.
 *
 * Chaque négociation écrivait la même ligne « transcodé par le serveur » : les quatre essais de
 * « Ruby » sur une Fire TV et trois départs d'Augustine sur Edge (10/10/2026) se lisaient pareil,
 * sans qu'on puisse distinguer une échelle de repli qui échoue d'un changement de piste. Un saut,
 * lui, ne renégocie pas : le HLS se déplace dans le même flux (hls.js, ou Safari), il n'a pas de
 * ligne `start`.
 */
export type ServerStartWhy =
  /** La première négociation de la séance. */
  | "open"
  /** La première aussi, mais le lecteur natif vient de passer la main (`fallback` juste avant). */
  | "handover"
  /** Page rechargée pour changer de piste audio (WebKit, voir `changeAudio`). */
  | "audio-reload"
  /** Page rechargée en dernier recours après une échelle de repli épuisée (WebKit). */
  | "retry-reload"
  /** Changement de piste audio sur place. */
  | "audio"
  /** « Réessayer », pressé par le spectateur sur l'écran d'erreur. */
  | "retry"
  /** La diffusion relancée après une route perdue. */
  | "cast-relaunch"
  /** Un échelon de l'échelle de repli audio, après une erreur de l'élément. */
  | "ladder";

export const SERVER_START_WHY_LABELS: Record<ServerStartWhy, string> = {
  open: "ouverture",
  handover: "relais du lecteur natif",
  "audio-reload": "piste audio (page rechargée)",
  "retry-reload": "page rechargée après échec",
  audio: "changement de piste audio",
  retry: "réessayer",
  "cast-relaunch": "relance de la diffusion",
  ladder: "relance après erreur",
};

export function isStartWhy(why: unknown): why is ServerStartWhy {
  return typeof why === "string" && Object.prototype.hasOwnProperty.call(SERVER_START_WHY_LABELS, why);
}

/** Une ouverture n'est pas une relance : la séance commence. */
export function isServerRestart(why: unknown): boolean {
  return isStartWhy(why) && why !== "open" && why !== "handover";
}

/** Une relance qui suit une panne, et non un geste du spectateur. */
export function isServerFailureRestart(why: unknown): boolean {
  return why === "ladder" || why === "retry-reload";
}

/** Le libellé d'un `why` de départ, ou `null` pour une ligne d'avant le 10/10/2026. */
export function serverStartWhyLabel(why: unknown, rung?: unknown): string | null {
  if (!isStartWhy(why)) return null;
  const label = SERVER_START_WHY_LABELS[why];
  return why === "ladder" && typeof rung === "number" ? `${label} (essai ${rung})` : label;
}

/** Ce qui a provoqué une négociation, porté par sa ligne `start`. */
export interface ServerStartCause {
  why: ServerStartWhy;
  /** L'échelon de l'échelle de repli (1 = la requête rejouée à l'identique). */
  rung?: number;
  /** L'erreur qui l'a déclenché, en quelques mots (« élément : code 4 »). */
  trigger?: string;
}

/** Ce que toute ligne du lecteur serveur porte, pour se distinguer de celles du lecteur natif. */
export interface ServerPlayerContext {
  itemId: string;
  title: string | null | undefined;
  /** La lecture a été ouverte pour un téléviseur (AirPlay, Remote Playback). */
  cast: boolean;
  /**
   * La séance d'un banc d'essai, s'il y en a une : ses lignes vont alors dans `bench-player.log`,
   * comme celles du lecteur natif. Un film confié au lecteur serveur pendant un banc écrivait son
   * `start` dans le journal des spectateurs (23/09/2026).
   */
  bench?: string;
  /**
   * L'identifiant de séance, comme les lignes du lecteur natif, et le navigateur. Sans eux, le
   * journal reconstituait ces séances « à l'ancienne », par compte et par titre : chaque relance
   * devenait une séance, sans appareil — et, dans le diagnostic « fichier ou appareil », un
   * témoin « propre » qui innocentait le titre (relu le 24/09/2026).
   */
  session?: string;
  agent?: string;
}

/** Le lecteur serveur a obtenu son flux et le pose sur l'élément. */
export function serverStartFields(
  ctx: ServerPlayerContext,
  stream: { directPlay: boolean; nativeHls: boolean; resumeAt: number | undefined; audioStreamIndex: number | undefined },
  cause?: ServerStartCause
): Record<string, unknown> {
  return {
    ...base(ctx),
    ...(cause ? { why: cause.why } : {}),
    ...(cause?.rung !== undefined ? { rung: cause.rung } : {}),
    ...(cause?.trigger ? { trigger: cause.trigger } : {}),
    // Le même nom de champ que le lecteur natif (`remux`, `webcodecs`) : une seule question,
    // « par où cette séance est-elle passée », une seule colonne pour y répondre.
    path: "serveur",
    reason: stream.directPlay ? "fichier servi tel quel" : "transcodé par le serveur",
    hls: stream.directPlay ? "aucun" : stream.nativeHls ? "natif" : "hls.js",
    at: stream.resumeAt ?? 0,
    ...(stream.audioStreamIndex !== undefined ? { audioStreamIndex: stream.audioStreamIndex } : {}),
  };
}

/** Le lecteur serveur n'a pas pu démarrer, ou s'est arrêté sur une erreur affichée. */
export function serverFailureFields(ctx: ServerPlayerContext, reason: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...base(ctx), path: "serveur", reason, ...extra };
}

/** Le téléviseur a pris la route : la diffusion est établie, et non seulement demandée. */
export function castEstablishedFields(ctx: ServerPlayerContext, at: number, resumeAt?: number | null): Record<string, unknown> {
  // `cast: true` quel que soit le contexte : une route prise depuis les commandes de la vidéo, dans
  // une séance qui n'avait pas été ouverte pour diffuser, est une diffusion tout autant.
  // `resumeAt` : la reprise pas encore prise par l'élément à cet instant — voir `CastResume`.
  return {
    ...base(ctx),
    cast: true,
    path: "serveur",
    reason: "diffusion établie",
    at: Math.round(at),
    ...(resumeAt != null ? { resumeAt: Math.round(resumeAt) } : {}),
  };
}

/** La reprise reposée sur le téléviseur, qui était reparti d'ailleurs — voir `CastResume`. */
export function castResumeFields(ctx: ServerPlayerContext, from: number, resumeAt: number): Record<string, unknown> {
  return { ...base(ctx), cast: true, path: "serveur", reason: "reprise reposée sur le téléviseur", at: Math.round(from), resumeAt: Math.round(resumeAt) };
}

/**
 * La diffusion s'est arrêtée — le téléviseur, le centre de contrôle, ou cette page.
 *
 * Une diffusion qui finit n'est pas un repli raté : `cast: true` quoi que dise le contexte (une
 * séance ouverte sur le téléphone puis envoyée à la télé par les commandes de la vidéo n'est pas
 * une « séance de diffusion »), et la séance, sans laquelle la ligne tombait dans une séance
 * reconstituée et comptait comme un échec sur la page Activité (relu le 24/09/2026).
 */
export function castEndedFields(ctx: ServerPlayerContext, source: string, at: number, watched?: number): Record<string, unknown> {
  return { ...base(ctx), cast: true, path: "serveur", reason: `fin de diffusion (${source})`, at: Math.round(at), ...(watched !== undefined ? { watched } : {}) };
}

/** Pourquoi la séance du lecteur serveur se termine — le `why` de sa ligne `stop`. */
export type ServerStopWhy =
  /** La croix, la fin du film sans épisode suivant, Échap. */
  | "close"
  /** L'épisode suivant prend la place, dans le même lecteur. */
  | "next"
  /** La page se ferme ou se recharge (`pagehide`). */
  | "page"
  /** Le lecteur disparaît sans avoir été fermé (un autre lecteur prend l'écran). */
  | "unmount"
  /** Bilan resté sur l'appareil (page tuée par iOS), renvoyé au lancement suivant — `unsentStop`. */
  | "lost";

/** Ce que le bilan ajoute à la position et au temps regardé. */
export interface ServerStopFacts {
  /** La minuterie de veille choisie ou déclenchée (`sleepTimerLogFields`). */
  sleepTimer?: SleepMode;
  /** La durée du titre, quand l'élément la connaît. */
  duration?: number | null;
  ended?: boolean;
  /** Attentes, sauts, pistes, arrière-plan — le décompte partagé avec le lecteur natif. */
  tally?: TallySummary;
  subtitleSwitches?: number;
  /** Les relances de la séance (hors ouverture), par motif. */
  restarts?: Partial<Record<ServerStartWhy, number>>;
  /** L'erreur affichée au moment de l'arrêt, s'il y en avait une. */
  error?: string | null;
  /** Fermé avant la première image : depuis combien de temps le spectateur attendait. */
  gaveUpAfterMs?: number;
}

/** « ladder×3, audio×1 » — les motifs dans l'ordre de leur nombre, lisibles d'un coup d'œil. */
export function formatRestarts(restarts: Partial<Record<ServerStartWhy, number>>): string {
  return Object.entries(restarts)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && entry[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([why, n]) => `${why}×${n}`)
    .join(", ");
}

/**
 * Le lecteur serveur s'arrête — son bilan, comme celui du lecteur natif.
 *
 * Il notait son démarrage et jamais sa fin : chacune de ses séances se lisait « commencée, jamais
 * finie » dans le journal, comme un lecteur disparu (relevé le 23/09/2026). Puis seulement la
 * position et le temps regardé : rien ne disait si la séance avait attendu, sauté, changé de piste
 * ou relancé quatre fois sa négociation (10/10/2026, Augustine sur Edge). Les mêmes champs que le
 * `stop` natif (`waits`, `waitedMs`, `longestWaitMs`, `seeks`, `seekWaitMs`, `audioSwitches`,
 * `backgrounds`…), pour que la page Activité les lise sans distinguer les deux lecteurs.
 */
export function serverStopFields(
  ctx: ServerPlayerContext,
  why: ServerStopWhy,
  at: number,
  watched: number,
  facts: ServerStopFacts = {}
): Record<string, unknown> {
  // `watched` : le temps joué par ce lecteur-ci depuis sa dernière ligne qui en rendait compte, et
  // non la position — un film repris à une heure n'a pas été regardé une heure. Sans lui, une
  // séance passée par le serveur se lisait à zéro seconde regardée (24/09/2026).
  const restarts = facts.restarts ? Object.values(facts.restarts).reduce<number>((n, v) => n + (v ?? 0), 0) : 0;
  const duration = facts.duration;
  return {
    ...base(ctx),
    path: "serveur",
    why,
    at: Math.round(at),
    watched,
    ...(duration != null && Number.isFinite(duration) && duration > 0 ? { duration: Math.round(duration) } : {}),
    ...(facts.ended !== undefined ? { ended: facts.ended } : {}),
    ...(facts.tally ?? {}),
    ...(facts.subtitleSwitches !== undefined ? { subtitleSwitches: facts.subtitleSwitches } : {}),
    ...(facts.restarts ? { restarts, ...(restarts > 0 ? { restartWhy: formatRestarts(facts.restarts) } : {}) } : {}),
    ...(facts.error ? { error: facts.error } : {}),
    ...(facts.gaveUpAfterMs !== undefined ? { gaveUpAfterMs: Math.round(facts.gaveUpAfterMs) } : {}),
    ...(facts.sleepTimer !== undefined ? { sleepTimer: facts.sleepTimer } : {}),
  };
}

/**
 * La minuterie de veille a mis le film en pause — ou retenu l'épisode à sa fin. Une ligne `pause`,
 * la même que celle du lecteur natif : sans elle, un film arrêté en pleine soirée et jamais fermé
 * se lisait comme un spectateur parti sans prévenir.
 */
export function serverSleepFields(ctx: ServerPlayerContext, mode: SleepMode, at: number): Record<string, unknown> {
  return { ...base(ctx), path: "serveur", why: "veille", sleepTimer: mode, at: Math.round(at) };
}

function base(ctx: ServerPlayerContext): Record<string, unknown> {
  return {
    itemId: ctx.itemId,
    ...(ctx.title ? { title: ctx.title } : {}),
    player: "serveur",
    cast: ctx.cast,
    ...(ctx.bench ? { bench: ctx.bench } : {}),
    ...(ctx.session ? { session: ctx.session } : {}),
    ...(ctx.agent ? { agent: ctx.agent } : {}),
  };
}
