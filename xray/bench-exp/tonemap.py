"""Adaptation HDR → SDR : chemins candidats contre `tonemapx` (le chemin actuel), sur Bullet Train.
1) qualité : 24 instants, une image 640 px par chemin ; luminance moyenne, écart absolu moyen au chemin
   actuel, corrélation ; 2) coût : un tronçon de 120 s à 4 images/s, temps réel et temps processeur.
usage : python tonemap.py [qualité|coût|tout]"""
import sys, subprocess, time, resource, os
import numpy as np

FF = "/usr/lib/jellyfin-ffmpeg/ffmpeg"
SRC = "/media/movies/Bullet Train (2022)/Bullet Train (2022).mkv"
W, H = 640, 268
TMX = "tonemapx=tonemap=bt2390:desat=0:t=bt709:m=bt709:p=bt709:format=yuv420p"
HW = ["-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-init_hw_device", "opencl=ocl@va", "-filter_hw_device", "va",
      "-hwaccel", "vaapi", "-hwaccel_device", "va", "-hwaccel_output_format", "vaapi"]
HWV = ["-hwaccel", "vaapi", "-hwaccel_device", "/dev/dri/renderD128", "-hwaccel_output_format", "vaapi"]
S = f"scale_vaapi=w={W}:h={H}"
PATHS = {
    # le chemin actuel : la carte réduit en 10 bits, le processeur adapte
    "actuel_tonemapx": (HWV, f"fps=4,{S}:format=p010,hwdownload,format=p010,{TMX},format=nv12"),
    "sans_adaptation": (HWV, f"fps=4,{S}:format=nv12,hwdownload,format=nv12"),
    "tonemap_vaapi": (HWV, f"fps=4,{S}:format=p010,tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709,hwdownload,format=nv12"),
    "tonemap_vaapi_procamp": (HWV, f"fps=4,{S}:format=p010,tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709,procamp_vaapi=b=BR:c=CT,hwdownload,format=nv12"),
    "tonemap_vaapi_light": (HWV, f"fps=4,{S}:format=p010,tonemap_vaapi=format=nv12:t=bt709:m=bt709:p=bt709:light=LIGHT,hwdownload,format=nv12"),
    "tonemap_opencl": (HW, f"fps=4,{S}:format=p010,hwmap=derive_device=opencl,tonemap_opencl=tonemap=bt2390:desat=0:t=bt709:m=bt709:p=bt709:format=nv12,hwmap=derive_device=vaapi:reverse=1,hwdownload,format=nv12"),
    "tonemap_opencl_dl": (HW, f"fps=4,{S}:format=p010,hwmap=derive_device=opencl,tonemap_opencl=tonemap=bt2390:desat=0:t=bt709:m=bt709:p=bt709:format=nv12,hwdownload,format=nv12"),
}


def grab(name, vf_args, t, length=0.26):
    pre, vf = vf_args
    cmd = [FF, "-hide_banner", "-nostdin", "-loglevel", "error", "-filter_threads", "10"] + pre + [
        "-ss", f"{t:.3f}", "-t", f"{length:.3f}", "-i", SRC, "-map", "0:v:0", "-an", "-sn", "-vf", vf,
        "-f", "rawvideo", "-pix_fmt", "nv12", "pipe:1"]
    r = subprocess.run(cmd, capture_output=True)
    fb = W * H * 3 // 2
    if r.returncode != 0 or len(r.stdout) < fb:
        return None, r.stderr.decode()[-400:]
    return np.frombuffer(r.stdout[:fb], np.uint8)[:W * H].reshape(H, W).astype(np.float32), None


def quality(paths):
    ts = np.linspace(300, 7400, 24)
    ref = [grab("ref", PATHS["actuel_tonemapx"], t)[0] for t in ts]
    print(f"{'chemin':34s} luma moy (réf {np.mean([r.mean() for r in ref]):.1f})  |Δ| moyen  corrélation")
    for name, p in paths.items():
        ys = []
        for t in ts:
            y, err = grab(name, p, t)
            if y is None:
                print(name, "ÉCHEC", err); break
            ys.append(y)
        else:
            d = np.mean([np.abs(a - b).mean() for a, b in zip(ys, ref)])
            c = np.mean([np.corrcoef(a.ravel(), b.ravel())[0, 1] for a, b in zip(ys, ref) if a.std() > 1 and b.std() > 1])
            print(f"{name:34s} {np.mean([y.mean() for y in ys]):6.1f}   {d:6.1f}    {c:.3f}", flush=True)


def cost(paths, start=3000.0, length=120.0):
    for name, (pre, vf) in paths.items():
        cmd = [FF, "-hide_banner", "-nostdin", "-loglevel", "error", "-filter_threads", "10"] + pre + [
            "-ss", f"{start}", "-t", f"{length}", "-i", SRC, "-map", "0:v:0", "-an", "-sn", "-vf", vf,
            "-f", "rawvideo", "-pix_fmt", "nv12", "-y", "/dev/null"]
        r0 = resource.getrusage(resource.RUSAGE_CHILDREN)
        t0 = time.monotonic()
        r = subprocess.run(cmd, capture_output=True)
        wall = time.monotonic() - t0
        r1 = resource.getrusage(resource.RUSAGE_CHILDREN)
        cpu = (r1.ru_utime - r0.ru_utime) + (r1.ru_stime - r0.ru_stime)
        print(f"{name:34s} {'ok' if r.returncode == 0 else 'ÉCHEC ' + r.stderr.decode()[-200:]:6s} temps réel {wall:6.1f} s  processeur {cpu:6.1f} s  (charge {os.getloadavg()[0]:.1f})", flush=True)


mode = sys.argv[1] if len(sys.argv) > 1 else "tout"
sel = dict(PATHS)
extra = {}
for br, ct in [(10, 1.3), (12, 1.35), (14, 1.3), (8, 1.45), (15, 1.4)]:
    pre, vf = PATHS["tonemap_vaapi_procamp"]
    extra[f"tonemap_vaapi_procamp_b{br}_c{ct}"] = (pre, vf.replace("BR", str(br)).replace("CT", str(ct)))
for lt in ["1000|400", "300|100", "100|50"]:
    pre, vf = PATHS["tonemap_vaapi_light"]
    extra[f"tonemap_vaapi_light_{lt.replace('|', '_')}"] = (pre, vf.replace("LIGHT", lt))
del sel["tonemap_vaapi_procamp"], sel["tonemap_vaapi_light"]
sel.update(extra)
if mode in ("qualité", "tout"):
    quality({k: v for k, v in sel.items() if "procamp" in k})
if mode in ("coût", "tout"):
    cost({k: sel[k] for k in sel if k in ("actuel_tonemapx", "sans_adaptation", "tonemap_vaapi_procamp_b12_c1.35", "tonemap_opencl_dl")})
