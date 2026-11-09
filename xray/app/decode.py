"""Décodage : un flux réduit (640 px, quelques images par seconde) lu depuis ffmpeg.

Sur l'iGPU Intel (VA-API) quand le codec s'y prête, sur le processeur sinon. Le format de
sortie est le même dans les deux cas — NV12 brut, 640 px de large — si bien que tout ce qui
suit ignore d'où viennent les images.

Le HDR (PQ ou HLG) est adapté en SDR *après* la réduction à 640 px, sur le processeur
(`tonemapx`, le filtre SIMD de jellyfin-ffmpeg) : 4 images par seconde de 640×360 ne coûtent
presque rien. Sans adaptation, le signal PQ lu comme du SDR donnait une image délavée aux
histogrammes tassés, et des coupes passaient inaperçues (Bullet Train, 4K HDR10 : 22 coupes
sur 5 minutes, 36 une fois adapté — voir README, « Calibrage »). `tonemap_vaapi` existe sur l'UHD 630, mais
mesuré le 09/11/2026 il rend une image trois fois plus sombre que la source (luminance moyenne
14 contre 35 pour `tonemapx`) : la carte décode et réduit, le processeur adapte.
"""

from __future__ import annotations

import json
import logging
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from fractions import Fraction
from typing import Iterator

import numpy as np

from .config import settings

log = logging.getLogger("xray.decode")

# Ce que décode le bloc vidéo d'un Coffee Lake (UHD 630). Pas d'AV1 (arrivé avec Tiger Lake),
# pas de HEVC 4:2:2/4:4:4 (Ice Lake), pas de H.264 10 bits (jamais chez Intel).
VAAPI_CODECS = {"h264", "hevc", "vp9", "vp8", "mpeg2video", "vc1", "mjpeg"}
VAAPI_HEVC_PROFILES = {"Main", "Main 10", "Main Still Picture"}
HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}
# Adaptation HDR → SDR (BT.2390, comme Jellyfin), sortie 8 bits.
TONEMAP = "tonemapx=tonemap=bt2390:desat=0:t=bt709:m=bt709:p=bt709:format=yuv420p"


@dataclass
class MediaInfo:
    duration: float
    codec: str
    profile: str
    width: int
    height: int
    pix_fmt: str
    sar: float = 1.0
    transfer: str = ""

    @property
    def hdr(self) -> bool:
        """PQ (HDR10, HDR10+, Dolby Vision à couche HDR10) ou HLG."""
        return self.transfer in HDR_TRANSFERS

    def out_size(self, width: int) -> tuple[int, int]:
        """Largeur fixe, hauteur selon le rapport d'affichage (pixels non carrés compris), paire."""
        disp_w = self.width * (self.sar or 1.0)
        h = int(round(width * self.height / disp_w / 2.0)) * 2
        return width, max(2, h)


