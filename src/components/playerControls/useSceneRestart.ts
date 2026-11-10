"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import useSWR from "swr";
import { fetcher, followOnlyOptions } from "@/lib/swr";
import { reportPlayback } from "@/lib/reportPlayback";
import { SCENE_RESTART_SHOWN_MS, decideSceneRestart } from "@/lib/sceneRestart";
import {
  beginSceneRestart,
  noteSceneRestartInterrupt,
  noteSceneRestartOutcome,
  noteSceneRestartVerdict,
  sceneRestartState,
  subscribeSceneRestart,
  type SceneRestartOutcome,
} from "@/lib/sceneRestartSession";
import type { XrayPlayerPayload } from "@/lib/xray/scenes";

/**
 * « Revenir au début de la scène » dans les commandes (DECISIONS.md §143) : la décision (`decideSceneRestart`)
 * prise **une fois par séance**, à la première image à la position de reprise, sur les scènes qu'« À l'écran »
 * a déjà lues (`useXrayScenes`) — aucune requête de plus. Le bouton n'est montré qu'au public réglé
 * (`SCENE_RESTART_ENABLED`, `sceneRestartAvailable` de la configuration publique, **suivie, jamais demandée**) ;
 * coupé, la décision est seulement retenue pour le bilan (`sceneRestart: "aurait-proposé" | "non:<raison>"`).
 *
 * Sans les acteurs à l'écran (`offered` faux : option coupée, Fire TV, lecteur hors ligne, banc), rien ne
 * tourne et rien n'est retenu : les empreintes du lecteur, dont les doubles n'ont pas l'option, ne bougent pas.
 *
 * Montré, il reste `SCENE_RESTART_SHOWN_MS` à partir de la première image, à la place de « Passer l'intro »
 * (qui garde la priorité — une invite à la fois) ; son issue part au journal, une ligne `debut-scene` par séance.
 */

function useSceneRestartShown(): boolean {
  const { data } = useSWR<{ sceneRestartAvailable?: boolean }>("/api/config/public", fetcher, followOnlyOptions);
  return data?.sceneRestartAvailable === true;
}

export interface SceneRestartPrompt {
  target: number;
}

