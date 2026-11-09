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
// - une réplique **courte** (moins de `SPEAKER_SHORT_S`) n'est pas nommée quand le segment de la voix qui
//   la gagne couvre aussi la moitié d'une réplique voisine (`SPEAKER_NEIGHBOUR_COVER`) : c'est une réponse
//   brève avalée par le segment de l'autre (10.30.1).
// Le nom affiché suit la règle d'aujourd'hui : celui que « À l'écran » écrit (le personnage, sinon l'acteur,
// `sofarScenes`) ; le modèle le rapproche ensuite du nom que les répliques emploient (consigne).

import type { Cue } from "@/lib/recap/core";

/** La part de la réplique qu'une même voix nommée doit couvrir. */
export const SPEAKER_COVER = 0.6;
/** La confiance du service en deçà de laquelle une voix nommée ne l'est pas pour nous. */
export const SPEAKER_MIN_CONFIDENCE = 0.6;
/** Les sous-titres sont souvent décalés d'un rien sur la voix : la réplique est élargie de chaque côté. */
export const SPEAKER_PAD_S = 0.15;
/**
 * Une réplique plus courte (en secondes, sans l'élargissement) n'est nommée que si le segment qui la nomme ne
 * déborde pas sur une voisine (10.30.1, banc de bout en bout sur *Ted Lasso* S01E09, 09/11/2026). Les cinq
 * erreurs des 337 répliques nommées étaient des répliques d'une seconde — « Zut. », « Quand ? », « T'exagères. »,
 * « Quoi ? » — dites par l'autre au milieu d'un segment qui couvrait aussi la réplique d'avant ou d'après :
 * l'analyse des voix découpe la parole en tronçons de plus d'une seconde, et une réponse brève y disparaît.
 * Rejoué : 1,0 s laissait 3 erreurs sur 5 ; 1,1 s les retire toutes (et 11 justes), précision 100 %, couverture
 * 61,7 → 58,8 %. Sur les trois vérités de terrain (*Ted Lasso* S01E08, *MacGyver* S01E06, *Bullet Train*) :
 * précision 96,4 → 97,0 %, couverture 72,6 → 70,6 % ; 1,2 s et au-delà retirent plus de justes sans erreur de moins.
 */
export const SPEAKER_SHORT_S = 1.1;
/** La part d'une réplique voisine que ce même segment doit couvrir pour que la courte reste sans nom. */
export const SPEAKER_NEIGHBOUR_COVER = 0.5;
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

interface Span {
  start: number;
  end: number;
}

/** Le temps d'une réplique : son début, sa fin (ou, sans fin connue, deux secondes bornées par la suivante). */
function spanOf(cue: Pick<Cue, "startS" | "atS" | "endS">, next?: number): Span {
  const start = cue.atS ?? cue.startS;
  const end = cue.endS && cue.endS > start ? cue.endS : Math.min(start + DEFAULT_CUE_S, next && next > start ? next : Infinity);
  return { start, end };
}

/**
 * Le nom de qui dit cette réplique, ou `null`. `next` : le début de la réplique suivante, pour borner une
 * réplique sans fin connue. `neighbours` : le temps des répliques d'avant et d'après, pour la règle des
 * répliques courtes (`SPEAKER_SHORT_S`) — sans eux, elle ne s'applique pas.
 */
export function speakerOf(
  cue: Pick<Cue, "startS" | "atS" | "endS" | "twoSpeakers">,
  segments: readonly SpeakerSegment[],
  next?: number,
  neighbours?: readonly (Span | null | undefined)[],
): string | null {
  if (cue.twoSpeakers) return null;
  const { start, end } = spanOf(cue, next);
  const dur = Math.max(end - start, 0.2);
  const s = start - SPEAKER_PAD_S;
  const e = end + SPEAKER_PAD_S;
  const by = new Map<string, { overlap: number; name: string | null; segs: SpeakerSegment[] }>();
  for (const g of segments) {
    if (g.end <= s) continue;
    if (g.start >= e) break;
    const ov = Math.min(e, g.end) - Math.max(s, g.start);
    if (ov <= 0) continue;
    const named = g.name && !g.conflict && g.confidence >= SPEAKER_MIN_CONFIDENCE ? g.name : null;
    // Une voix nommée compte par son nom (deux voix d'une même personne s'additionnent) ; une voix sans
    // nom, par elle-même — elle peut être quelqu'un d'autre.
    const key = named ? `n:${named}` : `v:${g.voiceId}`;
    const cur = by.get(key) ?? { overlap: 0, name: named, segs: [] };
    cur.overlap += ov;
    cur.segs.push(g);
    by.set(key, cur);
  }
  let best: { overlap: number; name: string | null; segs: SpeakerSegment[] } | null = null;
  for (const v of by.values()) if (!best || v.overlap > best.overlap) best = v;
  if (!best || !best.name) return null;
  if (Math.min(best.overlap, dur) / dur < SPEAKER_COVER) return null;
  // Une réplique courte dont le segment gagnant couvre aussi une voisine : une réponse brève de l'autre,
  // avalée par ce segment (« Zut. » de Ted au milieu de Keeley) — sans nom plutôt qu'un nom faux.
  if (dur < SPEAKER_SHORT_S && neighbours) {
    for (const nb of neighbours) {
      if (!nb || !(nb.end > nb.start)) continue;
      for (const g of best.segs) {
        const ov = Math.min(nb.end, g.end) - Math.max(nb.start, g.start);
        if (ov > 0 && ov >= SPEAKER_NEIGHBOUR_COVER * (nb.end - nb.start)) return null;
      }
    }
  }
  return best.name;
}

/**
 * Les répliques avec, quand c'est sûr, le nom de qui parle (`speaker`). Sans segments (analyse absente ou
 * pas finie) : les répliques telles quelles — le comportement d'avant.
 */
export function withSpeakers<T extends Cue>(cues: readonly T[], segments: readonly SpeakerSegment[] | null | undefined): (T & { speaker?: string })[] {
  if (!segments?.length) return [...cues];
  const sorted = [...segments].sort((a, b) => a.start - b.start);
  const nextOf = (i: number) => cues[i + 1]?.atS ?? cues[i + 1]?.startS;
  const spans = cues.map((c, i) => spanOf(c, nextOf(i)));
  return cues.map((c, i) => {
    const who = speakerOf(c, sorted, nextOf(i), [spans[i - 1], spans[i + 1]]);
    return who ? { ...c, speaker: who } : c;
  });
}

/** Une réplique telle qu'elle part au modèle : « Nom : texte » quand on sait qui parle. */
export function cueLine(c: Cue & { speaker?: string }): string {
  return c.speaker ? `${c.speaker} : ${c.text}` : c.text;
}
