// « Qui parle » côté « Jusqu'ici » et questions (10.30, DECISIONS.md §139) — des règles pures, sans réseau.
//
// Le service `laterna-xray` rend des segments de parole (`/voices`), chacun avec sa voix et, quand il l'a
// nommée avec assez de confiance, la personne de la distribution. Laterna aligne lui-même ses répliques sur
// ces segments, **par les temps** : n'importe quelle langue de sous-titres convient. Une réplique reçoit
// « Nom : » seulement si tout tient (consigne du propriétaire, 09/11/2026) :
// - l'analyse de l'élément est **complète** — jamais un nom provisoire, pendant l'analyse rien ne change
//   (`speakerSegments` rend `null`) ;
// - ce n'est pas une réplique à deux voix (un tiret en début de ligne après la première, `twoSpeakers`) ;
// - une **même voix nommée** couvre au moins 60 % de la réplique (`SPEAKER_COVER`), et c'est la voix qui
//   en couvre le plus ;
// - cette voix est nommée avec une confiance d'au moins `SPEAKER_MIN_CONFIDENCE` (le service : deux avis de
//   regroupement sur trois au moins, la voix ressemblant à celle de la personne), et sans désaccord entre la
//   mémoire de la série et les visages de l'épisode (`conflict` : le service la laisse déjà sans nom).
// Le nom affiché suit la règle d'aujourd'hui : celui que « À l'écran » écrit (le personnage, sinon l'acteur,
// `sofarScenes`) ; le modèle le rapproche ensuite du nom que les répliques emploient (consigne).

import type { Cue } from "@/lib/recap/core";

/** La part de la réplique qu'une même voix nommée doit couvrir. */
export const SPEAKER_COVER = 0.6;
/** La confiance du service en deçà de laquelle une voix nommée ne l'est pas pour nous. */
export const SPEAKER_MIN_CONFIDENCE = 0.6;
/** Les sous-titres sont souvent décalés d'un rien sur la voix : la réplique est élargie de chaque côté. */
export const SPEAKER_PAD_S = 0.15;
/** Une réplique sans fin connue : sa durée supposée. */
const DEFAULT_CUE_S = 2;

export interface SpeakerSegment {
  start: number;
  end: number;
  voiceId: number;
  /** Le nom à écrire, `null` : voix sans nom (ou nom refusé). */
  name: string | null;
  confidence: number;
  conflict?: boolean;
}

/**
 * Le nom de qui dit cette réplique, ou `null`. `next` : le début de la réplique suivante, pour borner une
 * réplique sans fin connue.
 */
export function speakerOf(cue: Pick<Cue, "startS" | "atS" | "endS" | "twoSpeakers">, segments: readonly SpeakerSegment[], next?: number): string | null {
  if (cue.twoSpeakers) return null;
  const start = cue.atS ?? cue.startS;
  const end = cue.endS && cue.endS > start ? cue.endS : Math.min(start + DEFAULT_CUE_S, next && next > start ? next : Infinity);
  const dur = Math.max(end - start, 0.2);
  const s = start - SPEAKER_PAD_S;
  const e = end + SPEAKER_PAD_S;
  const by = new Map<string, { overlap: number; name: string | null }>();
  for (const g of segments) {
    if (g.end <= s) continue;
    if (g.start >= e) break;
    const ov = Math.min(e, g.end) - Math.max(s, g.start);
    if (ov <= 0) continue;
    const named = g.name && !g.conflict && g.confidence >= SPEAKER_MIN_CONFIDENCE ? g.name : null;
    // Une voix nommée compte par son nom (deux voix d'une même personne s'additionnent) ; une voix sans
    // nom, par elle-même — elle peut être quelqu'un d'autre.
    const key = named ? `n:${named}` : `v:${g.voiceId}`;
    const cur = by.get(key) ?? { overlap: 0, name: named };
    cur.overlap += ov;
    by.set(key, cur);
  }
  let best: { overlap: number; name: string | null } | null = null;
  for (const v of by.values()) if (!best || v.overlap > best.overlap) best = v;
  if (!best || !best.name) return null;
  return Math.min(best.overlap, dur) / dur >= SPEAKER_COVER ? best.name : null;
}

/**
 * Les répliques avec, quand c'est sûr, le nom de qui parle (`speaker`). Sans segments (analyse absente ou
 * pas finie) : les répliques telles quelles — le comportement d'avant.
 */
export function withSpeakers<T extends Cue>(cues: readonly T[], segments: readonly SpeakerSegment[] | null | undefined): (T & { speaker?: string })[] {
  if (!segments?.length) return [...cues];
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  return cues.map((c, i) => {
    const who = speakerOf(c, sorted, cues[i + 1]?.atS ?? cues[i + 1]?.startS);
    return who ? { ...c, speaker: who } : c;
  });
}

/** Une réplique telle qu'elle part au modèle : « Nom : texte » quand on sait qui parle. */
export function cueLine(c: Cue & { speaker?: string }): string {
  return c.speaker ? `${c.speaker} : ${c.text}` : c.text;
}