export function useSceneRestart({
  itemId,
  offered,
  payload,
  currentTime,
  playing,
  settled,
  castActive,
  introSkip,
  recapSkip,
  creditsStart,
}: {
  itemId: string;
  /** Les acteurs à l'écran sont offerts à cette séance (`xrayOffered`). */
  offered: boolean;
  payload: XrayPlayerPayload | null;
  currentTime: number;
  playing: boolean;
  /** Ni chargement, ni ouverture, ni reprise en cours : l'image est là. */
  settled: boolean;
  castActive: boolean;
  introSkip: { start: number; end: number } | null;
  recapSkip: { start: number; end: number } | null;
  creditsStart: number | null;
}): { prompt: SceneRestartPrompt | null; use: (seek: (t: number) => void) => void; noteSeek: () => void; noteTrack: () => void } {
  const shown = useSceneRestartShown();
  const entry = useSyncExternalStore(
    subscribeSceneRestart,
    () => (offered ? sceneRestartState(itemId) : null),
    () => null
  );

  useEffect(() => {
    if (offered) beginSceneRestart(itemId);
  }, [offered, itemId]);

  /** La première image de cette séance : position et instant, une fois par montage. */
  const firstFrameRef = useRef<{ itemId: string; at: number; when: number } | null>(null);
  const firstFrameNow = offered && settled && playing;

  const finish = useCallback(
    (outcome: SceneRestartOutcome) => {
      const state = sceneRestartState(itemId);
      if (!noteSceneRestartOutcome(itemId, outcome) || !state || state.shownAt === undefined) return;
      reportPlayback("debut-scene", {
        itemId,
        outcome,
        at: state.at,
        target: state.target,
        back: state.back,
        why: state.why,
        shownMs: Date.now() - state.shownAt,
      });
    },
    [itemId]
  );

  // La décision : à la première image, dès que les scènes sont lues ; un saut ou un changement de piste avant
  // l'a déjà refusée. Les scènes arrivées après la fenêtre du bouton ne servent plus.
  useEffect(() => {
    if (!offered || !entry || entry.verdict || !entry.live) return;
    if (!firstFrameNow && !firstFrameRef.current) return;
    if (!firstFrameRef.current || firstFrameRef.current.itemId !== itemId) {
      firstFrameRef.current = { itemId, at: currentTime, when: Date.now() };
    }
    const first = firstFrameRef.current;
    const decide = () => {
      if (castActive) return noteSceneRestartVerdict(itemId, "non:diffusion");
      const decision = decideSceneRestart({
        position: first.at,
        now: Date.now(),
        lastPlayedAt: entry.lastPlayedAt,
        payload,
        introSkip,
        recapSkip,
        creditsStart,
        interrupted: entry.interrupted ?? null,
      });
      if (!decision.offer) return noteSceneRestartVerdict(itemId, `non:${decision.reason}`);
      const facts = { at: Math.round(first.at * 10) / 10, target: decision.target, back: Math.round(decision.back), why: decision.why };
      if (!shown) return noteSceneRestartVerdict(itemId, "aurait-proposé", facts);
      noteSceneRestartVerdict(itemId, "proposé", { ...facts, shownAt: first.when });
    };
    if (payload || entry.interrupted) {
      decide();
      return;
    }
    // Les scènes pas encore lues : attendues tant que le bouton aurait encore sa place.
    const left = first.when + SCENE_RESTART_SHOWN_MS - Date.now();
    if (left <= 0) {
      noteSceneRestartVerdict(itemId, "non:scènes-tardives");
      return;
    }
    const timer = window.setTimeout(() => noteSceneRestartVerdict(itemId, "non:scènes-tardives"), left);
    return () => window.clearTimeout(timer);
  }, [offered, entry, firstFrameNow, itemId, currentTime, payload, castActive, introSkip, recapSkip, creditsStart, shown]);

  const showing = offered && shown && entry?.verdict === "proposé" && !entry.outcome && entry.shownAt !== undefined && entry.target !== undefined;
  // Le temps du bouton : `SCENE_RESTART_SHOWN_MS` depuis la première image, puis « ignoré ».
  useEffect(() => {
    if (!showing || entry?.shownAt === undefined) return;
    const timer = window.setTimeout(() => finish("ignoré"), Math.max(0, entry.shownAt + SCENE_RESTART_SHOWN_MS - Date.now()));
    return () => window.clearTimeout(timer);
  }, [showing, entry?.shownAt, finish]);
  // Les commandes démontées pendant qu'il est à l'écran (fermeture, passage de main) : « fermé ».
  const showingRef = useRef(false);
  useEffect(() => {
    showingRef.current = showing;
  }, [showing]);
  useEffect(
    () => () => {
      if (showingRef.current) finish("fermé");
    },
    [finish]
  );

  const noteSeek = useCallback(() => {
    if (!offered) return;
    const state = sceneRestartState(itemId);
    if (!state) return;
    if (!state.verdict) noteSceneRestartInterrupt(itemId, "saut");
    else if (state.verdict === "proposé" && !state.outcome) finish("saut");
  }, [offered, itemId, finish]);
  const noteTrack = useCallback(() => {
    if (offered) noteSceneRestartInterrupt(itemId, "piste");
  }, [offered, itemId]);
  const use = useCallback(
    (seek: (t: number) => void) => {
      const state = sceneRestartState(itemId);
      if (!state || state.target === undefined) return;
      const target = state.target;
      finish("utilisé");
      seek(target);
    },
    [itemId, finish]
  );

  return { prompt: showing && entry?.target !== undefined ? { target: entry.target } : null, use, noteSeek, noteTrack };
}
