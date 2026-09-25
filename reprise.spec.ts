// La reprise instantanée, prouvée sur un vrai fichier : les octets que `recordOpening` garde
// suffisent-ils à rouvrir le fichier à la position et à produire le premier segment — sans rien
// d'autre ?
//
// Sauté sans fichier, comme les autres bancs. Il ouvre le fichier comme le lecteur (en-tête, index,
// remultiplexeur à la position, premier segment) sur une source qui **lève** pour tout morceau non
// gardé : s'il passe, l'ouverture d'une reprise ne demande rien au réseau. Il imprime aussi ce que
// l'enregistrement coûte (morceaux, Mo) et ce qu'il couvre.
//
//   docker run --rm -v "$PWD":/app -v /mnt/media/video:/media:ro -w /app \
//     -e REPRISE_FILE="/media/movies/…mkv" -e REPRISE_AT=4120 \
//     node:24-alpine sh -c "npx vitest run reprise.spec.ts"

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CHUNK_SIZE, type ByteSource } from "@/lib/webcodecs/byteSource";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { Remuxer } from "@/lib/webcodecs/remuxer";
import { recordOpening } from "@/lib/resumeCache/record";

// Le remultiplexeur demande au navigateur ce qu'il accepte : ici, tout — comme `bench.spec.ts`.
const anySource = { isTypeSupported: () => true };
(globalThis as unknown as { window: unknown }).window = { ManagedMediaSource: anySource };
(globalThis as unknown as { MediaSource: unknown }).MediaSource = anySource;

function fileSource(path: string): ByteSource {
  const fd = openSync(path, "r");
  const size = statSync(path).size;
  return {
    size,
    read: async (start: number, requested: number) => {
      const length = Math.max(0, Math.min(requested, size - start));
      const buffer = Buffer.alloc(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, start + read);
        if (n <= 0) break;
        read += n;
      }
      return new Uint8Array(buffer.subarray(0, read));
    },
    close: () => closeSync(fd),
  };
}

/** Ne connaît que les morceaux gardés : tout le reste lève, comme un réseau absent. */
function onlyKept(inner: ByteSource, kept: number[]): ByteSource & { refused: number[] } {
  const allowed = new Set(kept);
  const refused: number[] = [];
  return {
    refused,
    size: inner.size,
    read(offset, length) {
      const end = Math.min(inner.size, offset + length);
      for (let i = Math.floor(offset / CHUNK_SIZE); i <= Math.floor((end - 1) / CHUNK_SIZE); i++) {
        if (!allowed.has(i)) {
          refused.push(i);
          return Promise.reject(new Error(`morceau ${i} non gardé`));
        }
      }
      return inner.read(offset, length);
    },
    close() {},
  };
}

describe.skipIf(!process.env.REPRISE_FILE)("reprise instantanée", () => {
  it("rouvre le fichier à la position avec les seuls octets gardés", { timeout: 600_000 }, async () => {
    const at = Number(process.env.REPRISE_AT ?? 600);
    const source = fileSource(process.env.REPRISE_FILE!);
    const recorded = await recordOpening(source, at);
    expect(recorded).not.toBeNull();
    const mo = recorded!.chunks.length;
    console.log(
      `gardé : ${mo} morceau(x) de 1 Mio (${recorded!.partial ? "en-tête et index seuls" : `de ${recorded!.coveredFrom.toFixed(2)} s à ${recorded!.coveredTo.toFixed(2)} s`}), ` +
        `sur ${(source.size / 2 ** 20).toFixed(0)} Mio`
    );
    if (recorded!.partial) return;

    const offline = onlyKept(source, recorded!.chunks);
    const file = await openMediaFile(offline);
    const video = file.tracks.find((t) => t.type === "video")!;
    const audio = file.tracks.filter((t) => t.type === "audio").find((t) => t.codecId !== "A_DTS" && t.codecId !== "A_TRUEHD") ?? null;
    const remuxer = await Remuxer.open(offline, file, video, audio, { width: video.video?.width ?? 1920, height: video.video?.height ?? 1080 }, null, at, { perTrack: true });
    remuxer.seekTo(at);
    const segment = await remuxer.nextSegment();
    expect(segment).not.toBeNull();
    console.log(
      `premier segment : jusqu'à ${segment!.endSeconds.toFixed(2)} s, ${segment!.video.reduce((n, f) => n + f.byteLength, 0)} o d'image, ` +
        `${segment!.audio?.byteLength ?? 0} o de son — morceaux refusés : ${offline.refused.length ? offline.refused.join(", ") : "aucun"}`
    );
    expect(offline.refused).toEqual([]);
    remuxer.close();
    source.close();
  });
});
