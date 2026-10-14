import { describe, it, expect } from "vitest";
import { MemoryByteSource, type ByteSource } from "@/lib/webcodecs/byteSource";
import { parseMatroska, type MediaSample } from "@/lib/webcodecs/matroska";
import { SampleReader } from "@/lib/webcodecs/sampleReader";
import { forEachChild, readElementAt, readElementHeader, UNREADABLE } from "@/lib/webcodecs/ebml";
import { createSampleReader } from "@/lib/webcodecs/mediaFile";
import { Remuxer } from "@/lib/webcodecs/remuxer";
import {
  UnreadableZone,
  isUnreadableZone,
  isUnreadableZoneReason,
  unreadableZoneMessage,
  zoneSecondsOf,
} from "@/lib/webcodecs/unreadableZone";

// Une zone illisible dans un fichier (DECISIONS.md §93) : des Matroska fabriqués en mémoire, sains
// puis abîmés comme « Le Grinch » l'était — des zéros écrits par-dessus un en-tête de grappe, un
// en-tête de bloc, le numéro de piste d'un bloc, un bloc sur deux.

import { build, damaged, CLUSTER_MS, concat, el, idBytes, uint, vint } from "./helpers/zoneMatroska";

async function readAll(source: ByteSource, strict: boolean): Promise<{ samples: MediaSample[]; error: unknown }> {
  const file = await parseMatroska(source);
  const reader = new SampleReader(source, file, file.firstClusterOffset ?? file.segmentDataStart, strict ? { unreadable: "throw" } : {});
  const samples: MediaSample[] = [];
  try {
    for (;;) {
      const s = await reader.next();
      if (!s) break;
      samples.push(s);
    }
    return { samples, error: null };
  } catch (error) {
    return { samples, error };
  }
}

const describeSamples = (samples: MediaSample[]) => samples.map((s) => `${s.trackNumber}@${s.timestampUs}:${s.data.length}`);

/** Une source qui rend moins que demandé à partir d'un octet — ce qu'une lecture courte ferait. */
function shortReads(bytes: Uint8Array, from: number): ByteSource {
  const inner = new MemoryByteSource(bytes);
  return {
    size: bytes.length,
    read: async (offset, length) => {
      const data = await inner.read(offset, length);
      return offset >= from && data.length > 3 ? data.subarray(0, 3) : data;
    },
    close: () => {},
  };
}

describe("ebml — l'en-tête illisible", () => {
  it("dit UNREADABLE pour un octet sans bit de marque lu avec une fenêtre complète", async () => {
    const bytes = new Uint8Array(64).fill(0);
    expect(await readElementHeader(new MemoryByteSource(bytes), 10)).toBe(UNREADABLE);
    // La taille, aussi : un identifiant lisible suivi d'un octet nul.
    const sized = new Uint8Array(64).fill(0);
    sized[10] = 0xa3;
    expect(await readElementHeader(new MemoryByteSource(sized), 10)).toBe(UNREADABLE);
    // `readElementAt`, lui, ne change pas : null comme avant.
    expect(await readElementAt(new MemoryByteSource(bytes), 10)).toBeNull();
  });

  it("une lecture courte n'est pas une zone", async () => {
    const bytes = new Uint8Array(64).fill(0);
    expect(await readElementHeader(shortReads(bytes, 0), 10)).toBeNull();
  });

  it("la fin du fichier au milieu d'un en-tête n'est pas une zone, un zéro à la toute fin si", async () => {
    // 0x1A… veut quatre octets, il n'en reste que deux : tronqué, pas illisible.
    expect(await readElementHeader(new MemoryByteSource(new Uint8Array([0x1a, 0x45])), 0)).toBeNull();
    // Un seul octet restant, nul : la fenêtre est complète (tout ce qui reste), et il est illisible.
    expect(await readElementHeader(new MemoryByteSource(new Uint8Array([0xec, 0x80, 0x00])), 2)).toBe(UNREADABLE);
    expect(await readElementHeader(new MemoryByteSource(new Uint8Array(4)), 4)).toBeNull();
  });

  it("forEachChild prévient de l'enfant illisible et s'arrête ; sans rappel, rien ne change", async () => {
    const bytes = concat(el(0xe7, uint(5)), new Uint8Array(20));
    const seen: number[] = [];
    const unreadable: number[] = [];
    await forEachChild(new MemoryByteSource(bytes), 0, bytes.length, (e) => void seen.push(e.id), (offset) => void unreadable.push(offset));
    expect(seen).toEqual([0xe7]);
    expect(unreadable).toEqual([3]);
    const silent: number[] = [];
    await forEachChild(new MemoryByteSource(bytes), 0, bytes.length, (e) => void silent.push(e.id));
    expect(silent).toEqual([0xe7]);
  });

  it("un enfant qui dépasse son parent reste un arrêt silencieux (muxer fautif), jamais une zone", async () => {
    const bytes = concat(el(0xe7, uint(5)), idBytes(0xa3), vint(5000), new Uint8Array(10).fill(7));
    const unreadable: number[] = [];
    await forEachChild(new MemoryByteSource(bytes), 0, bytes.length, () => undefined, (o) => void unreadable.push(o));
    expect(unreadable).toEqual([]);
  });
});

