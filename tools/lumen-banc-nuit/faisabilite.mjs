// Faisabilité : ce que le WebKit de Playwright pour Linux sait lire (HLS natif, MediaSource, codecs).
// Lancé dans l'image Playwright : `node faisabilite.mjs <dossier de médias d'essai>`.
// Les médias d'essai (générés par ffmpeg, voir README) : h264.m3u8 (H.264 + AAC), hevc.m3u8 (HEVC + E-AC-3 5.1),
// en HLS fMP4 ; leurs init et segments servent aussi à la MediaSource (ajoutés tels quels).
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { webkit } from "playwright";

const dir = process.argv[2];
const port = 8765;
const types = { ".m3u8": "application/vnd.apple.mpegurl", ".mp4": "video/mp4", ".m4s": "video/iso.segment", ".html": "text/html" };
const server = http.createServer((req, res) => {
  const p = path.join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(dir) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>banc</title><video id=v muted playsinline></video>");
    return;
  }
  res.writeHead(200, { "content-type": types[path.extname(p)] ?? "application/octet-stream" });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(port, "127.0.0.1", r));

const out = {};
const browser = await webkit.launch({ headless: process.env.HEADED !== "1" });
out.version = browser.version();
const page = await browser.newPage();
page.on("console", (m) => console.error("[page]", m.text()));
await page.goto(`http://localhost:${port}/`);
out.caps = await page.evaluate(() => {
  const v = document.createElement("video");
  const ms = window.MediaSource ?? window.ManagedMediaSource;
  const probe = (t) => ({ canPlayType: v.canPlayType(t) || "", mse: ms ? ms.isTypeSupported(t) : null });
  return {
    ua: navigator.userAgent,
    hls: v.canPlayType("application/vnd.apple.mpegurl") || "",
    hlsX: v.canPlayType("application/x-mpegURL") || "",
    MediaSource: typeof window.MediaSource,
    ManagedMediaSource: typeof window.ManagedMediaSource,
    rvfc: typeof v.requestVideoFrameCallback,
    audioTracks: typeof v.audioTracks,
    AudioEncoder: typeof window.AudioEncoder,
    AudioDecoder: typeof window.AudioDecoder,
    VideoDecoder: typeof window.VideoDecoder,
    h264: probe('video/mp4; codecs="avc1.640028"'),
    hevc_hvc1: probe('video/mp4; codecs="hvc1.1.6.L120.90"'),
    hevc_hev1: probe('video/mp4; codecs="hev1.1.6.L120.90"'),
    hevc_main10: probe('video/mp4; codecs="hvc1.2.4.L153.B0"'),
    dvh1: probe('video/mp4; codecs="dvh1.08.06"'),
    aac: probe('audio/mp4; codecs="mp4a.40.2"'),
    heaac: probe('audio/mp4; codecs="mp4a.40.5"'),
    ac3: probe('audio/mp4; codecs="ac-3"'),
    eac3: probe('audio/mp4; codecs="ec-3"'),
    opus: probe('audio/mp4; codecs="opus"'),
    flac: probe('audio/mp4; codecs="flac"'),
  };
});

async function playHls(name) {
  return page.evaluate(async (src) => {
    const v = document.getElementById("v");
    v.muted = true;
    const t0 = performance.now();
    const ev = [];
    for (const e of ["loadedmetadata", "playing", "error", "waiting"]) v.addEventListener(e, () => ev.push(`${e}@${Math.round(performance.now() - t0)}`));
    let frames = 0;
    const rvfc = () => { frames++; v.requestVideoFrameCallback?.(rvfc); };
    v.requestVideoFrameCallback?.(rvfc);
    v.src = src;
    try { await v.play(); } catch (e) { ev.push(`play-refus:${e.name}`); }
    await new Promise((r) => setTimeout(r, 6000));
    const q = v.getVideoPlaybackQuality?.();
    const res = { ev, t: v.currentTime, frames, rs: v.readyState, err: v.error ? `${v.error.code} ${v.error.message}` : null, w: v.videoWidth, q: q ? { total: q.totalVideoFrames, dropped: q.droppedVideoFrames } : null, audioTracks: v.audioTracks?.length };
    v.removeAttribute("src"); v.load();
    return res;
  }, `/${name}`);
}

async function playMse(init, segs, mime) {
  return page.evaluate(async ({ init, segs, mime }) => {
    const v = document.getElementById("v");
    v.muted = true;
    const MS = window.MediaSource ?? window.ManagedMediaSource;
    if (!MS) return { err: "pas de MediaSource" };
    if (!MS.isTypeSupported(mime)) return { err: `isTypeSupported faux : ${mime}` };
    const ms = new MS();
    v.disableRemotePlayback = true;
    v.src = URL.createObjectURL(ms);
    await new Promise((r) => ms.addEventListener("sourceopen", r, { once: true }));
    const sb = ms.addSourceBuffer(mime);
    const append = (buf) => new Promise((res, rej) => { sb.addEventListener("updateend", res, { once: true }); sb.addEventListener("error", rej, { once: true }); sb.appendBuffer(buf); });
    try {
      for (const u of [init, ...segs]) await append(await (await fetch(u)).arrayBuffer());
      ms.endOfStream();
    } catch (e) { return { err: `append : ${e}` }; }
    let frames = 0;
    const rvfc = () => { frames++; v.requestVideoFrameCallback?.(rvfc); };
    v.requestVideoFrameCallback?.(rvfc);
    try { await v.play(); } catch (e) { return { err: `play : ${e.name}` }; }
    await new Promise((r) => setTimeout(r, 5000));
    const res = { t: v.currentTime, frames, rs: v.readyState, err: v.error ? `${v.error.code} ${v.error.message}` : null, w: v.videoWidth };
    v.removeAttribute("src"); v.load();
    return res;
  }, { init, segs, mime });
}

out.hls_h264_aac = await playHls("h264.m3u8");
out.hls_hevc_eac3 = await playHls("hevc.m3u8");
out.mse_h264_aac = await playMse("/h264_init.mp4", ["/h264_0.m4s", "/h264_1.m4s", "/h264_2.m4s"], 'video/mp4; codecs="avc1.64001f,mp4a.40.2"');
out.mse_hevc_eac3 = await playMse("/hevc_init.mp4", ["/hevc_0.m4s", "/hevc_1.m4s", "/hevc_2.m4s"], 'video/mp4; codecs="hvc1.1.6.L93.90,ec-3"');
await browser.close();
server.close();
console.log(JSON.stringify(out, null, 1));
