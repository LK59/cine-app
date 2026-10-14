// Pulls encoded samples out of a Matroska file's clusters, in file order.
//
// A pull model rather than a push one: the player asks for the next sample when its decoder has
// room, which is what keeps memory bounded on a 40 GB file. Nothing is read ahead beyond the
// cluster currently being decoded.

import type { ByteSource } from "./byteSource";
import { forEachChild, readElementHeader, readUint, UNREADABLE } from "./ebml";
import { ID } from "./matroskaIds";
import { parseBlock, type MatroskaFile, type MediaSample } from "./matroska";
import { UnreadableZone } from "./unreadableZone";

export interface SampleReaderOptions {
  /**
   * `"throw"` : une zone illisible lève `UnreadableZone` au lieu d'être passée en silence
   * (DECISIONS.md §93). Seul le remultiplexeur la demande, pour son lecteur principal ; tout autre
   * lecteur — transcodeurs audio, `completeParameterSets`, la reprise instantanée, les répliques —
   * garde le comportement d'avant, à l'identique.
   *
   * Une zone, c'est un en-tête dont le premier octet n'a pas de bit de marque (`UNREADABLE` : lu
   * avec une fenêtre complète, donc ni une lecture courte ni la fin du fichier), ou un bloc dont le
   * numéro de piste est dans ce cas — **là où le fichier dit qu'il reste du film** : dans une grappe
   * de taille connue (ses octets sont déclarés), ou, au niveau des grappes, avant un point d'index
   * (ou, sans index, dans un segment de taille déclarée). Des octets en trop après la dernière
   * grappe d'un fichier sain ne sont donc pas une zone ; un enfant qui dépasse son parent (un muxer
   * fautif) non plus, ni la durée annoncée.
   */
  unreadable?: "throw";
}

/** The segment's own children: none of them can appear inside a cluster. */
const TOP_LEVEL = new Set<number>([ID.Cluster, ID.Cues, ID.SeekHead, ID.Info, ID.Tracks, 0x1254c367 /* Tags */, 0x1043a770 /* Chapters */, 0x1941a469 /* Attachments */]);

export class SampleReader {
  private cursor: number;
  private queue: MediaSample[] = [];
  private finished = false;
  /** Le début de la dernière grappe dont l'horodatage a été lu depuis la dernière reprise (µs). */
  private lastClusterUs: number | null = null;
  /** Le dernier instant lu depuis la dernière reprise — grappe ou échantillon (µs). */
  private lastTimeUs: number | null = null;

  constructor(
    private readonly source: ByteSource,
    private readonly file: MatroskaFile,
    startOffset: number,
    private readonly options: SampleReaderOptions = {}
  ) {
    this.cursor = startOffset;
  }

  /** Restarts reading at a cluster boundary — the offset comes from the cue index. */
  seekTo(offset: number): void {
    this.cursor = offset;
    this.queue = [];
    this.finished = false;
    this.lastClusterUs = null;
    this.lastTimeUs = null;
  }

  get exhausted(): boolean {
    return this.finished && this.queue.length === 0;
  }

  async next(): Promise<MediaSample | null> {
    while (this.queue.length === 0) {
      if (this.finished) return null;
      await this.readOneCluster();
    }
    return this.queue.shift() ?? null;
  }

