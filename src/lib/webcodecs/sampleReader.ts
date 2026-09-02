// Pulls encoded samples out of a Matroska file's clusters, in file order.
//
// A pull model rather than a push one: the player asks for the next sample when its decoder has
// room, which is what keeps memory bounded on a 40 GB file. Nothing is read ahead beyond the
// cluster currently being decoded.

import type { ByteSource } from "./byteSource";
import { forEachChild, readElementAt, readUint } from "./ebml";
import { ID } from "./matroskaIds";
import { parseBlock, type MatroskaFile, type MediaSample } from "./matroska";

export class SampleReader {
  private cursor: number;
  private queue: MediaSample[] = [];
  private finished = false;

  constructor(
    private readonly source: ByteSource,
    private readonly file: MatroskaFile,
    startOffset: number
  ) {
    this.cursor = startOffset;
  }

  /** Restarts reading at a cluster boundary — the offset comes from the cue index. */
  seekTo(offset: number): void {
    this.cursor = offset;
    this.queue = [];
    this.finished = false;
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

    const element = await readElementAt(this.source, this.cursor);
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
    // the safe reading, and the walk below stops on its own at the first child that doesn't fit.
    const end = element.size === null ? this.file.segmentEnd : Math.min(element.offset + element.size, this.file.segmentEnd);
    let clusterTime = 0;

    await forEachChild(this.source, element.offset, end, async (child) => {
      switch (child.id) {
        case ID.Timestamp:
          clusterTime = readUint(await this.source.read(child.offset, child.size ?? 0));
          return "continue";

        case ID.SimpleBlock: {
          if (child.size === null) return "stop";
          const data = await this.source.read(child.offset, child.size);
          this.queue.push(...parseBlock(data, clusterTime, this.file.timestampScaleNs, true, false));
          return "continue";
        }

        case ID.BlockGroup: {
          if (child.size === null) return "stop";
          let block: Uint8Array | null = null;
          let durationTicks: number | null = null;
          // A BlockGroup with no ReferenceBlock is a keyframe — that absence is the only signal,
          // since a plain Block has no flag of its own.
          let hasReference = false;
          await forEachChild(this.source, child.offset, child.offset + child.size, async (g) => {
            if (g.id === ID.Block && g.size !== null) block = new Uint8Array(await this.source.read(g.offset, g.size));
            if (g.id === ID.ReferenceBlock) hasReference = true;
            if (g.id === ID.BlockDuration && g.size !== null) durationTicks = readUint(await this.source.read(g.offset, g.size));
            return "continue";
          });
          if (block) {
            const usPerTick = this.file.timestampScaleNs / 1000;
            const samples = parseBlock(block, clusterTime, this.file.timestampScaleNs, false, !hasReference);
            for (const sample of samples) {
              if (durationTicks !== null) sample.durationUs = Math.round(durationTicks * usPerTick);
            }
            this.queue.push(...samples);
          }
          return "continue";
        }
      }
      return "continue";
    });

    this.cursor = element.size === null ? this.file.segmentEnd : element.offset + element.size;
  }
}
