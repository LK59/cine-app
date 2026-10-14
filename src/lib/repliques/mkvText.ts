import type { ByteSource } from "@/lib/webcodecs/byteSource";
import { forEachChild, readElementAt, readElementId, readUint, readVarSize } from "@/lib/webcodecs/ebml";
import { parseBlock, type MatroskaFile, type MatroskaTrack } from "@/lib/webcodecs/matroska";
import { ID } from "@/lib/webcodecs/matroskaIds";
import { SampleReader } from "@/lib/webcodecs/sampleReader";
import { languageCode } from "./languages";
import { displayText } from "./text";
import type { CueLine } from "./sidecar";

/**
 * Les pistes de sous-titres texte d'un Matroska, lues **par l'index** (DECISIONS.md §88).
 *
 * Mesuré le 14/10/2026 sur 8 399 fichiers : 99,6 % de ceux qui ont des sous-titres texte indexent
 * **chaque réplique** dans leurs Cues — un `CueTrackPositions` par bloc de la piste texte, avec
 * `CueClusterPosition` et `CueRelativePosition` (et `CueDuration` le plus souvent). Une réplique se
 * lit donc d'un seul déplacement et d'une fenêtre de 4 Kio (`readIndexedBlock`) — sans lire les
 * gigaoctets d'image autour. Vérifié contre la lecture complète du même fichier (banc
 * `repliques-bench.spec.ts`, `REPLIQUES_BENCH_VERIFY`).
 *
 * Le reste — un fichier sans Cues pour sa piste texte (29 vieux fichiers ici) — est lu d'un bout à
 * l'autre en flux, par le `SampleReader` du lecteur, en ne gardant que les blocs des pistes voulues.
 *
 * Rien du lecteur n'est modifié : ses briques (`ebml`, `matroskaIds`, `parseBlock`, `SampleReader`)
 * sont réutilisées en lecture. L'en-tête est relu ici (`readHeader`) plutôt que par `parseMatroska` :
 * celui-ci lit tout l'index pour le lecteur, d'une chaîne de micro-tâches qui tenait la boucle ; et
 * l'index des répliques — que le lecteur n'a jamais eu besoin de garder (il ne lit que les positions
 * de grappe) — est lu ici avec ce qui lui manque, en rendant la main au fil de la lecture.
 */

/** Les codecs de sous-titres qui sont du texte. Les images (PGS, VobSub) sont ignorées. */
export const TEXT_CODECS = new Set(["S_TEXT/UTF8", "S_TEXT/ASCII", "S_TEXT/ASS", "S_TEXT/SSA", "S_TEXT/WEBVTT", "D_WEBVTT/SUBTITLES"]);

const CUE_DURATION = 0xb2;

export interface TextTrack {
  number: number;
  codecId: string;
  /** Deux lettres (`languageCode`), ou `null` si la langue n'est pas reconnue. */
  language: string | null;
  name: string | null;
  forced: boolean;
  hearingImpaired: boolean;
  /** Combien de répliques l'index désigne pour cette piste — 0 : pas d'index, lecture complète. */
  indexed: number;
}

/** Une entrée de l'index qui désigne un bloc d'une piste texte. */
interface TextCue {
  track: number;
  timeTicks: number;
  clusterOffset: number;
  relative: number | null;
  durationTicks: number | null;
}

export interface MatroskaText {
  file: MatroskaFile;
  tracks: TextTrack[];
  cues: TextCue[];
}

const FORCED_NAME = /\b(forced|forc[ée]s?|foreign|panneaux|signs?)\b/i;
const SDH_NAME = /\b(sdh|cc|malentendants?|hearing|hi)\b/i;

function describe(track: MatroskaTrack, indexed: number): TextTrack {
  const name = track.name;
  return {
    number: track.number,
    codecId: track.codecId,
    language: languageCode(track.language),
    name,
    forced: track.isForced || (!!name && FORCED_NAME.test(name)),
    hearingImpaired: track.isHearingImpaired || (!!name && SDH_NAME.test(name)),
    indexed,
  };
}

