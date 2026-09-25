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
  /**
   * Cette bascule est-elle un choix, et non un échec ?
   *
   * La différence gouverne le retour. `handedOver` ne se vide jamais, et c'est juste : une bascule
   * ordinaire signifie que le lecteur natif **n'a pas su** porter ce fichier, et y revenir
   * rejouerait l'échec en boucle. Diffuser n'est pas un échec — le lecteur natif marchait très
   * bien, on l'a quitté parce qu'un flux MediaSource ne se diffuse pas. Lui seul autorise donc
   * `stepBack`.
   */
  cast?: boolean;
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

/**
 * Une diffusion qui se poursuit à l'épisode suivant : le relais, reporté sur la nouvelle séance.
 *
 * Passer à l'épisode suivant garde le numéro d'ouverture et change l'épisode (`advance`). Le relais
 * de diffusion appartenait à la séance d'avant : le nouvel épisode n'était plus « confié », le
 * lecteur natif se remontait pour lui, et AirPlay tombait — l'épisode suivant jouait sur le
 * téléphone (relu le 24/09/2026). Une diffusion reste une diffusion tant que la lecture n'a pas
 * été fermée ; une autre ouverture (un autre numéro) ne l'hérite jamais.
 */
/** Cette lecture-ci est-elle en diffusion ? Seul le relais de sa séance le dit — voir `stepAside`. */
export function castingNow(takeover: StableTakeover | null | undefined, session: unknown): boolean {
  return takeoverFor(takeover, session)?.cast === true;
}

export function castCarriedTo(
  takeover: StableTakeover | null | undefined,
  session: { itemId: string; openId?: number; resumeAt?: number }
): StableTakeover | null {
  const owner = takeover?.owner as { itemId?: string; openId?: number } | undefined;
  if (!takeover?.cast || !owner || owner === session) return null;
  if (owner.openId === undefined || owner.openId !== session.openId || owner.itemId === session.itemId) return null;
  // Un autre fichier : ni sa position ni sa piste ne valent ici. Depuis le début, piste par défaut.
  return { ...takeover, owner: session, resumeAt: session.resumeAt ?? 0, audioStreamIndex: undefined };
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
  /**
   * Rendre la main au lecteur natif, à la position où la diffusion s'est arrêtée.
   *
   * Réservé aux bascules de diffusion : une bascule d'échec qui reviendrait rejouerait son échec.
   * La garde est dans la fonction et non chez l'appelant — c'est la règle, elle ne doit pas
   * dépendre de qui appelle.
   */
  stepBack: (itemId: string, resumeAt: number, owner?: unknown, paused?: boolean) => void;
  /** Où reprendre quand le lecteur natif est repris après une diffusion — lire par `returningFor`. */
  returning: { itemId: string; resumeAt: number; owner?: unknown; paused?: boolean } | null;
}

/**
 * La position de retour de diffusion, si elle appartient bien à cette lecture-ci — sinon rien.
 *
 * La même règle que `takeoverFor`, et pour la même raison. Comparée au seul film, la position
 * rendue par une diffusion survivait à la lecture : rouvrir ce film plus tard, même par
 * « Recommencer », le rouvrait là où la diffusion s'était arrêtée — `returning` ne se vide qu'à la
 * bascule suivante (relu le 22/09/2026).
 */
export function returningFor(
  returning: { itemId: string; resumeAt: number; owner?: unknown; paused?: boolean } | null,
  session: { itemId: string }
): number | null {
  return returning && returning.itemId === session.itemId && returning.owner === session ? returning.resumeAt : null;
}

/**
 * Le lecteur natif repris après une diffusion doit-il attendre, en pause ?
 *
 * Oui quand la diffusion s'est arrêtée d'elle-même — télé éteinte, AirPlay coupé depuis le
 * téléphone : c'est ce que fait iOS de toute vidéo dont la route AirPlay tombe. Le film repartait
 * sur le téléphone, que personne ne regardait. Le 24/09/2026, un spectateur qui avait fini son
 * film sur la télé l'a vu relancé dans sa poche, puis a fermé l'application : un « blocage » au
 * journal d'une lecture que personne ne suivait. Non quand il a demandé lui-même à revenir sur le
 * téléphone : il veut continuer. Même règle d'appartenance que `returningFor`.
 */
