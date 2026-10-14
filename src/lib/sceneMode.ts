"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";

/**
 * Une scène ouverte depuis une réplique (recherche de répliques → appui → lecture à début − 5 s)
 * n'est pas une reprise (14/10/2026, DECISIONS.md §91).
 *
 * Constaté sur téléphone : la position atteinte en regardant une réplique devenait la reprise du
 * film — « Reprendre » proposait la 74e minute d'un film qu'on n'avait jamais commencé, et un
 * passage regardé près de la fin pouvait le marquer vu. Une lecture `scene` ne dit donc rien à
 * Jellyfin — ni annonce, ni battement, ni arrêt, ni position gardée sur l'appareil pour plus tard —,
 * ne note rien pour le recul de reprise, ne garde pas d'octets pour une reprise instantanée et
 * n'enchaîne pas l'épisode suivant.
 *
 * **Sauf si l'on continue à regarder** : au-delà de dix minutes *jouées* depuis l'ouverture de la
 * scène, elle devient une lecture ordinaire, et tout repart à partir de cet instant — l'annonce
 * d'abord, puis les battements. Du temps joué, et non du temps passé : une scène laissée en pause
 * dix minutes n'a pas été « regardée au-delà ».
 *
 * L'horloge appartient à la lecture (`openId`), pas au lecteur : un relais natif → serveur continue
 * le même décompte au lieu de le recommencer, et un rechargement de page (WebKit) l'emporte dans
 * son intention (`ReloadCarry.scene`).
 */
export const SCENE_NORMAL_AFTER_MS = 10 * 60_000;

/** Le pas d'une horloge vivante ; un écart plus long (onglet endormi) ne compte pas comme joué. */
const TICK_MS = 1_000;
const MAX_STEP_MS = 5_000;

export class SceneClock {
  watchedMs: number;
  normal: boolean;
  private lastAt: number | null = null;

  constructor(seedMs = 0) {
    this.watchedMs = Math.max(0, seedMs);
    this.normal = this.watchedMs >= SCENE_NORMAL_AFTER_MS;
  }

  /** Une seconde de plus, jouée ou non. Vrai à l'instant précis où la scène devient une lecture. */
  tick(now: number, playing: boolean): boolean {
    if (this.normal) return false;
    if (playing && this.lastAt !== null) this.watchedMs += Math.min(Math.max(0, now - this.lastAt), MAX_STEP_MS);
    this.lastAt = playing ? now : null;
    if (this.watchedMs < SCENE_NORMAL_AFTER_MS) return false;
    this.normal = true;
    return true;
  }
}

/** Ce qu'une séance doit porter pour être une scène — voir `PlaybackSession.scene`. */
export interface SceneSession {
  itemId: string;
  openId?: number;
  scene?: boolean;
  /** Le temps déjà joué emporté par un rechargement de page — posé par `PlaybackProvider` seulement. */
  sceneWatchedMs?: number;
}

/** Les horloges des lectures récentes ; bornées, une lecture n'en a qu'une. */
const clocks = new Map<string, SceneClock>();
const MAX_CLOCKS = 4;

function keyOf(session: SceneSession): string {
  return `${session.openId ?? "-"}:${session.itemId}`;
}

/** L'horloge de cette lecture, créée à la première demande ; `null` pour une lecture ordinaire. */
export function sceneClockFor(session: SceneSession): SceneClock | null {
  if (session.scene !== true) return null;
  const key = keyOf(session);
  let clock = clocks.get(key);
  if (!clock) {
    clock = new SceneClock(session.sceneWatchedMs ?? 0);
    clocks.set(key, clock);
    while (clocks.size > MAX_CLOCKS) clocks.delete(clocks.keys().next().value as string);
  }
  return clock;
}

/** Encore une scène à cet instant : rien ne doit être rapporté ni gardé. */
export function isSceneNow(session: SceneSession): boolean {
  const clock = sceneClockFor(session);
  return clock !== null && !clock.normal;
}

/** Ce qu'emporte l'intention d'un rechargement de page, tant que la lecture est encore une scène. */
export function sceneCarryOf(session: SceneSession): { watchedMs: number } | undefined {
  const clock = sceneClockFor(session);
  return clock && !clock.normal ? { watchedMs: Math.round(clock.watchedMs) } : undefined;
}

/**
 * Les champs du journal : `scene: true` sur toutes les lignes d'une lecture ouverte en scène, et
 * `sceneNormal: true` une fois qu'elle est devenue une lecture ordinaire — un `stop` sans lui n'a
 * rien écrit chez Jellyfin, et `recoverLostPosition` le sait.
 */
export function sceneLogFields(session: SceneSession): Record<string, boolean> {
  const clock = sceneClockFor(session);
  if (!clock) return {};
  return clock.normal ? { scene: true, sceneNormal: true } : { scene: true };
}

/** Pour les tests. */
export function __resetSceneClocks(): void {
  clocks.clear();
}

/**
 * L'état « scène » d'un lecteur : `active` pour le rendu (ce qui est passé à `usePlaybackSession`,
 * l'épisode suivant), `isScene()` pour les écouteurs posés une fois pour toutes. `isPlaying` est lu
 * chaque seconde, par une référence.
 */
export function useSceneMode(
  session: SceneSession,
  isPlaying: () => boolean
): { active: boolean; isScene: () => boolean; logFields: () => Record<string, boolean> } {
  const { itemId, openId, scene, sceneWatchedMs } = session;
  // Une horloge par lecture : relue quand la séance change de titre ou d'ouverture.
  const [clock, setClock] = useState(() => sceneClockFor({ itemId, openId, scene, sceneWatchedMs }));
  const [clockKey, setClockKey] = useState(`${openId}:${itemId}:${scene}`);
  const key = `${openId}:${itemId}:${scene}`;
  if (key !== clockKey) {
    setClockKey(key);
    setClock(sceneClockFor({ itemId, openId, scene, sceneWatchedMs }));
  }
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const playingRef = useRef(isPlaying);
  useEffect(() => {
    playingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    if (!clock || clock.normal) return;
    const timer = setInterval(() => {
      if (clock.tick(Date.now(), playingRef.current())) rerender();
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [clock]);

  const isScene = useCallback(() => clock !== null && !clock.normal, [clock]);
  const logFields = useCallback((): Record<string, boolean> => {
    if (!clock) return {};
    return clock.normal ? { scene: true, sceneNormal: true } : { scene: true };
  }, [clock]);
  return { active: clock !== null && !clock.normal, isScene, logFields };
}
