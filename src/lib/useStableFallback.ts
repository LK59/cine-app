"use client";

import { useCallback, useEffect, useState } from "react";

/** How long the word stays up. Long enough to read, short enough not to become furniture. */
export const NEGOTIATING_MS = 4000;

/**
 * What the player stepping down knows and the one taking over would otherwise have to guess.
 *
 * A handover at startup needs none of this: nothing has played, and the session already says
 * where to open and in which language. A handover *during* playback is the opposite case — the
 * viewer is forty minutes in and has just asked for a track the native path cannot carry. Without
 * this, the stable player would open at the position the session was created with and on the
 * file's default track: the film would jump backwards and stay in the wrong language, which is
 * both of the things the viewer was trying to change.
 */
export interface StableTakeover {
  /**
   * Where the native player was, in seconds.
   *
   * Always a number, zero included — never omitted. See `PlaybackSession.resumeAt`: an absent
   * field means "ask the server", which here names precisely the position being replaced.
   */
  resumeAt: number;
  /**
   * Jellyfin's stream index for the track the viewer asked for.
   *
   * Absent when it could not be named with confidence, in which case the stable player picks its
   * own default — a film in the wrong language beats a film on a track chosen by a bad guess.
   */
  audioStreamIndex?: number;
  /**
   * La séance à qui ce relais appartient, comparée par identité.
   *
   * Sans elle, le relais survivait à la lecture qui l'avait produit. `handedOver` est volontairement
   * gardé pour toute la session de l'application — un fichier que le lecteur natif ne sait pas
   * porter, il ne le saura pas mieux au coup suivant —, si bien que rouvrir le même film y revient
   * directement. Il y retrouvait alors une position vieille de quarante minutes et écrasait le
   * `resumeAt` demandé : « Recommencer depuis le début » repartait au milieu du film. C'est
   * exactement la confusion que `PlaybackSession.resumeAt` met en garde de commettre.
   *
   * `PlaybackProvider` ne recrée cet objet que sur `play` et `advance` — jamais en réduisant ou en
   * agrandissant le lecteur. L'identité dit donc précisément ce qu'on veut savoir : est-ce toujours
   * la même lecture ? Un épisode suivant n'hérite pas non plus de la position du précédent.
   */
  owner?: unknown;
}

/**
 * Le relais, s'il appartient bien à cette lecture-ci — sinon rien.
 *
 * Une fonction plutôt qu'une comparaison écrite sur place : c'est une règle, elle mérite un nom et
 * un test à elle. Elle est la seule chose qui sépare « reprendre là où le lecteur natif s'est
 * arrêté » de « écraser la position d'une lecture qui n'a rien demandé ».
 */
export function takeoverFor(takeover: StableTakeover | null | undefined, session: unknown): StableTakeover | null {
  return takeover && takeover.owner === session ? takeover : null;
}

export interface StableFallback {
  /** Items the experimental player has given up on, for this session only. */
  handedOver: string[];
  /** Whether to show the viewer that something is being arranged on their behalf. */
  negotiating: boolean;
  /** Why it happened, kept for the technical panel of the player that took over. */
  reason: string | null;
  /** Set only by a handover that happened mid-playback. See StableTakeover. */
  takeover: StableTakeover | null;
  /** Called by the experimental player when it cannot go on. Idempotent per item. */
  stepAside: (itemId: string, reason: string, takeover?: StableTakeover) => void;
}

/**
 * The handover from the experimental player to the stable one.
 *
 * Deliberately not persisted: it applies to the session in front of the viewer, so the setting
 * stays the source of truth and the next playback tries the good path again. That is what makes
 * a step down a measurement rather than a verdict — a file that fails once because a decoder was
 * busy is not a file that cannot be played.
 *
 * Recorded per item rather than globally, for the same reason: one file the experimental player
 * cannot carry says nothing about the next.
 */
export function useStableFallback(): StableFallback {
  const [handedOver, setHandedOver] = useState<string[]>([]);
  const [negotiating, setNegotiating] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [takeover, setTakeover] = useState<StableTakeover | null>(null);

  const stepAside = useCallback((itemId: string, why: string, resumeInto?: StableTakeover) => {
    setHandedOver((ids) => {
      // Already given up on: the word has been said and saying it twice would only interrupt
      // a player that is by now busy playing.
      if (ids.includes(itemId)) return ids;
      setReason(why);
      // Cleared as well as set: a later handover on another item must not inherit the position
      // and track of the previous one.
      setTakeover(resumeInto ?? null);
      setNegotiating(true);
      return [...ids, itemId];
    });
  }, []);

  useEffect(() => {
    if (!negotiating) return;
    const id = setTimeout(() => setNegotiating(false), NEGOTIATING_MS);
    return () => clearTimeout(id);
  }, [negotiating]);

  return { handedOver, negotiating, reason, takeover, stepAside };
}
