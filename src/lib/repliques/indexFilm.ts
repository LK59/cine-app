import path from "node:path";
import { FileByteSource, SCAN_CHUNK, TARGETED_CHUNK, type ReadGate } from "./fileSource";
import { bestTextTrack, openMatroskaText, readTextTracks, type MatroskaText } from "./mkvText";
import { bestSidecar, readSidecar, type CueLine, type Sidecar } from "./sidecar";
import { normalizedText } from "./text";
import type { LineRow } from "./store";

/**
 * Les répliques d'un film, dans les langues voulues (DECISIONS.md §88). Par langue, dans l'ordre :
 *
 * 1. un fichier **posé à côté** dans cette langue — gratuit, quelques dizaines de kilo-octets ;
 * 2. sinon la meilleure **piste texte intégrée**, lue par l'index (`mkvText.ts`) ;
 * 3. sinon, pour une piste sans index, le fichier **lu en entier** en flux.
 *
 * Une langue qui n'a ni fichier ni piste texte complète n'apporte rien (les pistes image — PGS,
 * VobSub — sont ignorées : il faudrait de la reconnaissance de caractères). Un film peut ainsi être
 * indexé en anglais seulement, ou pas du tout : c'est un état (`empty`), pas une erreur.
 */

export interface FilmToIndex {
  itemId: string;
  radarrId: number;
  title: string;
  /** Le fichier vidéo, vu du conteneur. */
  file: string;
  languages: string[];
  sidecars: Sidecar[];
}

export interface LanguageSource {
  lang: string;
  kind: "sidecar" | "cues" | "scan";
  /** Le fichier posé à côté (son nom seul), ou la piste intégrée. */
  file?: string;
  track?: number;
  codec?: string;
  lines: number;
}

export interface FilmIndexResult {
  rows: LineRow[];
  sources: LanguageSource[];
  bytesRead: number;
  reads: number;
}

/** Une même réplique écrite deux fois (couches ASS, bloc dupliqué) n'est gardée qu'une fois. */
function dedupe(lines: CueLine[]): CueLine[] {
  const seen = new Set<string>();
  return lines.filter((l) => {
    const key = `${l.startMs}:${l.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function indexFilm(film: FilmToIndex, gate?: ReadGate): Promise<FilmIndexResult> {
  const sources: LanguageSource[] = [];
  const rows: LineRow[] = [];
  let bytesRead = 0;
  let reads = 0;
  // La normalisation de quelques milliers de lignes tient la boucle une vingtaine de millisecondes :
  // elle rend la main toutes les 500 lignes.
  const push = async (lang: string, lines: CueLine[]) => {
    let n = 0;
    for (const line of dedupe(lines)) {
      if (++n % 500 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      const norm = normalizedText(line.text);
      if (!norm) continue;
      rows.push({ itemId: film.itemId, radarrId: film.radarrId, lang, startMs: Math.max(0, line.startMs), endMs: Math.max(line.startMs, line.endMs), text: line.text, norm });
    }
  };

  // 1. Les fichiers posés à côté.
  const missing: string[] = [];
  for (const lang of film.languages) {
    const sidecar = bestSidecar(film.sidecars, lang);
    if (!sidecar) {
      missing.push(lang);
      continue;
    }
    const { lines, bytes } = await readSidecar(sidecar, gate);
    bytesRead += bytes;
    reads++;
    if (lines.length === 0) {
      missing.push(lang);
      continue;
    }
    await push(lang, lines);
    sources.push({ lang, kind: "sidecar", file: path.basename(sidecar.file), lines: lines.length });
  }

  // 2 et 3. Les pistes intégrées d'un Matroska — un MP4 n'a ici que ses fichiers posés à côté.
  const isMatroska = /\.(mkv|mka|webm|mk3d)$/i.test(film.file);
  if (missing.length > 0 && isMatroska) {
    const source = await FileByteSource.open(film.file, { chunkBytes: TARGETED_CHUNK, maxChunks: 2048, gate });
    let scanSource: FileByteSource | null = null;
    try {
      const text: MatroskaText = await openMatroskaText(source);
      const chosen = new Map<number, string>();
      for (const lang of missing) {
        const track = bestTextTrack(text.tracks, lang);
        if (track) chosen.set(track.number, lang);
      }
      if (chosen.size > 0) {
        const result = await readTextTracks(source, text, [...chosen.keys()], async () => {
          scanSource = await FileByteSource.open(film.file, { chunkBytes: SCAN_CHUNK, maxChunks: 4, gate });
          return scanSource;
        });
        for (const [number, lang] of chosen) {
          const lines = result.lines.get(number) ?? [];
          if (lines.length === 0) continue;
          await push(lang, lines);
          const track = text.tracks.find((t) => t.number === number)!;
          sources.push({ lang, kind: result.scanned.includes(number) ? "scan" : "cues", track: number, codec: track.codecId, lines: lines.length });
        }
      }
    } finally {
      bytesRead += source.bytesRead + ((scanSource as FileByteSource | null)?.bytesRead ?? 0);
      reads += source.reads + ((scanSource as FileByteSource | null)?.reads ?? 0);
      source.close();
    }
  }

  return { rows, sources, bytesRead, reads };
}