export function returnsPaused(
  returning: { itemId: string; resumeAt: number; owner?: unknown; paused?: boolean } | null,
  session: { itemId: string }
): boolean {
  return returningFor(returning, session) !== null && returning?.paused === true;
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
/**
 * Où le lecteur natif reprend quand la diffusion rend la main.
 *
 * La position de la balise vidéo, si la diffusion a vraiment joué ; sinon la dernière position
 * connue, puis celle où la diffusion devait démarrer. 22/09/2026, iPhone : une diffusion abandonnée
 * pendant son chargement rendait `currentTime || 0`, le flux n'étant pas encore posé à sa reprise —
 * et le film repartait du début. Zéro seulement quand rien d'autre n'est connu.
 */
export function castHandBackPosition(elementSeconds: number, lastKnownSeconds: number, plannedSeconds: number | undefined): number {
  if (Number.isFinite(elementSeconds) && elementSeconds > 0.5) return elementSeconds;
  if (Number.isFinite(lastKnownSeconds) && lastKnownSeconds > 0) return lastKnownSeconds;
  return plannedSeconds !== undefined && Number.isFinite(plannedSeconds) ? plannedSeconds : 0;
}

export function useStableFallback(): StableFallback {
  const [handedOver, setHandedOver] = useState<string[]>([]);
  const [negotiating, setNegotiating] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [takeover, setTakeover] = useState<StableTakeover | null>(null);
  const [returning, setReturning] = useState<{ itemId: string; resumeAt: number; owner?: unknown; paused?: boolean } | null>(null);

  const stepAside = useCallback((itemId: string, why: string, resumeInto?: StableTakeover) => {
    // Diffuser n'est pas un échec : la bascule ne vaut que pour la lecture qui l'a demandée — le
    // relais, lié à sa séance par `owner`, la porte (`castingNow`). Rangé dans `handedOver`, le film
    // passait pour illisible jusqu'au rechargement de l'app dès qu'on fermait le lecteur pendant
    // une diffusion au lieu de la rendre : chaque relance partait au lecteur serveur
    // (*Ted Lasso*, 25/09/2026).
    if (resumeInto?.cast) {
      setReason(why);
      setTakeover(resumeInto);
      setReturning(null);
      setNegotiating(true);
      return;
    }
    setHandedOver((ids) => {
      // Already given up on: the word has been said and saying it twice would only interrupt
      // a player that is by now busy playing.
      if (ids.includes(itemId)) return ids;
      setReason(why);
      // Cleared as well as set: a later handover on another item must not inherit the position
      // and track of the previous one.
      setTakeover(resumeInto ?? null);
      // Une nouvelle bascule annule un retour en attente : on repart dans l'autre sens.
      setReturning(null);
      setNegotiating(true);
      return [...ids, itemId];
    });
  }, []);

  const stepBack = useCallback((itemId: string, resumeAt: number, owner?: unknown, paused = false) => {
    setTakeover((current) => {
      // Seule une bascule de diffusion revient. Vérifié ici plutôt que chez l'appelant : c'est la
      // règle elle-même, et une règle qui dépend de qui l'invoque n'en est pas une.
      if (!current?.cast) return current;
      setHandedOver((ids) => ids.filter((id) => id !== itemId));
      setReturning({ itemId, resumeAt, owner, ...(paused ? { paused: true } : {}) });
      return null;
    });
  }, []);

  useEffect(() => {
    if (!negotiating) return;
    const id = setTimeout(() => setNegotiating(false), NEGOTIATING_MS);
    return () => clearTimeout(id);
  }, [negotiating]);

  return { handedOver, negotiating, reason, takeover, stepAside, stepBack, returning };
}