describe("SampleReader — zone illisible (§93)", () => {
  it("un fichier sain : le lecteur strict rend exactement les échantillons du lecteur d'avant", async () => {
    for (const options of [{}, { groups: true }, { cues: false }, { unknownSegment: true }]) {
      const { bytes } = build(options);
      const loose = await readAll(new MemoryByteSource(bytes), false);
      const strict = await readAll(new MemoryByteSource(bytes), true);
      expect(loose.error).toBeNull();
      expect(strict.error).toBeNull();
      expect(strict.samples.length).toBe(30);
      expect(describeSamples(strict.samples)).toEqual(describeSamples(loose.samples));
      expect(strict.samples.map((s) => Array.from(s.data))).toEqual(loose.samples.map((s) => Array.from(s.data)));
    }
  });

  it("des octets en trop après la dernière grappe (dans le segment) ne sont pas une zone", async () => {
    const { bytes } = build({ trailing: new Uint8Array(4096) });
    const strict = await readAll(new MemoryByteSource(bytes), true);
    expect(strict.error).toBeNull();
    expect(strict.samples.length).toBe(30);
  });

  it("zéros à cheval sur un en-tête de grappe : l'ancien lecteur finissait là, le strict lève la zone", async () => {
    const built = build();
    const bytes = damaged(built.bytes, [built.clusters[3] - 100, 200]);
    const loose = await readAll(new MemoryByteSource(bytes), false);
    expect(loose.error).toBeNull();
    // « Fin du fichier » à 6 s : la grappe 3 et la suite n'existent plus pour lui — et la dernière
    // image de la grappe 2, à moitié nulle, est partie telle quelle.
    expect(loose.samples.length).toBe(15);
    expect(loose.samples.every((s) => s.timestampUs < 3 * CLUSTER_MS * 1000)).toBe(true);
    const strict = await readAll(new MemoryByteSource(bytes), true);
    expect(isUnreadableZone(strict.error)).toBe(true);
    const zone = strict.error as UnreadableZone;
    expect(zone.byteOffset).toBe(built.clusters[3]);
    // La grappe 2 a pu être touchée (elle l'est) : sûr jusqu'à son début seulement.
    expect(zone.safeSeconds).toBe(4);
    expect(zone.message).toBe(unreadableZoneMessage(zone.seconds, zone.byteOffset));
  });

  it("zéros sur le seul en-tête d'une grappe : la zone est à son octet, sûre jusqu'au début de la grappe d'avant", async () => {
    const built = build();
    const bytes = damaged(built.bytes, [built.clusters[3], 12]);
    const strict = await readAll(new MemoryByteSource(bytes), true);
    const zone = strict.error as UnreadableZone;
    expect(isUnreadableZone(zone)).toBe(true);
    expect(zone.byteOffset).toBe(built.clusters[3]);
    expect(zone.safeSeconds).toBe(4);
    // Le dernier instant lu : le dernier bloc de la grappe 2 (4 s + 1,2 s).
    expect(zone.seconds).toBeCloseTo(5.2, 5);
    expect(zone.message).toBe("zone illisible dans le fichier vers 5,2 s (octet " + built.clusters[3] + ")");
  });

  it("zéros au milieu d'une grappe : l'ancien lecteur sautait à la suivante, le strict lève à l'en-tête du bloc", async () => {
    const built = build();
    const at = built.blocks[2][2];
    const bytes = damaged(built.bytes, [at, 20]);
    const loose = await readAll(new MemoryByteSource(bytes), false);
    expect(loose.error).toBeNull();
    // Le trou : la fin de la grappe 2 manque, la 3 revient.
    expect(loose.samples.some((s) => s.timestampUs === 6_000_000)).toBe(true);
    expect(loose.samples.length).toBeLessThan(30);
    const strict = await readAll(new MemoryByteSource(bytes), true);
    const zone = strict.error as UnreadableZone;
    expect(isUnreadableZone(zone)).toBe(true);
    expect(zone.byteOffset).toBe(at);
    expect(zone.safeSeconds).toBe(4);
  });

  it("le numéro de piste d'un bloc effacé (son en-tête intact) : le bloc ne part plus en silence", async () => {
    const built = build();
    const at = built.blocks[1][0];
    // L'élément SimpleBlock fait 1 octet d'identifiant + 2 de taille : le contenu commence à +3.
    const bytes = damaged(built.bytes, [at + 3, 1]);
    const loose = await readAll(new MemoryByteSource(bytes), false);
    expect(loose.error).toBeNull();
    expect(loose.samples.length).toBe(29);
    const strict = await readAll(new MemoryByteSource(bytes), true);
    expect(isUnreadableZone(strict.error)).toBe(true);
    // L'octet nul lui-même : le début du contenu du bloc.
    expect((strict.error as UnreadableZone).byteOffset).toBe(at + 3);
  });

  it("dans un groupe de blocs aussi", async () => {
    const built = build({ groups: true });
    const at = built.blocks[4][1];
    const bytes = damaged(built.bytes, [at + 3, 8]);
    const strict = await readAll(new MemoryByteSource(bytes), true);
    expect(isUnreadableZone(strict.error)).toBe(true);
  });

  it("un bloc sur deux : la première zone lève ; repris au point d'index suivant, la suivante lève à son tour", async () => {
    const built = build();
    const bytes = damaged(built.bytes, [built.blocks[1][1], 10], [built.blocks[3][1], 10], [built.blocks[5][1], 10]);
    const source = new MemoryByteSource(bytes);
    const file = await parseMatroska(source);
    const reader = new SampleReader(source, file, file.firstClusterOffset!, { unreadable: "throw" });
    const zones: number[] = [];
    for (let guard = 0; guard < 100; guard++) {
      try {
        const s = await reader.next();
        if (!s) break;
      } catch (error) {
        expect(isUnreadableZone(error)).toBe(true);
        const zone = error as UnreadableZone;
        zones.push(zone.byteOffset);
        const next = file.cues.find((c) => c.clusterOffset > zone.byteOffset);
        if (!next) break;
        reader.seekTo(next.clusterOffset);
      }
    }
    expect(zones).toEqual([built.blocks[1][1], built.blocks[3][1], built.blocks[5][1]]);
  });

  it("une lecture courte (réseau) n'est jamais une zone : le lecteur strict s'arrête comme l'ancien", async () => {
    const built = build();
    const strict = await readAll(shortReads(built.bytes, built.clusters[2]), true);
    expect(isUnreadableZone(strict.error)).toBe(false);
  });

  it("sans index : un segment de taille déclarée prouve qu'il reste du film, une taille inconnue non", async () => {
    const sized = build({ cues: false });
    const strict = await readAll(new MemoryByteSource(damaged(sized.bytes, [sized.clusters[3], 12])), true);
    expect(isUnreadableZone(strict.error)).toBe(true);

    const unknown = build({ cues: false, unknownSegment: true });
    const live = await readAll(new MemoryByteSource(damaged(unknown.bytes, [unknown.clusters[3], 12])), true);
    expect(live.error).toBeNull();
    expect(live.samples.length).toBe(15);
  });

  it("les lecteurs sans option (transcodeurs, reprise instantanée, répliques) gardent l'ancien comportement", async () => {
    const built = build();
    const bytes = damaged(built.bytes, [built.clusters[3], 12]);
    const source = new MemoryByteSource(bytes);
    const file = await parseMatroska(source);
    const reader = createSampleReader(source, file, file.firstClusterOffset!);
    let n = 0;
    while (await reader.next()) n++;
    expect(n).toBe(15);
  });

  it("le motif est stable : une décimale à virgule, l'octet entier", () => {
    expect(unreadableZoneMessage(234.94, 169510505)).toBe("zone illisible dans le fichier vers 234,9 s (octet 169510505)");
    expect(unreadableZoneMessage(0, 12)).toBe("zone illisible dans le fichier vers 0,0 s (octet 12)");
    expect(isUnreadableZoneReason("zone illisible dans le fichier vers 1,0 s (octet 2)")).toBe(true);
    expect(isUnreadableZoneReason("le remultiplexeur ne produit plus de segment")).toBe(false);
    expect(zoneSecondsOf("zone illisible dans le fichier vers 234,9 s (octet 1)")).toBeCloseTo(234.9, 5);
    const named = new Error(unreadableZoneMessage(3, 4));
    named.name = "UnreadableZone";
    expect(isUnreadableZone(named)).toBe(true);
  });

  it("Remuxer.resumeAfterByte : le premier point d'index vidéo au-delà de la zone", async () => {
    const built = build();
    const file = await parseMatroska(new MemoryByteSource(built.bytes));
    const resume = Remuxer.prototype.resumeAfterByte.call({ file, videoTrack: { number: 1 } } as unknown as Remuxer, built.clusters[3] + 5);
    expect(resume).toBe(8);
    expect(Remuxer.prototype.resumeAfterByte.call({ file, videoTrack: { number: 1 } } as unknown as Remuxer, built.segmentEnd)).toBeNull();
  });
});