/**
 * Une plage du fichier gardée en mémoire, aux mêmes positions absolues — et qui **rend la main** à la
 * boucle d'événements toutes les 256 lectures.
 *
 * L'analyseur EBML attend chaque champ (`await`) ; servi depuis la mémoire, chaque attente se résout
 * aussitôt, et l'index d'un long film (des dizaines de milliers d'entrées) devenait une seule chaîne
 * de micro-tâches : 151 ms de boucle tenue au banc du 14/10/2026, en partie dans `parseMatroska`, qui
 * lit tout l'index pour le lecteur. D'où ce lecteur d'en-tête à part, qui ne lit que ce qu'il faut ici.
 */
class YieldingSlice implements ByteSource {
  private reads = 0;
  constructor(private readonly bytes: Uint8Array, private readonly base: number, readonly size: number) {}
  static async of(source: ByteSource, start: number, end: number): Promise<YieldingSlice> {
    return new YieldingSlice(await source.read(start, end - start), start, source.size);
  }
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (++this.reads % 256 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const from = Math.max(0, Math.min(offset - this.base, this.bytes.length));
    return this.bytes.subarray(from, Math.max(from, Math.min(offset - this.base + length, this.bytes.length)));
  }
  close(): void {}
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/\0+$/, "");

/** Une entrée de piste, ce qu'il en faut ici. Comme le lecteur : sans `Language`, la piste est anglaise. */
async function readTrackEntry(source: ByteSource, start: number, end: number): Promise<MatroskaTrack | null> {
  const track: MatroskaTrack = {
    number: 0,
    type: "other",
    codecId: "",
    codecPrivate: null,
    language: null,
    name: null,
    isDefault: false,
    isForced: false,
    isHearingImpaired: false,
    isEnabled: true,
    defaultDurationNs: null,
  };
  let declared = false;
  await forEachChild(source, start, end, async (el) => {
    if (el.size === null) return "continue";
    const value = () => source.read(el.offset, el.size!);
    switch (el.id) {
      case ID.TrackNumber:
        track.number = readUint(await value());
        break;
      case ID.TrackType: {
        const raw = readUint(await value());
        track.type = raw === 1 ? "video" : raw === 2 ? "audio" : raw === 17 ? "subtitle" : "other";
        break;
      }
      case ID.CodecID:
        track.codecId = text(await value());
        break;
      case ID.Language:
      case ID.LanguageBCP47: {
        const lang = text(await value());
        if (lang) {
          declared = true;
          // BCP 47 est plus précis quand les deux sont là ; l'un ou l'autre suffit ici (deux lettres).
          track.language = el.id === ID.LanguageBCP47 || !track.language ? lang : track.language;
        }
        break;
      }
      case ID.TrackName:
        track.name = text(await value());
        break;
      case ID.FlagDefault:
        track.isDefault = readUint(await value()) === 1;
        break;
      case ID.FlagForced:
        track.isForced = readUint(await value()) === 1;
        break;
      case ID.FlagHearingImpaired:
        track.isHearingImpaired = readUint(await value()) === 1;
        break;
    }
    return "continue";
  });
  if (!declared) track.language = "eng";
  return track.number > 0 ? track : null;
}

interface Header {
  file: MatroskaFile;
  cues: { offset: number; end: number } | null;
}