def probe(path: str) -> MediaInfo:
    out = subprocess.run(
        [settings.ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=codec_name,profile,width,height,pix_fmt,sample_aspect_ratio,color_transfer,duration:format=duration",
         "-of", "json", path],
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe : {out.stderr.strip()[-300:]}")
    data = json.loads(out.stdout or "{}")
    streams = data.get("streams") or []
    if not streams:
        raise RuntimeError("aucune piste vidéo")
    s = streams[0]
    dur = data.get("format", {}).get("duration") or s.get("duration")
    if not dur:
        raise RuntimeError("durée inconnue")
    sar = 1.0
    raw_sar = s.get("sample_aspect_ratio") or "1:1"
    try:
        num, den = raw_sar.split(":")
        if int(num) > 0 and int(den) > 0:
            sar = float(Fraction(int(num), int(den)))
    except (ValueError, ZeroDivisionError):
        pass
    return MediaInfo(
        duration=float(dur), codec=s.get("codec_name", ""), profile=s.get("profile", "") or "",
        width=int(s["width"]), height=int(s["height"]), pix_fmt=s.get("pix_fmt", "") or "", sar=sar,
        transfer=s.get("color_transfer", "") or "",
    )


def vaapi_suits(info: MediaInfo) -> bool:
    if info.codec not in VAAPI_CODECS:
        return False
    if info.codec == "h264" and ("10" in info.pix_fmt or "422" in info.pix_fmt or "444" in info.pix_fmt):
        return False
    if info.codec == "hevc" and info.profile and info.profile not in VAAPI_HEVC_PROFILES:
        return False
    return True


_vaapi_state: dict = {"ok": None, "checked": 0.0}


def vaapi_available(force: bool = False) -> bool:
    """Le périphérique s'ouvre-t-il, et le pilote fait-il un aller-retour d'image ? Mis en cache
    dix minutes : /health le lit à chaque appel."""
    if not settings.hwaccel:
        return False
    now = time.time()
    if not force and _vaapi_state["ok"] is not None and now - _vaapi_state["checked"] < 600:
        return bool(_vaapi_state["ok"])
    dev = settings.vaapi_device
    try:
        r = subprocess.run(
            [settings.ffmpeg, "-hide_banner", "-nostdin", "-v", "error",
             "-init_hw_device", f"vaapi=va:{dev}", "-filter_hw_device", "va",
             "-f", "lavfi", "-i", "color=black:s=256x144:d=0.2",
             "-vf", "format=nv12,hwupload,scale_vaapi=w=128:h=72:format=nv12,hwdownload,format=nv12",
             "-f", "null", "-"],
            capture_output=True, text=True, timeout=30,
        )
        ok = r.returncode == 0
        if not ok:
            log.warning("VA-API indisponible : %s", r.stderr.strip()[-300:])
    except Exception as e:  # ffmpeg absent, délai dépassé…
        log.warning("VA-API indisponible : %s", e)
        ok = False
    _vaapi_state.update(ok=ok, checked=now)
    return ok


_tonemap_state: dict = {"ok": None}


def tonemap_available() -> bool:
    """`tonemapx` est propre à jellyfin-ffmpeg : avec un autre ffmpeg, pas d'adaptation (l'image
    reste terne, comme avant) plutôt qu'un échec de tous les tronçons HDR."""
    if _tonemap_state["ok"] is None:
        try:
            r = subprocess.run([settings.ffmpeg, "-hide_banner", "-filters"], capture_output=True, text=True, timeout=30)
            _tonemap_state["ok"] = " tonemapx " in r.stdout
        except Exception:
            _tonemap_state["ok"] = False
        if not _tonemap_state["ok"]:
            log.warning("tonemapx absent de ffmpeg : le HDR sera analysé sans adaptation")
    return bool(_tonemap_state["ok"])


def build_command(path: str, start: float, length: float, info: MediaInfo, vaapi: bool,
                  fps: float, width: int, threads: int) -> list[str]:
    w, h = info.out_size(width)
    # `-filter_threads` borne aussi les filtres (réduction, adaptation HDR) à `XRAY_THREADS`.
    cmd = [settings.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-filter_threads", str(threads)]
    tonemap = info.hdr and tonemap_available()
    if vaapi:
        cmd += ["-hwaccel", "vaapi", "-hwaccel_device", settings.vaapi_device, "-hwaccel_output_format", "vaapi"]
        if tonemap:
            # La carte réduit en 10 bits, le processeur adapte la petite image.
            vf = f"fps={fps},scale_vaapi=w={w}:h={h}:format=p010,hwdownload,format=p010,{TONEMAP},format=nv12"
        else:
            vf = f"fps={fps},scale_vaapi=w={w}:h={h}:format=nv12,hwdownload,format=nv12"
    else:
        # Sur le processeur, sauter les images non référencées divise le décodage sans rien
        # coûter ici : on n'en garde de toute façon que quatre par seconde.
        cmd += ["-threads", str(threads), "-skip_frame", "noref"]
        if tonemap:
            vf = f"fps={fps},scale={w}:{h}:flags=fast_bilinear,format=yuv420p10le,{TONEMAP},format=nv12"
        else:
            vf = f"fps={fps},scale={w}:{h}:flags=fast_bilinear,format=nv12"
    cmd += ["-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", path,
            "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "nv12", "pipe:1"]
    return cmd


@dataclass
class DecodeStats:
    decoder: str
    frames: int = 0
    seconds: float = 0.0
    returncode: int | None = None
    stderr: str = ""
    extra: dict = field(default_factory=dict)


def read_frames(path: str, start: float, length: float, info: MediaInfo, vaapi: bool,
                stats: DecodeStats, cancel: threading.Event | None = None,
                fps: float | None = None, width: int | None = None) -> Iterator[tuple[float, np.ndarray]]:
    """Rend (instant absolu, image NV12 (h·3/2 × l)) pour chaque image échantillonnée.
    Les instants sont reconstruits à partir du rang : le filtre `fps` cadence la sortie."""
    fps = fps or settings.sample_fps
    width = width or settings.frame_width
    w, h = info.out_size(width)
    frame_bytes = w * h * 3 // 2
    cmd = build_command(path, start, length, info, vaapi, fps, width, settings.threads)
    t0 = time.monotonic()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=frame_bytes * 4)
    err_tail: deque[str] = deque(maxlen=20)

    def drain() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            err_tail.append(line.decode("utf-8", "replace").rstrip())

    t = threading.Thread(target=drain, daemon=True)
    t.start()
    i = 0
    try:
        assert proc.stdout is not None
        while True:
            if cancel is not None and cancel.is_set():
                break
            buf = proc.stdout.read(frame_bytes)
            if not buf or len(buf) < frame_bytes:
                break
            ts = start + i / fps
            i += 1
            if ts >= start + length:
                break
            yield ts, np.frombuffer(buf, dtype=np.uint8).reshape(h * 3 // 2, w)
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        t.join(timeout=2)
        stats.frames = i
        stats.seconds = time.monotonic() - t0
        stats.returncode = proc.returncode
        stats.stderr = "\n".join(err_tail)