  private async readOneCluster(): Promise<void> {
    if (this.cursor >= this.file.segmentEnd) {
      this.finished = true;
      return;
    }

    const element = await readElementHeader(this.source, this.cursor);
    if (element === UNREADABLE) {
      // Un en-tête de grappe écrasé : la lecture s'arrêtait ici comme à la fin du fichier, et le
      // film « finissait » au milieu (§93). Ce qui précède a pu être touché aussi — la grappe
      // d'avant n'est sûre que jusqu'à son début.
      if (this.strict && this.filmBeyond(this.cursor)) throw this.zone(this.cursor, this.lastClusterUs);
      this.finished = true;
      return;
    }
    if (!element) {
      this.finished = true;
      return;
    }

    // Anything that isn't a cluster at this level (Tags, Chapters, a second SeekHead placed
    // after the media) is stepped over rather than treated as an error.
    if (element.id !== ID.Cluster) {
      if (element.size === null) {
        this.finished = true;
        return;
      }
      this.cursor = element.offset + element.size;
      return;
    }

    // An unknown-size cluster runs until the next cluster starts; capping at the segment end is
    // the safe reading, and the walk below stops at the first element that belongs to the
    // segment rather than to a cluster.
    const end = element.size === null ? this.file.segmentEnd : Math.min(element.offset + element.size, this.file.segmentEnd);
    let clusterTime = 0;
    /**
     * Where the next top-level element starts, when an unknown-size cluster ran into it.
     *
     * The walk used to read the next cluster as one more child of this one — an unknown element,
     * stepped over whole — and every cluster after it the same way, then jump to the segment's
     * end: a file muxed live (unknown sizes everywhere) played its first cluster and then
     * nothing (found on 23/09/2026).
     */
    let nextTopLevel: number | null = null;
    /** La grappe d'avant : sûre jusqu'à son début si celle-ci n'a pas d'horodatage lisible. */
    const previousClusterUs = this.lastClusterUs;
    let thisClusterUs: number | null = null;
    // Un en-tête illisible dans cette grappe : levé en mode strict, là où ses octets sont déclarés
    // (taille connue), ou, pour une grappe de taille inconnue, s'il reste du film plus loin.
    const unreadable = this.strict
      ? (offset: number) => {
          if (element.size !== null || this.filmBeyond(offset)) throw this.zone(offset, thisClusterUs ?? previousClusterUs);
        }
      : undefined;
    /** Un bloc lu entier dont le numéro de piste n'a pas de bit de marque : sa grappe est touchée (§93). */
    const checkBlock = (data: Uint8Array, size: number, at: number) => {
      if (unreadable && data.length === size && data.length > 0 && data[0] === 0) unreadable(at);
    };

    await forEachChild(this.source, element.offset, end, async (child) => {
      if (element.size === null && TOP_LEVEL.has(child.id)) {
        nextTopLevel = child.offset - child.headerSize;
        return "stop";
      }
      switch (child.id) {
        case ID.Timestamp:
          clusterTime = readUint(await this.source.read(child.offset, child.size ?? 0));
          if (this.strict) {
            thisClusterUs = Math.round((clusterTime * this.file.timestampScaleNs) / 1000);
            this.lastClusterUs = thisClusterUs;
            this.noteTime(thisClusterUs);
          }
          return "continue";

        case ID.SimpleBlock: {
          if (child.size === null) return "stop";
          const data = await this.source.read(child.offset, child.size);
          checkBlock(data, child.size, child.offset);
          const samples = parseBlock(data, clusterTime, this.file.timestampScaleNs, true, false);
          if (this.strict) for (const sample of samples) this.noteTime(sample.timestampUs);
          this.queue.push(...samples);
          return "continue";
        }

        case ID.BlockGroup: {
          if (child.size === null) return "stop";
          let block: Uint8Array | null = null;
          let durationTicks: number | null = null;
          // A BlockGroup with no ReferenceBlock is a keyframe — that absence is the only signal,
          // since a plain Block has no flag of its own.
          let hasReference = false;
          await forEachChild(
            this.source,
            child.offset,
            child.offset + child.size,
            async (g) => {
              if (g.id === ID.Block && g.size !== null) {
                block = new Uint8Array(await this.source.read(g.offset, g.size));
                checkBlock(block, g.size, g.offset);
              }
              if (g.id === ID.ReferenceBlock) hasReference = true;
              if (g.id === ID.BlockDuration && g.size !== null) durationTicks = readUint(await this.source.read(g.offset, g.size));
              return "continue";
            },
            // Un groupe a sa taille : ses octets sont déclarés, un en-tête illisible y est une zone.
            unreadable
          );
          if (block) {
            const usPerTick = this.file.timestampScaleNs / 1000;
            const samples = parseBlock(block, clusterTime, this.file.timestampScaleNs, false, !hasReference);
            for (const sample of samples) {
              if (durationTicks !== null) sample.durationUs = Math.round(durationTicks * usPerTick);
              if (this.strict) this.noteTime(sample.timestampUs);
            }
            this.queue.push(...samples);
          }
          return "continue";
        }
      }
      return "continue";
    }, unreadable);

    this.cursor = element.size !== null ? element.offset + element.size : (nextTopLevel ?? this.file.segmentEnd);
  }

  private get strict(): boolean {
    return this.options.unreadable === "throw";
  }

  private noteTime(us: number): void {
    if (this.lastTimeUs === null || us > this.lastTimeUs) this.lastTimeUs = us;
  }

  /**
   * Reste-t-il du film au-delà de cet octet ? Un point d'index qui y est ou plus loin le dit ; sans
   * index, seul un segment de taille déclarée (`segmentSized`) le dit. Sinon — des octets en trop
   * derrière la dernière grappe, un fichier enregistré en direct sans index — la lecture s'arrête
   * comme avant.
   */
  private filmBeyond(offset: number): boolean {
    if (offset >= this.file.segmentEnd) return false;
    if (this.file.cues.length > 0) return this.file.cues.some((cue) => cue.clusterOffset >= offset);
    return this.file.segmentSized === true;
  }

  /** L'instant d'index à cet octet ou avant (µs) — quand rien n'a encore été lu depuis la reprise. */
  private cueTimeBefore(offset: number): number | null {
    let best: number | null = null;
    for (const cue of this.file.cues) if (cue.clusterOffset <= offset && (best === null || cue.timeUs > best)) best = cue.timeUs;
    return best;
  }

  private zone(offset: number, safeUs: number | null): UnreadableZone {
    const fallback = this.cueTimeBefore(offset) ?? 0;
    const safe = safeUs ?? fallback;
    const seen = Math.max(this.lastTimeUs ?? fallback, safe);
    return new UnreadableZone(offset, seen / 1e6, safe / 1e6);
  }
}
