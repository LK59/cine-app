import { CHUNK_SIZE } from "@/lib/webcodecs/byteSource";
import type { CuePoint, MatroskaFile } from "@/lib/webcodecs/matroska";

/**
 * Ce que des morceaux gardés sur l'appareil couvrent, lu dans l'index du fichier — sans lire une
 * seule image (28/09/2026).
 *
 * Un point d'index donne, pour chaque image clé, son instant et l'endroit du fichier où son groupe
 * commence ; le groupe s'arrête où commence le suivant. Un groupe dont tous les morceaux sont là
 * est lisible depuis l'appareil. La réserve d'avance d'un titre se lit donc en parcourant l'index
 * depuis l'image clé qui précède la position : ce que les morceaux couvrent d'un seul tenant.
 *
 * Relire les images pour le savoir, comme le fait l'enregistrement d'une ouverture, coûterait de
 * lire et d'analyser jusqu'à un gigaoctet sur le fil principal. L'index le dit pour rien. Une
 * estimation : un MP4 dont le son serait rangé loin de l'image (rare), ou un index qui ment, feraient
 * lire quelques octets au réseau — ce que le lecteur fait de toute façon pour tout morceau absent.
 */

/** Les points d'index de l'image, dans l'ordre — ceux de toutes les pistes s'il n'y en a pas pour elle. */
export function videoCues(file: MatroskaFile): CuePoint[] {
  const video = file.tracks.find((track) => track.type === "video");
  const own = video ? file.cues.filter((cue) => cue.track === video.number) : [];
  return (own.length > 0 ? own : file.cues).slice().sort((a, b) => a.timeUs - b.timeUs);
}

/** Les morceaux d'un intervalle d'octets [from, to). */
export function chunksBetween(from: number, to: number): number[] {
  if (!(to > from)) return [];
  const out: number[] = [];
  for (let index = Math.floor(from / CHUNK_SIZE); index <= Math.floor((to - 1) / CHUNK_SIZE); index++) out.push(index);
  return out;
}

export interface Coverage {
  /** L'instant de l'image clé d'où la lecture reprendrait, en secondes. */
  coveredFrom: number;
  /** Jusqu'où la lecture irait sans le réseau, en secondes — `coveredFrom` si rien n'est couvert. */
  coveredTo: number;
  /** Les morceaux de ce passage, d'un seul tenant, dans l'ordre. */
  chunks: number[];
}

/**
 * Le passage couvert depuis l'image clé qui précède `startSeconds`, groupe par groupe, tant que
 * chaque morceau est présent et que `maxChunks` n'est pas dépassé.
 *
 * Un groupe à moitié présent arrête le passage : ce qui suit un trou n'est pas une avance, c'est une
 * île — elle ne sert que si l'on y saute.
 */
export function coverageFrom(file: MatroskaFile, startSeconds: number, has: (index: number) => boolean, maxChunks = Infinity): Coverage | null {
  const cues = videoCues(file);
  if (cues.length === 0) return null;
  const startUs = Math.max(0, startSeconds) * 1e6;
  let first = 0;
  for (let i = 0; i < cues.length; i++) {
    if (cues[i].timeUs <= startUs) first = i;
    else break;
  }
  const coveredFrom = cues[first].timeUs / 1e6;
  const chunks: number[] = [];
  const taken = new Set<number>();
  let coveredTo = coveredFrom;
  for (let i = first; i < cues.length; i++) {
    const end = i + 1 < cues.length ? cues[i + 1].clusterOffset : file.segmentEnd;
    const group = chunksBetween(cues[i].clusterOffset, end).filter((index) => !taken.has(index));
    if (!group.every(has) || chunks.length + group.length > maxChunks) break;
    for (const index of group) {
      taken.add(index);
      chunks.push(index);
    }
    coveredTo = i + 1 < cues.length ? cues[i + 1].timeUs / 1e6 : (file.durationSeconds ?? cues[i].timeUs / 1e6);
  }
  return { coveredFrom, coveredTo, chunks };
}

/**
 * Jusqu'où une reprise doit être couverte pour démarrer depuis l'appareil : le groupe qui contient la
 * position, et le suivant — « un segment de plus », pour que les premières secondes ne dépendent
 * pas du réseau. Au moins `minAheadSeconds` après la position.
 */
export function resumeEnd(file: MatroskaFile, startSeconds: number, minAheadSeconds: number): number {
  const cues = videoCues(file);
  const after = cues.filter((cue) => cue.timeUs / 1e6 > startSeconds);
  const second = after[1] ?? after[0];
  const end = second ? second.timeUs / 1e6 : (file.durationSeconds ?? startSeconds + minAheadSeconds);
  return Math.max(end, startSeconds + minAheadSeconds);
}
