// Banc du moteur de Lumen serveur (étape 2) — sauté sans LUMEN_FILES.
//
// Sur de vrais fichiers, en lecture seule : construit l'index (lecteur léger), les listes, puis TOUS
// les segments de deux fenêtres — le début du film, et une fenêtre après un saut —, vidéo et chaque
// piste audio servie, chacun produit seul par le moteur (la file et, avec LUMEN_WORKER, de vrais
// `worker_threads` sur le module empaqueté par tools/lumen-worker/build.mjs). Puis ffmpeg juge :
// - la vidéo recollée (init + segments) se décode sans une erreur, sans trou entre les images ;
// - chaque son recollé se décode sans erreur, paquets contigus (pts + durée = pts suivant) ;
// - la durée de chaque segment produit égale son EXTINF (à une image ou une trame près) ;
// - les listes de la fenêtre se lisent par le démultiplexeur HLS de ffmpeg (EXT-X-MAP, URI relatives).
// Et il mesure, par segment : le temps, les lectures, la mémoire du processus (pic de RSS échantillonné
// pendant la construction, au-dessus de la base d'avant).
//
//   docker build -t lumen-banc:etape2 - <<< $'FROM node:26-alpine\nRUN apk add --no-cache ffmpeg'
//   node tools/lumen-worker/build.mjs /chemin/lumen-worker.mjs       # (dans un conteneur node)
//   docker run --rm --name lumen-banc --cpus 4 -m 3g -v "$PWD":/app -v /mnt/media/video:/media:ro \
//     -v <sorties>:/out -w /app -e LUMEN_FILES=/out/liste.txt -e LUMEN_OUT=/out/resultats \
//     -e LUMEN_WORKER=/out/lumen-worker.mjs [-e LUMEN_WINDOW_S=90 -e LUMEN_SEEK_WINDOW_S=30] \
//     lumen-banc:etape2 npx vitest run lumen-engine-bench.spec.ts
//
// LUMEN_FILES : un chemin par ligne, `chemin<TAB>étiquette` permis. Une ligne JSON par fichier dans
// LUMEN_OUT/resultats.jsonl ; les segments écrits sont effacés après jugement (LUMEN_KEEP=1 les garde).
import { describe, it, expect } from "vitest";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { LumenEngine } from "@/lib/lumenServer/engine";
import { inlineExecutor, workerExecutor } from "@/lib/lumenServer/pool";
import { lumenEligibility } from "@/lib/lumenServer/eligibility";
import { masterPlaylist } from "@/lib/lumenServer/playlists";
import { initName, playlistName, segmentName, type LumenIndex, type LumenRendition } from "@/lib/lumenServer/format";
import { parseFragments, endDecode } from "./src/__tests__/lumenServer-helpers";

const FILES = process.env.LUMEN_FILES;
const OUT = process.env.LUMEN_OUT ?? "/out/resultats";
const WINDOW_US = Number(process.env.LUMEN_WINDOW_S ?? 90) * 1e6;
const SEEK_WINDOW_US = Number(process.env.LUMEN_SEEK_WINDOW_S ?? 30) * 1e6;
const labels = { locale: "fr", canaux: (n: number) => `${n} canaux`, piste: (n: number) => `Piste ${n}` };

interface SegmentMeasure {
  n: number;
  extinf: number;
  ms: number;
  bytes: number;
  readMB: number;
  reads: number;
  diskMs: number;
  rssPeakMB: number;
  /** Durée produite (fin de décodage − tfdt) moins EXTINF, en ms. */
  driftMs: number;
}

