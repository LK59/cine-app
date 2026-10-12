"use client";

// Le rechargement de page qui rouvre le lecteur serveur sur WebKit — et ce qu'il emporte.
//
// WebKit n'ouvre pas une seconde session HLS native dans une page qui a déjà servi un lecteur (voir
// `changeAudio` dans PlayerHost.tsx) : trois chemins rechargent donc la page pour rouvrir le lecteur
// serveur — le changement de piste audio (`audio-reload`), l'échelle audio épuisée (`retry-reload`)
// et, depuis le 12/10/2026, la bascule du lecteur natif vers le lecteur serveur elle-même
// (`reload-direct`). Ce dernier existe parce que le journal du 12/10 montrait, après chaque bascule
// allégée sur iPhone, la même séquence : `handover`, code 4 en 1,8 s, trois marches de l'échelle audio
// (qui croyait à un problème de piste), puis le rechargement de dernier recours — qui marchait du
// premier coup. ~10 s perdues sur 15,8, à chaque fois ; Safari chargeait les listes et ne demandait
// jamais le moindre segment.
//
// L'intention (`PLAYER_RELOAD_INTENT_KEY`, `sessionStorage`) portait la position et la piste. Elle
// porte aussi, depuis le même jour, le palier allégé en cours (`carry.lighter`, avec le fait qu'il
// vient d'une vraie bascule ou seulement de la règle des deux minutes) : sans lui, un changement de
// piste audio d'une séance allégée repartait en pleine qualité dès que la mémoire des deux minutes
// avait expiré (12/10/2026, « 28 Ans plus tard »). DECISIONS.md §78.

import { readPlaybackQuality } from "@/lib/playbackQuality";
import type { LighterStep } from "@/lib/slowLinkPolicy";
import type { StableTakeover } from "@/lib/useStableFallback";

/** Le palier allégé de la séance rechargée : la cible, le palier, et s'il vient d'une vraie bascule. */
export interface ReloadLighter extends LighterStep {
  /**
   * Vrai : une bascule a eu lieu dans cette séance — son arrêt retiendra le palier (règle des deux
   * minutes), comme avant le rechargement. Faux : le palier n'était qu'hérité, et le rechargement ne
   * réarme pas la mémoire (règle de 8.48.2).
   */
  real: boolean;
  /** La position de la bascule (secondes), pour le panneau d'infos techniques — connue d'une vraie bascule. */
  at?: number;
}

/** Ce que l'intention emporte au-delà de la position et de la piste — posé par le code d'après le 12/10/2026. */
export interface ReloadCarry {
  lighter?: ReloadLighter;
  /**
   * Un rechargement direct (bascule natif → serveur) : l'instant de la décision (`Date.now()`), d'où
   * `reloadGapMs` jusqu'à la première image ; `opening` : la bascule a eu lieu avant toute image (la
   * séance n'a pas de position exacte, le recul de reprise s'applique comme à une ouverture).
   */
  direct?: { decidedAt: number; opening: boolean };
  /** Le sous-titre que le natif montrait (relais allégé), rallumé une fois — index Jellyfin, `null` : aucun. */
  subtitleStreamIndex?: number | null;
  /** L'instant de la bascule allégée, pour `switchGapMs`. */
  switchedAt?: number;
  /** La séance du journal que la page rechargée poursuit (le natif l'a ouverte). */
  continues?: string;
  /**
   * Pourquoi le lecteur natif a cédé la main — la note « a cédé la main » du panneau d'infos
   * techniques. Sans elle, le rechargement direct effaçait la cause (`useStableFallback` vit dans la
   * page) : le panneau ne disait plus pourquoi le serveur lisait (12/10/2026).
   */
  reason?: string;
}

/** Une cause emportée reste lisible et bornée : c'est du texte relu d'un stockage de page. */
const REASON_MAX = 300;

/** L'intention écrite avant le rechargement, relue par `PlaybackProvider` au montage de la page suivante. */
export interface PlayerReloadIntent {
  itemId: string;
  title: string;
  resumeAt?: number;
  audioStreamIndex?: number;
  /** Rechargements déjà consommés par cette séance : à 1, plus aucun (ni direct, ni de dernier recours). */
  attempt?: number;
  /** La page rechargée revient au lecteur serveur (`reloadedOnServer`). */
  server?: boolean;
  carry?: ReloadCarry;
}

/** Le palier à emporter, d'après ce que la séance négociait — `undefined` sans palier. */
export function reloadLighterOf(step: LighterStep | null | undefined, real: boolean, at?: number | null): ReloadLighter | undefined {
  return step ? { targetBps: step.targetBps, tier: step.tier, real, ...(typeof at === "number" && Number.isFinite(at) ? { at } : {}) } : undefined;
}

/**
 * Le palier que la page rechargée reprend — en « Automatique » seulement : « Originale » choisie entre-
 * temps l'emporte, comme pour la mémoire des deux minutes.
 */
export function reloadedLighter(carry: ReloadCarry | undefined): LighterStep | null {
  if (!carry?.lighter || readPlaybackQuality() !== "auto") return null;
  return { targetBps: carry.lighter.targetBps, tier: carry.lighter.tier };
}