/** L'en-tête : l'échelle de temps, les pistes, où sont les Cues et où commence la première grappe. */
async function readHeader(source: ByteSource): Promise<Header> {
  const first = await readElementAt(source, 0);
  if (!first || first.id !== ID.EBML) throw new Error("Ce fichier n'est pas un conteneur Matroska.");
  let cursor = first.offset + (first.size ?? 0);
  let segment = await readElementAt(source, cursor);
  while (segment && segment.id !== ID.Segment && segment.size !== null) {
    cursor = segment.offset + segment.size;
    segment = await readElementAt(source, cursor);
  }
  if (!segment || segment.id !== ID.Segment) throw new Error("Segment Matroska introuvable.");
  const file: MatroskaFile = {
    timestampScaleNs: 1_000_000,
    durationSeconds: null,
    tracks: [],
    cues: [],
    segmentDataStart: segment.offset,
    segmentEnd: segment.size === null ? source.size : Math.min(segment.offset + segment.size, source.size),
    firstClusterOffset: null,
  };
  let cues: Header["cues"] = null;
  const seek = new Map<number, number>();
  const readTracks = async (offset: number, end: number) => {
    const slice = await YieldingSlice.of(source, offset, end);
    await forEachChild(slice, offset, end, async (entry) => {
      if (entry.id !== ID.TrackEntry || entry.size === null) return "continue";
      const track = await readTrackEntry(slice, entry.offset, entry.offset + entry.size);
      if (track) file.tracks.push(track);
      return "continue";
    });
  };
  await forEachChild(source, file.segmentDataStart, file.segmentEnd, async (el) => {
    if (el.id === ID.Cluster) {
      file.firstClusterOffset = el.offset - el.headerSize;
      return "stop";
    }
    if (el.size === null) return "continue";
    const end = el.offset + el.size;
    if (el.id === ID.SeekHead) {
      const head = await YieldingSlice.of(source, el.offset, end);
      await forEachChild(head, el.offset, end, async (entry) => {
        if (entry.id !== ID.Seek || entry.size === null) return "continue";
        let id = 0;
        let position = -1;
        await forEachChild(head, entry.offset, entry.offset + entry.size, async (s) => {
          if (s.size === null) return "continue";
          if (s.id === ID.SeekID) id = readUint(await head.read(s.offset, s.size));
          if (s.id === ID.SeekPosition) position = readUint(await head.read(s.offset, s.size));
          return "continue";
        });
        if (id && position >= 0) seek.set(id, file.segmentDataStart + position);
        return "continue";
      });
    } else if (el.id === ID.Info) {
      await forEachChild(source, el.offset, end, async (info) => {
        if (info.id === ID.TimestampScale && info.size !== null) file.timestampScaleNs = readUint(await source.read(info.offset, info.size)) || 1_000_000;
        return "continue";
      });
    } else if (el.id === ID.Tracks) {
      await readTracks(el.offset, end);
    } else if (el.id === ID.Cues) {
      cues = { offset: el.offset, end };
    }
    return "continue";
  });
  // Les pistes ou l'index rangés après les images : le SeekHead dit où.
  for (const [id, at] of [[ID.Tracks, seek.get(ID.Tracks)], [ID.Cues, seek.get(ID.Cues)]] as const) {
    if (at === undefined || at >= source.size) continue;
    if (id === ID.Tracks && file.tracks.length > 0) continue;
    if (id === ID.Cues && cues) continue;
    const el = await readElementAt(source, at);
    if (!el || el.id !== id || el.size === null) continue;
    if (id === ID.Tracks) await readTracks(el.offset, el.offset + el.size);
    else cues = { offset: el.offset, end: el.offset + el.size };
  }
  if (file.tracks.length === 0) throw new Error("Aucune piste lisible dans ce fichier.");
  return { file, cues };
}

/** Lit l'en-tête, les pistes texte et leur part de l'index. */
export async function openMatroskaText(source: ByteSource): Promise<MatroskaText> {
  const { file, cues: where } = await readHeader(source);
  const textTracks = file.tracks.filter((t) => t.type === "subtitle" && TEXT_CODECS.has(t.codecId));
  if (textTracks.length === 0) return { file, tracks: [], cues: [] };
  const wanted = new Set(textTracks.map((t) => t.number));
  const cues = where ? await readTextCues(source, file, where, wanted) : [];
  const counts = new Map<number, number>();
  for (const cue of cues) counts.set(cue.track, (counts.get(cue.track) ?? 0) + 1);
  return { file, tracks: textTracks.map((t) => describe(t, counts.get(t.number) ?? 0)), cues };
}

