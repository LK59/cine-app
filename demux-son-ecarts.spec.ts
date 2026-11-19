// Outil d'enquête de l'essai demux-son : paquet par paquet, ce qui diffère entre mediabunny et nous.
import { it } from "vitest";
import { openSync, readSync, statSync, readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { openMediaFile } from "@/lib/webcodecs/mediaFile";
import { audioPacketsFrom } from "@/lib/webcodecs/audioDemux";
import type { ByteSource } from "@/lib/webcodecs/byteSource";
function src(path: string): ByteSource { const fd = openSync(path, "r"); const size = statSync(path).size; return { size, read: async (s: number, l: number) => { const n = Math.max(0, Math.min(l, size - s)); const b = Buffer.alloc(n); readSync(fd, b, 0, n, s); return new Uint8Array(b); }, close: () => {} }; }
const md5 = (d: Uint8Array) => createHash("md5").update(d).digest("hex");
it.skipIf(!process.env.EC_TRACKS)("écarts", async () => {
  const core = await import("mediabunny");
  for (const line of readFileSync(process.env.EC_TRACKS!, "utf8").split("\n").filter(Boolean)) {
    const [path, n, codec, from] = line.split("\t");
    const s = src(path); const file = await openMediaFile(s); const t0 = Number(from ?? 0);
    const input = new core.Input({ formats: [file.mp4 ? new core.Mp4InputFormat() : new core.MatroskaInputFormat()], source: new core.CustomSource({ getSize: () => s.size, read: (a, b) => s.read(a, b - a) }) });
    const t = (await input.getAudioTracks()).find((x) => x.id === Number(n))!;
    const sink = new core.EncodedPacketSink(t);
    const mb: { ts: number; h: string }[] = [];
    const start = (await sink.getKeyPacket(t0)) ?? (await sink.getFirstKeyPacket());
    if (start) for await (const p of sink.packets(start)) { if (p.timestamp >= t0 + 30) break; mb.push({ ts: p.timestamp, h: md5(p.data) }); }
    const ours: typeof mb = [];
    for await (const p of audioPacketsFrom(s, file, Number(n), t0)) { if (p.timestamp >= t0 + 30) break; ours.push({ ts: p.timestamp, h: md5(p.data) }); }
    let data = 0, ts = 0, maxTs = 0;
    for (let i = 0; i < Math.min(mb.length, ours.length); i++) { if (mb[i].h !== ours[i].h) data++; const d = Math.abs(mb[i].ts - ours[i].ts); if (d > 1e-6) { ts++; maxTs = Math.max(maxTs, d); } }
    if (process.env.EC_SHOW) { let k = 0; for (let i = 0; i < Math.min(mb.length, ours.length) && k < 14; i++) if (Math.abs(mb[i].ts - ours[i].ts) > 1e-6 || (i > 0 && Math.abs(mb[i - 1].ts - ours[i - 1].ts) > 1e-6)) { k++; console.log("DIFF", i, mb[i].ts.toFixed(4), ours[i].ts.toFixed(4)); } }
    appendFileSync(process.env.EC_OUT!, JSON.stringify({ path: path.slice(22, 80), codec, from: t0, mb: mb.length, ours: ours.length, dataDiff: data, tsDiff: ts, maxTsDiffMs: Math.round(maxTs * 1e6) / 1e3, laced: (file.tracks.find((x) => x.number === Number(n))?.defaultDurationNs ?? null) }) + "\n");
  }
}, 3600000);
