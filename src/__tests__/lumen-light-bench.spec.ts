// Le banc de la version allégée (`lumenServer/light/`) : sur un vrai fichier, avec le vrai encodeur VAAPI, encode
// trois segments consécutifs de chaque échelon et les compare à la vidéo d'origine, image par image.
//
// Sauté sans `LIGHT_FILE`. À lancer dans un conteneur jetable qui a le iGPU et le ffmpeg vidéo (Alpine `ffmpeg` +
// `intel-media-driver`), les médias en lecture seule, un DATA_DIR jetable :
//   docker run --rm --name lumen-light-banc --device /dev/dri --group-add 993 -v "$PWD":/app -w /app \
//     -v /mnt/media/video:/mnt/media/video:ro -e DATA_DIR=/tmp/d -e LIGHT_FILE="/mnt/media/video/…mkv" \
//     -e LIGHT_AT=600 node:26-alpine sh -c 'apk add --no-cache ffmpeg intel-media-driver >/dev/null && npx vitest run src/__tests__/lumen-light-bench.spec.ts'
// Ce qu'il prouve, par ffprobe/ffmpeg sur init + segments concaténés de chaque échelon :
// - chaque segment a exactement les images du segment d'origine, aux mêmes instants (même liste de pts) ;
// - les instants sont contigus d'un segment à l'autre (la fin de l'un est le début du suivant) ;
// - chaque segment commence par une image clé ; le tout se décode sans une erreur ;
// - une source HDR reste HDR (PQ, BT.2020) ;
// - les images sont les mêmes que l'origine (luminance moyenne image par image, la meilleure correspondance au
//   décalage 0 — un segment décalé d'une image se verrait).

import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { LumenEngine } from "@/lib/lumenServer/engine";
import { inlineExecutor } from "@/lib/lumenServer/pool";
import { segmentAt } from "@/lib/lumenServer/service";
import { detectLightEncoder } from "@/lib/lumenServer/light/encoder";
import { lightInitFor, lightSegmentFor, lightStats } from "@/lib/lumenServer/light/service";
import { withLight } from "@/lib/lumenServer/light/view";
import { originTimes } from "@/lib/lumenServer/light/bitstream";
import { hevcCodecString } from "@/lib/webcodecs/codecConfig";

const FILE = process.env.LIGHT_FILE;
const AT = Number(process.env.LIGHT_AT ?? 600);
const OUT = process.env.LIGHT_OUT ?? "/tmp/lumen-light-banc";
const COUNT = 3;

function sh(cmd: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/**
 * Les pts (s) de chaque échantillon d'un MP4 — ceux du conteneur, triés. Pas ceux des images décodées : l'origine qui
 * commence sur une CRA a des RASL qu'un décodeur parti de là jette (2 sur *Ghosted* à 600 s), la version allégée non
 * (elle a été décodée depuis la clé d'avant).
 */
function packetPts(file: string): number[] {
  const r = sh("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", file]);
  return r.out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((v) => Math.round(Number(v) * 1e6))
    .sort((a, b) => a - b);
}

/** La luminance moyenne de chaque image décodée (signalstats), par pts (µs), ramenée à 64×36 pour aller vite. */
function lumaByPts(file: string): Map<number, number> {
  // `-copyts` : les instants du conteneur. Sans lui, ffmpeg ramène la première image décodée à 0 — et l'origine qui
  // commence sur une CRA perd ses RASL au décodage : ses instants glissaient de deux images face à l'allégée.
  const r = sh("ffmpeg", ["-v", "error", "-copyts", "-i", file, "-vf", "scale=64:36,format=yuv420p,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-", "-fps_mode", "passthrough", "-f", "null", "-"]);
  const out = new Map<number, number>();
  let pts: number | null = null;
  for (const line of r.out.split("\n")) {
    const p = /pts_time:([\d.]+)/.exec(line);
    if (p) pts = Math.round(Number(p[1]) * 1e6);
    const y = /YAVG=([\d.]+)/.exec(line);
    if (y && pts !== null) out.set(pts, Number(y[1]));
  }
  return out;
}

/**
 * L'écart moyen entre les variations de luminance d'une image à la suivante, à l'origine et dans l'allégée décalée de
 * `shift` images : les variations, pas les niveaux — un écart constant de niveau (encodeur, plage) n'y pèse pas, une
 * image décalée si (les coupes de plan tombent ailleurs).
 */
function lumaGap(origin: Map<number, number>, light: Map<number, number>, shift: number): number {
  const lightPts = [...light.keys()].sort((a, b) => a - b);
  let sum = 0;
  let n = 0;
  for (let i = 0; i + 1 < lightPts.length; i++) {
    const o0 = origin.get(lightPts[i]);
    const o1 = origin.get(lightPts[i + 1]);
    const l0 = light.get(lightPts[i + shift]);
    const l1 = light.get(lightPts[i + 1 + shift]);
    if (o0 === undefined || o1 === undefined || l0 === undefined || l1 === undefined) continue;
    sum += Math.abs(o1 - o0 - (l1 - l0));
    n += 1;
  }
  return n ? sum / n : Infinity;
}