async function readTextCues(source: ByteSource, file: MatroskaFile, where: { offset: number; end: number }, wanted: Set<number>): Promise<TextCue[]> {
  const cues = await YieldingSlice.of(source, where.offset, where.end);
  const out: TextCue[] = [];
  const num = async (el: { offset: number; size: number | null }) => (el.size === null ? 0 : readUint(await cues.read(el.offset, el.size)));
  await forEachChild(cues, where.offset, where.end, async (point) => {
    if (point.id !== ID.CuePoint || point.size === null) return "continue";
    let time = -1;
    const positions: Omit<TextCue, "timeTicks">[] = [];
    await forEachChild(cues, point.offset, point.offset + point.size, async (c) => {
      if (c.id === ID.CueTime) time = await num(c);
      if (c.id === ID.CueTrackPositions && c.size !== null) {
        let track = -1;
        let cluster = -1;
        let relative: number | null = null;
        let duration: number | null = null;
        await forEachChild(cues, c.offset, c.offset + c.size, async (p) => {
          if (p.id === ID.CueTrack) track = await num(p);
          else if (p.id === ID.CueClusterPosition) cluster = await num(p);
          else if (p.id === ID.CueRelativePosition) relative = await num(p);
          else if (p.id === CUE_DURATION) duration = await num(p);
          return "continue";
        });
        if (wanted.has(track) && cluster >= 0) {
          positions.push({ track, clusterOffset: file.segmentDataStart + cluster, relative, durationTicks: duration });
        }
      }
      return "continue";
    });
    if (time >= 0) for (const p of positions) out.push({ ...p, timeTicks: time });
    return "continue";
  });
  await realign(source, file, out);
  return out;
}

/**
 * Un index décalé, recalé comme le lecteur le fait (`realignCues`) : certains multiplexeurs comptent
 * les positions depuis le mauvais point de départ. On vérifie qu'une grappe commence bien là où
 * l'index la place ; sinon on cherche le décalage qui l'y met, sur les quelques octets voisins.
 */
async function realign(source: ByteSource, file: MatroskaFile, cues: TextCue[]): Promise<void> {
  if (cues.length === 0) return;
  const probe = cues[Math.floor(cues.length / 2)].clusterOffset;
  if (await isClusterAt(source, probe)) return;
  for (const delta of [-file.segmentDataStart, file.segmentDataStart, -12, 12, -8, 8, -4, 4]) {
    if (await isClusterAt(source, probe + delta)) {
      for (const cue of cues) cue.clusterOffset += delta;
      return;
    }
  }
}

async function isClusterAt(source: ByteSource, offset: number): Promise<boolean> {
  if (offset < 0 || offset >= source.size) return false;
  const head = await source.read(offset, 4);
  return readElementId(head, 0)?.value === ID.Cluster;
}

/** Le bloc lu à un endroit précis : ses échantillons et la durée de son `BlockGroup`. */
interface ReadBlock {
  track: number;
  timeTicks: number;
  durationTicks: number | null;
  data: Uint8Array;
}

/** Ce qu'on lit d'un coup à l'endroit d'un bloc : une réplique tient largement dans quelques kilo-octets. */
const BLOCK_WINDOW = 4096;
/** Un bloc de sous-titre plus gros que ça n'en est pas un. */
const MAX_TEXT_BLOCK = 256 * 1024;