function sh(cmd: string, args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return { code: r.status ?? -1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;
const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
};

/** Les segments qui couvrent [from, from + span). */
function windowOf(index: LumenIndex, fromUs: number, spanUs: number): number[] {
  const out: number[] = [];
  index.segments.forEach((s, n) => {
    if (s.endUs > fromUs && s.startUs < fromUs + spanUs) out.push(n);
  });
  return out;
}

/** Une liste média réduite à la fenêtre : les mêmes noms, EXTINF de l'index. */
function windowPlaylist(index: LumenIndex, rendition: LumenRendition, window: number[]): string {
  const target = Math.max(...window.map((n) => Math.round((index.segments[n].endUs - index.segments[n].startUs) / 1e6)), 1);
  const lines = ["#EXTM3U", "#EXT-X-VERSION:7", `#EXT-X-TARGETDURATION:${target}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-INDEPENDENT-SEGMENTS", `#EXT-X-MAP:URI="${initName(rendition)}"`];
  for (const n of window) lines.push(`#EXTINF:${((index.segments[n].endUs - index.segments[n].startUs) / 1e6).toFixed(6)},`, segmentName(rendition, n));
  lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

describe.skipIf(!FILES)("banc du moteur de Lumen serveur", () => {
  const entries = FILES
    ? readFileSync(FILES, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => {
          const [path, label] = l.split("\t");
          return { path, label: label ?? path.split("/").pop()! };
        })
    : [];

  it.each(entries)("$label", async ({ path, label }) => {
    mkdirSync(OUT, { recursive: true });
    const executor = process.env.LUMEN_WORKER ? workerExecutor(process.env.LUMEN_WORKER, 3) : inlineExecutor();
    const engine = new LumenEngine({ executor });
    const report: Record<string, unknown> = { label, path, executor: executor.kind };
    const problems: string[] = [];
    try {
      const began = performance.now();
      const index = await engine.index(path);
      report.index = { ms: Math.round(performance.now() - began), workerMs: index.cost.ms, reads: index.cost.reads, readMB: mb(index.cost.bytes), container: index.container };
      report.keys = index.keys;
      report.refusal = index.refusal;
      report.audio = index.audio.map((a) => ({ n: a.number, codec: a.codecId, lang: a.language, ch: a.signal?.channels ?? null, refus: a.refusal }));
      report.video = index.video ? { codecs: index.video.signal?.codecs, supplemental: index.video.signal?.supplementalCodecs, range: index.video.signal?.videoRange, entry: index.video.signal?.entry } : null;
      const durations = index.segments.map((s) => (s.endUs - s.startUs) / 1e6);
      report.plan = {
        segments: index.segments.length,
        median: quantile(durations, 0.5),
        p95: quantile(durations, 0.95),
        max: Math.max(0, ...durations),
        delayMs: index.delayUs / 1000,
        frameRate: Math.round(index.frameRate * 1000) / 1000,
        bandwidth: index.bandwidth,
      };
      const served = index.audio.filter((a) => !a.refusal);
      const verdict = lumenEligibility(index, served[0]?.number ?? index.audio[0]?.number ?? null);
      report.eligibility = verdict;
      // Un refus (`segment-trop-long`…) n'empêche pas d'éprouver le moteur sur ce fichier : on construit
      // et juge quand même ses segments, le refus est noté. Seul un fichier sans découpe s'arrête là.
      if (index.segments.length === 0) {
        appendFileSync(join(OUT, "resultats.jsonl"), `${JSON.stringify(report)}\n`);
        return;
      }
      const dir = join(OUT, label.replace(/[^A-Za-z0-9._-]+/g, "_"));
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "master.m3u8"), masterPlaylist(index, { audioTrack: served[0]?.number ?? null, labels }));
      report.master = readFileSync(join(dir, "master.m3u8"), "utf8");

      const renditions: LumenRendition[] = [{ kind: "video" }, ...served.map((a) => ({ kind: "audio" as const, track: a.number }))];
      const seekAt = Math.round(index.durationUs * 0.6);
      // Et le plus long segment du fichier, avec ses voisins : le pire cas de mémoire et de temps.
      const longest = index.segments.reduce((best, seg, n) => (seg.endUs - seg.startUs > index.segments[best].endUs - index.segments[best].startUs ? n : best), 0);
      const windows = {
        debut: windowOf(index, 0, WINDOW_US),
        saut: windowOf(index, seekAt, SEEK_WINDOW_US),
        long: [longest - 1, longest, longest + 1].filter((n) => n >= 0 && n < index.segments.length),
      };
      report.windows = { debut: [windows.debut[0], windows.debut.at(-1)], saut: [windows.saut[0], windows.saut.at(-1)], sautS: seekAt / 1e6, long: windows.long };

      const measures: Record<string, SegmentMeasure[]> = {};
      const checks: Record<string, unknown> = {};
      for (const [name, window] of Object.entries(windows)) {
        const wdir = join(dir, name);
        mkdirSync(wdir, { recursive: true });
        for (const rendition of renditions) {
          const tag = rendition.kind === "video" ? "v" : `a${rendition.track}`;
          mkdirSync(join(wdir, tag), { recursive: true });
          writeFileSync(join(wdir, initName(rendition)), engine.init(index, rendition));
          writeFileSync(join(wdir, playlistName(rendition)), windowPlaylist(index, rendition, window));
          const parts: Uint8Array[] = [engine.init(index, rendition)];
          const list: SegmentMeasure[] = (measures[`${name}/${tag}`] = []);
          let previousEnd: number | null = null;
          let gaps = 0;
          for (const n of window) {
            const base = process.memoryUsage.rss();
            let peak = base;
            const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage.rss())), 2);
            const t0 = performance.now();
            const segment = await engine.segment(index, rendition, n);
            const ms = performance.now() - t0;
            clearInterval(sampler);
            peak = Math.max(peak, process.memoryUsage.rss());
            writeFileSync(join(wdir, segmentName(rendition, n)), segment.bytes);
            parts.push(segment.bytes);
            const fragments = parseFragments(segment.bytes);
            const first = fragments[0].baseDecode;
            const end = endDecode(fragments);
            if (previousEnd !== null && first !== previousEnd) gaps += 1;
            previousEnd = end;
            const extinf = (index.segments[n].endUs - index.segments[n].startUs) / 1e6;
            list.push({
              n,
              extinf,
              ms: Math.round(ms),
              bytes: segment.bytes.length,
              readMB: mb(segment.cost.bytes),
              reads: segment.cost.reads,
              diskMs: segment.cost.diskMs,
              rssPeakMB: mb(peak - base),
              driftMs: Math.round((end - first) / 1000 - extinf * 1000),
            });
          }
          const concat = join(wdir, `${tag}.mp4`);
          writeFileSync(concat, Buffer.concat(parts.map((p) => Buffer.from(p))));
          const check: Record<string, unknown> = { tfdtGaps: gaps };
          // Décodage complet : la moindre erreur de référence, de tranche ou de trame sort ici.
          const decode = sh("ffmpeg", ["-v", "error", "-xerror", "-i", concat, "-map", "0", "-f", "null", "-"]);
          check.decodeErrors = decode.err.trim() ? decode.err.trim().split("\n").slice(0, 5) : [];
          check.decodeCode = decode.code;
          const packets = sh("ffprobe", ["-v", "error", "-show_entries", "packet=pts_time,duration_time,flags", "-of", "csv=p=0", concat]);
          const rows = packets.out.trim().split("\n").map((l) => l.split(",")).map(([pts, dur]) => [Number(pts), Number(dur)]);
          if (rendition.kind === "video") {
            const pts = rows.map((r) => r[0]).sort((a, b) => a - b);
            const frame = 1 / Math.max(1, index.frameRate);
            let holes = 0;
            for (let i = 1; i < pts.length; i++) if (pts[i] - pts[i - 1] > 1.5 * frame + 0.002) holes += 1;
            check.frames = pts.length;
            check.holes = holes;
            check.spanS = Math.round((pts.at(-1)! - pts[0] + frame) * 1000) / 1000;
          } else {
            let discontinuities = 0;
            for (let i = 1; i < rows.length; i++) if (Math.abs(rows[i][0] - (rows[i - 1][0] + rows[i - 1][1])) > 0.0011) discontinuities += 1;
            check.packets = rows.length;
            check.discontinuities = discontinuities;
          }
          const nominal = window.reduce((s, n) => s + (index.segments[n].endUs - index.segments[n].startUs) / 1e6, 0);
          check.extinfS = Math.round(nominal * 1000) / 1000;
          // Le démultiplexeur HLS de ffmpeg : la liste de la fenêtre, ses URI relatives et son EXT-X-MAP.
          const hls = sh("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-allowed_extensions", "ALL", "-show_entries", "format=duration", "-of", "csv=p=0", join(wdir, playlistName(rendition))]);
          check.hlsDurationS = Number(hls.out.trim()) || null;
          check.hlsErrors = hls.err.trim() ? hls.err.trim().split("\n").slice(0, 3) : [];
          checks[`${name}/${tag}`] = check;
          if (gaps > 0) problems.push(`${name}/${tag} : ${gaps} raccords tfdt`);
          if ((check.decodeErrors as string[]).length > 0 || decode.code !== 0) problems.push(`${name}/${tag} : erreurs de décodage`);
          if ((check.holes as number) > 0) problems.push(`${name}/${tag} : ${check.holes} trous d'image`);
          if ((check.discontinuities as number) > 0) problems.push(`${name}/${tag} : ${check.discontinuities} discontinuités`);
        }
      }
      // Le maître, par le démultiplexeur HLS (début seulement : copie des listes de la fenêtre à côté).
      for (const rendition of renditions) writeFileSync(join(dir, playlistName(rendition)), readFileSync(join(dir, "debut", playlistName(rendition))));
      for (const rendition of renditions) {
        writeFileSync(join(dir, initName(rendition)), engine.init(index, rendition));
        const tag = rendition.kind === "video" ? "v" : `a${rendition.track}`;
        sh("cp", ["-r", join(dir, "debut", tag), dir]);
      }
      const master = sh("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-allowed_extensions", "ALL", "-show_entries", "stream=codec_name,channels,width,height", "-of", "csv=p=0", join(dir, "master.m3u8")]);
      checks.master = { streams: master.out.trim().split("\n"), errors: master.err.trim() ? master.err.trim().split("\n").slice(0, 3) : [] };

      report.checks = checks;
      report.segments = Object.fromEntries(
        Object.entries(measures).map(([k, list]) => [
          k,
          {
            count: list.length,
            ms: { median: quantile(list.map((m) => m.ms), 0.5), max: Math.max(...list.map((m) => m.ms)) },
            outMB: { median: mb(quantile(list.map((m) => m.bytes), 0.5)), max: mb(Math.max(...list.map((m) => m.bytes))) },
            readMB: { median: quantile(list.map((m) => m.readMB), 0.5), max: Math.max(...list.map((m) => m.readMB)) },
            reads: { median: quantile(list.map((m) => m.reads), 0.5), max: Math.max(...list.map((m) => m.reads)) },
            rssPeakMB: { median: quantile(list.map((m) => m.rssPeakMB), 0.5), max: Math.max(...list.map((m) => m.rssPeakMB)) },
            driftMs: { min: Math.min(...list.map((m) => m.driftMs)), max: Math.max(...list.map((m) => m.driftMs)) },
          },
        ])
      );
      report.queuePeakMB = mb(engine.queue.peakBytes);
      report.problems = problems;
      appendFileSync(join(OUT, "resultats.jsonl"), `${JSON.stringify(report)}\n`);
      writeFileSync(join(OUT, `${label.replace(/[^A-Za-z0-9._-]+/g, "_")}.segments.json`), JSON.stringify(measures));
      if (process.env.LUMEN_KEEP !== "1") rmSync(dir, { recursive: true, force: true });
      expect(problems).toEqual([]);
    } finally {
      await engine.close();
    }
  }, 600_000);
});