/** La luminance moyenne d'une signature (pour dire un écart de niveau entre l'origine et l'allégée). */
const meanOf = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0) / Math.max(1, m.size);

describe.skipIf(!FILE)("banc de la version allégée", () => {
  it(
    "trois segments par échelon : mêmes images, mêmes instants, contigus, décodables, HDR gardé",
    async () => {
      mkdirSync(OUT, { recursive: true });
      const detection = await detectLightEncoder();
      console.log("encodeur", JSON.stringify(detection));
      expect(detection.available).toBe(true);
      if (!detection.available) return;
      const engine = new LumenEngine({ executor: inlineExecutor() });
      const raw = await engine.index(FILE!);
      const index = withLight(raw, { version: detection.version, driver: detection.driver });
      console.log("échelons", JSON.stringify(index.light));
      expect(index.light?.length ?? 0).toBeGreaterThan(0);
      const first = segmentAt(index, AT);
      const origin = async (n: number) => (await engine.segment(index, { kind: "video" }, n)).bytes;

      // L'origine : init + les mêmes segments, pour comparer.
      const originParts = [engine.init(index, { kind: "video" })];
      const originCounts: number[] = [];
      for (let n = first; n < first + COUNT; n++) {
        const bytes = await origin(n);
        originParts.push(bytes);
        originCounts.push(originTimes(bytes).presentations.length);
      }
      const originFile = join(OUT, "origine.mp4");
      writeFileSync(originFile, Buffer.concat(originParts));
      const originPts = packetPts(originFile);
      const originLuma = lumaByPts(originFile);

      for (const rung of index.light!) {
        const began = performance.now();
        const init = await lightInitFor(index, rung, origin);
        const parts = [init];
        const initMs = performance.now() - began;
        // Le CODECS annoncé dans la liste maître est celui que l'init écrit (profil, palier, niveau, contraintes).
        const at = Buffer.from(init).indexOf("hvcC");
        const size = Buffer.from(init).readUInt32BE(at - 4);
        expect(hevcCodecString(init.subarray(at + 4, at - 4 + size))).toBe(rung.codecs);
        const timings: number[] = [];
        for (let n = first; n < first + COUNT; n++) {
          const t = performance.now();
          const result = await lightSegmentFor({ index, rung, n, origin });
          timings.push(Math.round(performance.now() - t));
          parts.push(result.bytes);
          expect(originTimes(result.bytes).presentations.length).toBe(originCounts[n - first]);
        }
        const file = join(OUT, `l${rung.rung}.mp4`);
        writeFileSync(file, Buffer.concat(parts));
        // Décodable sans une erreur.
        const decode = sh("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]);
        expect(decode.err.trim()).toBe("");
        // Les mêmes instants que l'origine.
        const pts = packetPts(file);
        expect(pts.length).toBe(originPts.length);
        expect(pts).toEqual(originPts);
        // Et chaque image décodée : toutes, RASL de tête comprises (l'origine en perd ici, pas l'allégée).
        expect(lumaByPts(file).size).toBe(pts.length);
        // Une image clé en tête de chaque segment (trois IDR pour trois segments).
        const keys = sh("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=flags", "-of", "csv=p=0", file]).out.split("\n").filter((f) => f.startsWith("K")).length;
        expect(keys).toBe(COUNT);
        // La couleur.
        const stream = sh("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_tag_string,profile,width,height,color_range,color_transfer,color_primaries", "-of", "compact=p=0", file]).out.trim();
        if (rung.tenBit) expect(stream).toContain("smpte2084");
        expect(stream).toContain("hvc1");
        // Les mêmes images : la luminance moyenne image par image colle au décalage 0, pas à ±1.
        const luma = lumaByPts(file);
        const at0 = lumaGap(originLuma, luma, 0);
        const before = lumaGap(originLuma, luma, -1);
        const after = lumaGap(originLuma, luma, 1);
        console.log(
          `l${rung.rung} ${rung.width}x${rung.height} ${rung.codecs} init ${Math.round(initMs)} ms, segments ${timings.join("/")} ms, ${pts.length} images, écart des variations ${at0.toFixed(2)} (±1 : ${before.toFixed(2)} / ${after.toFixed(2)}), luminance moyenne ${meanOf(originLuma).toFixed(1)} → ${meanOf(luma).toFixed(1)} — ${stream} — origine : ${sh("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=color_range,color_transfer", "-of", "compact=p=0", originFile]).out.trim()}`
        );
        expect(at0).toBeLessThan(Math.min(before, after));
      }
      console.log("compteurs", JSON.stringify(lightStats()));
      await engine.close();
    },
    600_000
  );
});