/**
 * Lit le bloc qu'une entrée de l'index désigne, **d'une seule lecture**.
 *
 * `CueRelativePosition` compte depuis le début des *données* de la grappe, juste après son
 * identifiant (4 octets) et sa taille (1 à 8 octets). Plutôt que lire l'en-tête de la grappe — un
 * second déplacement de tête, pour son seul horodatage —, on lit la fenêtre où le bloc peut
 * commencer et l'on essaie les huit largeurs possibles de la taille : la bonne est celle où l'on
 * trouve un bloc (`SimpleBlock` ou `BlockGroup`) **de la piste attendue**. L'instant de la réplique est
 * celui de l'index (`CueTime`), qui est exactement celui du bloc pour une piste de sous-titres.
 *
 * Le premier essai du 14/10/2026 lisait l'en-tête et le bloc d'un tenant quand ils étaient proches :
 * 762 Mo lus pour les 5 093 répliques des *Huit Salopards*. Une fenêtre de 4 Kio par réplique en lit
 * une vingtaine.
 *
 * `null` si rien ne correspond — l'appelant relit alors la piste en entier.
 */
async function readIndexedBlock(source: ByteSource, cue: TextCue): Promise<ReadBlock | null> {
  if (cue.relative === null) return null;
  const from = cue.clusterOffset + 4 + 1 + cue.relative;
  const window = await source.read(from, BLOCK_WINDOW + 8);
  for (let width = 0; width < 8; width++) {
    const id = readElementId(window, width);
    if (!id || (id.value !== ID.SimpleBlock && id.value !== ID.BlockGroup)) continue;
    const size = readVarSize(window, width + id.width);
    // Une taille absurde : ces octets n'étaient pas un en-tête de bloc (une réplique pèse quelques centaines d'octets).
    if (!size || size.value === null || size.value > MAX_TEXT_BLOCK) continue;
    const payloadAt = from + width + id.width + size.width;
    let data: Uint8Array | null = null;
    let durationTicks: number | null = null;
    if (id.value === ID.SimpleBlock) {
      data = await source.read(payloadAt, size.value);
    } else {
      await forEachChild(source, payloadAt, payloadAt + size.value, async (g) => {
        if (g.size === null) return "continue";
        if (g.id === ID.Block) data = new Uint8Array(await source.read(g.offset, g.size));
        if (g.id === ID.BlockDuration) durationTicks = readUint(await source.read(g.offset, g.size));
        return "continue";
      });
    }
    if (!data) continue;
    const block = data as Uint8Array;
    const header = readVarSize(block, 0);
    if (!header || header.value !== cue.track || block.length < header.width + 3) continue;
    return { track: cue.track, timeTicks: cue.timeTicks, durationTicks, data: block };
  }
  return null;
}

function textOf(payload: Uint8Array, codecId: string): string {
  return displayText(new TextDecoder("utf-8").decode(payload), codecId);
}

/** Les fins manquantes : la réplique suivante, bornée — une réplique sans durée ne couvre pas le film. */
function closeEnds(lines: (CueLine & { open?: boolean })[]): CueLine[] {
  lines.sort((a, b) => a.startMs - b.startMs);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.open) continue;
    const next = lines[i + 1]?.startMs;
    line.endMs = line.startMs + Math.max(1000, Math.min(next !== undefined ? next - line.startMs : 4000, 6000));
    delete line.open;
  }
  return lines;
}

export interface TrackReadResult {
  lines: Map<number, CueLine[]>;
  /** Les pistes lues en entier faute d'index (ou d'index utilisable). */
  scanned: number[];
}

/**
 * Les répliques des pistes demandées. Par l'index d'abord, dans l'ordre du fichier ; une piste sans
 * index, ou dont un bloc n'est pas là où l'index le dit, est relue en entier par `scanSource`
 * (une seconde ouverture du fichier, en gros morceaux pour un parcours séquentiel).
 */