/**
 * La bascule natif → serveur doit-elle recharger la page tout de suite ?
 *
 * Seulement quand le lecteur serveur lirait en HLS natif dans un moteur WebKit (`nativeHls`, la même
 * condition que les deux autres rechargements : `playsHlsNatively`), qu'il existe, que ce n'est ni une
 * diffusion (la route AirPlay appartient à l'élément ; un Chromecast est piloté à distance) ni le banc
 * d'essai, et que la séance n'a pas déjà consommé son rechargement (une seule tentative : la page
 * rechargée qui échoue suit l'échelle et l'écran d'erreur d'avant, jamais une boucle).
 */
export function shouldReloadDirect(input: {
  nativeHls: boolean;
  serverFallback: boolean | undefined;
  takeover: StableTakeover | undefined;
  reloadAttempt: number | undefined;
  bench: string | undefined;
}): boolean {
  if (!input.nativeHls || input.serverFallback === false) return false;
  if (input.takeover?.cast || input.takeover?.castTarget) return false;
  if (input.bench) return false;
  // Les bascules vers la version allégée seulement : ce sont elles qui ont échoué dans la page à
  // chaque essai sur iPhone (12/10/2026, « élément : code 4 » ×3 puis rechargement), alors que 5 des 6
  // replis ordinaires de « Ruby » sur iPhone et les bascules de Safari Mac y ont marché. Un repli
  // ordinaire garde son chemin éprouvé plutôt que de payer un rechargement (choix de Louis : la
  // stabilité d'abord).
  if (!input.takeover?.lighter) return false;
  return (input.reloadAttempt ?? 0) < 1;
}

/** L'intention du rechargement direct, d'après la séance et le relais du lecteur natif. */
export function directReloadIntent(
  session: { itemId: string; title: string; resumeAt?: number; initialAudioStreamIndex?: number },
  takeover: StableTakeover | undefined,
  logSession: string | undefined,
  reason?: string,
  now = Date.now()
): PlayerReloadIntent {
  const audio = takeover ? takeover.audioStreamIndex : session.initialAudioStreamIndex;
  const resumeAt = takeover ? takeover.resumeAt : session.resumeAt;
  return {
    itemId: session.itemId,
    title: session.title,
    ...(resumeAt !== undefined ? { resumeAt } : {}),
    ...(audio !== undefined ? { audioStreamIndex: audio } : {}),
    attempt: 1,
    server: true,
    carry: {
      direct: { decidedAt: now, opening: !takeover },
      ...(takeover?.lighter ? { lighter: reloadLighterOf(takeover.lighter, true, takeover.resumeAt) } : {}),
      ...(takeover?.lighter && takeover.subtitleStreamIndex !== undefined ? { subtitleStreamIndex: takeover.subtitleStreamIndex } : {}),
      ...(takeover?.switchedAt !== undefined ? { switchedAt: takeover.switchedAt } : {}),
      ...(logSession ? { continues: logSession } : {}),
      ...(reason ? { reason: reason.slice(0, REASON_MAX) } : {}),
    },
  };
}

/** Relit une intention : rien d'inventé, un champ mal formé est ignoré. */
export function parseReloadIntent(raw: string): PlayerReloadIntent | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || typeof value.itemId !== "string") return null;
    const carry = value.carry && typeof value.carry === "object" ? (value.carry as Record<string, unknown>) : undefined;
    const lighter = carry?.lighter as Record<string, unknown> | undefined;
    const direct = carry?.direct as Record<string, unknown> | undefined;
    return {
      itemId: value.itemId,
      title: typeof value.title === "string" ? value.title : "",
      ...(typeof value.resumeAt === "number" ? { resumeAt: value.resumeAt } : {}),
      ...(typeof value.audioStreamIndex === "number" ? { audioStreamIndex: value.audioStreamIndex } : {}),
      ...(typeof value.attempt === "number" ? { attempt: value.attempt } : {}),
      ...(value.server === true ? { server: true } : {}),
      ...(carry
        ? {
            carry: {
              ...(lighter && typeof lighter.targetBps === "number" && typeof lighter.tier === "number"
                ? {
                    lighter: {
                      targetBps: lighter.targetBps,
                      tier: lighter.tier,
                      real: lighter.real === true,
                      ...(typeof lighter.at === "number" && Number.isFinite(lighter.at) && lighter.at >= 0 ? { at: lighter.at } : {}),
                    },
                  }
                : {}),
              ...(direct && typeof direct.decidedAt === "number" ? { direct: { decidedAt: direct.decidedAt, opening: direct.opening === true } } : {}),
              ...(typeof carry.subtitleStreamIndex === "number" || carry.subtitleStreamIndex === null
                ? { subtitleStreamIndex: carry.subtitleStreamIndex as number | null }
                : {}),
              ...(typeof carry.switchedAt === "number" ? { switchedAt: carry.switchedAt } : {}),
              ...(typeof carry.continues === "string" ? { continues: carry.continues } : {}),
              ...(typeof carry.reason === "string" && carry.reason ? { reason: carry.reason.slice(0, REASON_MAX) } : {}),
            },
          }
        : {}),
    };
  } catch {
    return null;
  }
}

/** Recharge la page — une fonction à elle pour que les tests puissent la remplacer (jsdom ne recharge pas). */
export function reloadPage(): void {
  window.location.reload();
}
