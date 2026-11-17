/**
 * Les répliques d'une piste `<track>` du navigateur, lues par la page qui les dessine elle-même — Lumen serveur
 * (DECISIONS.md §190) : la piste en `hidden`, le navigateur la charge sans rien dessiner, et la ligne passe par le
 * calque de sous-titres (`SubtitleLayer`), comme celle du lecteur natif.
 *
 * Pourquoi pas `activeCues`, comme `useServerDualSubtitles` : le décalage (±0,5 s) est appliqué par l'hôte à la
 * recherche (`cueLookupTime`, comme le lecteur natif), sans toucher aux répliques ; `activeCues` ne connaît que
 * l'instant de l'élément. On cherche donc la réplique à un instant donné, dans les répliques de la piste.
 *
 * Le nettoyage (`stripSubtitleMarkup`, puis `trim`) est celui des deux sous-titres du lecteur serveur, et la
 * recherche celle des sous-titres tenus en mémoire (`cueTextAt`, chevauchements compris) : aucune règle de plus.
 */
import { cueTextAt } from "@/lib/webcodecs/externalSubtitles";
import { stripSubtitleMarkup, type SubtitleCue } from "@/lib/webcodecs/subtitleMarkup";

/**
 * Les répliques nettoyées et triées, gardées par piste tant que sa liste ne change pas : une piste se charge en
 * arrière-plan (la liste grandit d'un coup), et une lecture quatre fois par seconde ne doit pas tout refaire.
 */
const prepared = new WeakMap<TextTrack, { length: number; firstStart: number; lastEnd: number; cues: SubtitleCue[] }>();

/** Les répliques d'une piste, nettoyées, triées par début — vides tant que le navigateur ne l'a pas chargée. */
export function textTrackCues(track: TextTrack | null | undefined): readonly SubtitleCue[] {
  const list = track?.cues;
  if (!track || !list || list.length === 0) return [];
  const firstStart = list[0].startTime;
  const lastEnd = list[list.length - 1].endTime;
  const kept = prepared.get(track);
  // Le nombre et les deux bornes, pas l'objet de la liste (un moteur peut en rendre un neuf à chaque lecture) : une
  // piste qui finit de se charger grandit, des répliques déplacées sur place (`PlayerControls.shiftCues`, pour une
  // piste dont l'hôte ne tiendrait pas le décalage) changent de bornes.
  if (kept && kept.length === list.length && kept.firstStart === firstStart && kept.lastEnd === lastEnd) return kept.cues;
  const cues: SubtitleCue[] = [];
  for (let i = 0; i < list.length; i++) {
    const cue = list[i] as TextTrackCue & { text?: string };
    const text = stripSubtitleMarkup(cue.text ?? "").trim();
    if (text) cues.push({ startSeconds: cue.startTime, endSeconds: cue.endTime, text });
  }
  cues.sort((a, b) => a.startSeconds - b.startSeconds);
  prepared.set(track, { length: list.length, firstStart, lastEnd, cues });
  return cues;
}

/** La ligne à écrire à l'instant `seconds` (sur l'horloge de la piste), ou `null` — la recherche de `cueTextAt`. */
export function textTrackTextAt(cues: readonly SubtitleCue[], seconds: number): string | null {
  return cueTextAt(cues, seconds);
}

/**
 * Le prochain instant (sur l'horloge de la piste) où la ligne peut changer après `seconds` : un début à venir, ou la
 * fin d'une réplique à l'écran. Sert à relire juste à temps quand le décalage rend `cuechange` muet — l'élément ne
 * l'émet qu'aux bornes non décalées, et `timeupdate` ne vient que quatre fois par seconde.
 */
export function nextCueChange(cues: readonly SubtitleCue[], seconds: number): number | null {
  let next = Infinity;
  for (const cue of cues) {
    if (cue.startSeconds > seconds) {
      if (cue.startSeconds < next) next = cue.startSeconds;
      // Triées par début : aucune réplique plus loin ne commence plus tôt, mais une fin plus proche reste possible
      // parmi celles déjà vues — elles le sont toutes.
      break;
    }
    if (cue.endSeconds >= seconds && cue.endSeconds < next) next = cue.endSeconds;
  }
  return Number.isFinite(next) ? next : null;
}