export async function readTextTracks(
  source: ByteSource,
  text: MatroskaText,
  trackNumbers: readonly number[],
  scanSource: () => Promise<ByteSource>,
): Promise<TrackReadResult> {
  const { file } = text;
  const ticksToMs = file.timestampScaleNs / 1e6;
  const tracks = new Map(text.tracks.map((t) => [t.number, t]));
  const lines = new Map<number, (CueLine & { open?: boolean })[]>(trackNumbers.map((n) => [n, []]));
  const needScan = new Set<number>(trackNumbers.filter((n) => (tracks.get(n)?.indexed ?? 0) === 0));

  // L'ordre du fichier : la tête avance dans un seul sens. Une même position citée deux fois n'est lue qu'une.
  const wanted = text.cues
    .filter((c) => lines.has(c.track) && !needScan.has(c.track))
    .sort((a, b) => a.clusterOffset - b.clusterOffset || (a.relative ?? 0) - (b.relative ?? 0));
  const seen = new Set<string>();
  const breathe = async (n: number) => {
    if (n % 200 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  let step = 0;
  for (const cue of wanted) {
    await breathe(++step);
    if (needScan.has(cue.track)) continue;
    const key = `${cue.track}:${cue.clusterOffset}:${cue.relative}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const block = await readIndexedBlock(source, cue);
    if (!block) {
      // L'index ne mène pas au bloc annoncé : cette piste sera lue en entier, ses lignes déjà prises jetées.
      needScan.add(cue.track);
      lines.set(cue.track, []);
      continue;
    }
    const track = tracks.get(cue.track)!;
    const samples = parseBlock(block.data, 0, file.timestampScaleNs, true, true);
    for (const sample of samples) {
      const body = textOf(sample.data, track.codecId);
      if (!body) continue;
      const startMs = Math.round(block.timeTicks * ticksToMs);
      const durationTicks = block.durationTicks ?? cue.durationTicks;
      const durationMs = durationTicks !== null ? Math.round(durationTicks * ticksToMs) : null;
      lines.get(cue.track)!.push(durationMs !== null ? { startMs, endMs: startMs + durationMs, text: body } : { startMs, endMs: startMs, text: body, open: true });
    }
  }

  if (needScan.size > 0) {
    const scan = await scanSource();
    try {
      const reader = new SampleReader(scan, file, file.firstClusterOffset ?? file.segmentDataStart);
      for (;;) {
        const sample = await reader.next();
        if (!sample) break;
        await breathe(++step);
        if (!needScan.has(sample.trackNumber)) continue;
        const track = tracks.get(sample.trackNumber)!;
        const body = textOf(sample.data, track.codecId);
        if (!body) continue;
        const startMs = Math.round(sample.timestampUs / 1000);
        lines
          .get(sample.trackNumber)!
          .push(sample.durationUs !== null ? { startMs, endMs: startMs + Math.round(sample.durationUs / 1000), text: body } : { startMs, endMs: startMs, text: body, open: true });
      }
    } finally {
      if (scan !== source) scan.close();
    }
  }

  const out = new Map<number, CueLine[]>();
  for (const [number, list] of lines) out.set(number, closeEnds(list));
  return { lines: out, scanned: [...needScan] };
}

/**
 * La meilleure piste d'une langue : complète (pas une piste forcée seule), ordinaire de préférence à
 * SDH — gardée si c'est la seule complète —, la plus fournie à égalité. Une piste qui ne porte pas
 * le drapeau « forcé » mais compte moins d'un quart des répliques de la plus fournie de sa langue est
 * traitée comme telle : c'est ce que sont, en pratique, ces pistes de panneaux non marquées.
 */
export function bestTextTrack(tracks: readonly TextTrack[], language: string): TextTrack | null {
  const same = tracks.filter((t) => t.language === language && !t.forced);
  if (same.length === 0) return null;
  const most = Math.max(...same.map((t) => t.indexed));
  const complete = most > 0 ? same.filter((t) => t.indexed === 0 || t.indexed >= most / 4) : same;
  complete.sort((a, b) => Number(a.hearingImpaired) - Number(b.hearingImpaired) || b.indexed - a.indexed || a.number - b.number);
  return complete[0] ?? null;
}
