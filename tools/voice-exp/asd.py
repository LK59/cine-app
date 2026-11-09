"""Qui bouge les lèvres pendant une réplique : Light-ASD (MIT, poids AVA) et une heuristique de
mouvement de bouche, sur les visages détectés par le SCRFD d'X-Ray et nommés par ses groupes.

python asd.py <titre> <vidéo> <srt> <gt> <wav langue 1> [<wav langue 2>...] --out out.json [--hdr] [--max N]

Pour chaque réplique étiquetée : vidéo décodée à 25 i/s (640 px), visages détectés toutes les
5 images (5 i/s) et interpolés entre deux, pistes par recouvrement, identité par l'empreinte ArcFace
du plus grand visage de la piste comparée aux groupes nommés d'X-Ray.
"""
import argparse, json, math, subprocess, sys, time
import numpy as np
import cv2
sys.path.insert(0, "/xray")
sys.path.insert(0, "/w/code/stubs")
sys.path.insert(0, "/w/lightasd/src")
sys.path.insert(0, "/w/code")
from srt import parse

ap = argparse.ArgumentParser()
ap.add_argument("title"); ap.add_argument("video"); ap.add_argument("srt"); ap.add_argument("gt")
ap.add_argument("wavs", nargs="+")
ap.add_argument("--out", required=True)
ap.add_argument("--hdr", action="store_true")
ap.add_argument("--max", type=int, default=10000)
ap.add_argument("--threads", type=int, default=3)
ap.add_argument("--only-ambiguous", action="store_true")
A = ap.parse_args()

import torch
torch.set_num_threads(A.threads)
from app.faces import Scrfd, Embedder, align  # noqa
from ASD import ASD  # noqa
import python_speech_features
import wave

FF = "/usr/lib/jellyfin-ffmpeg/ffmpeg"
TONEMAP = "tonemapx=tonemap=bt2390:desat=0:t=bt709:m=bt709:p=bt709:format=yuv420p"
W, H = 640, 360
FPS = 25
DET_EVERY = 5

det = Scrfd("/xd/models/buffalo_l/det_10g.onnx", A.threads)
emb = Embedder("/xd/models/buffalo_l/w600k_r50.onnx", A.threads)

# Light-ASD sur processeur : le code d'origine appelle .cuda() partout
import ASD as asdmod
_cuda = torch.Tensor.cuda
torch.nn.Module.cuda = lambda self, *a, **k: self
torch.Tensor.cuda = lambda self, *a, **k: self
model = ASD()
state = torch.load("/w/lightasd/src/weight/pretrain_AVA_CVPR.model", map_location="cpu")
own = model.state_dict()
for k, v in state.items():
    k2 = k.replace("module.", "")
    if k2 in own:
        own[k2].copy_(v)
model.eval()

faces = json.load(open(f"/w/out/{A.title}_faces.json"))
cast = faces["cast"]
cent_ids, cent = [], []
for pid, lst in faces["centroids"].items():
    for c in lst:
        cent_ids.append(pid); cent.append(c)
cent = np.array(cent, np.float32)
cent /= np.linalg.norm(cent, axis=1, keepdims=True)

cues = parse(A.srt)
gt = {}
for line in open(A.gt):
    line = line.split("#")[0].strip()
    if line:
        rng, who = line.split(None, 1)
        a, _, b = rng.partition("-")
        for i in range(int(a), int(b or a) + 1):
            gt[i] = who.strip()

def named_on_screen(c):
    ppl = set()
    for s in faces["faces"]:
        if min(c["end"], s["end"]) - max(c["start"], s["start"]) > 0.2:
            ppl |= {p for p, f in s["people"].items() if not p.startswith("anon") and f > 0.2}
    return ppl

sel = [i for i in sorted(gt) if i < len(cues) and gt[i] != "PHONE"]
if A.only_ambiguous:
    sel = [i for i in sel if len(named_on_screen(cues[i])) >= 2]
sel = sel[:A.max]

# répliques voisines regroupées en segments (un seul décodage)
segs = []
for i in sel:
    s, e = cues[i]["start"] - 0.4, cues[i]["end"] + 0.4
    if segs and s - segs[-1][1] < 1.0:
        segs[-1][1] = max(segs[-1][1], e); segs[-1][2].append(i)
    else:
        segs.append([s, e, [i]])

def load_wav(p):
    with wave.open(p) as w:
        return np.frombuffer(w.readframes(w.getnframes()), np.int16)
audios = [load_wav(p) for p in A.wavs]

def decode(s, e):
    vf = f"fps={FPS},scale={W}:{H}:flags=fast_bilinear"
    if A.hdr:
        vf += f",format=yuv420p10le,{TONEMAP}"
    cmd = [FF, "-nostdin", "-v", "error", "-threads", str(A.threads), "-ss", f"{max(0, s):.3f}", "-t", f"{e - s:.3f}",
           "-i", A.video, "-an", "-sn", "-vf", vf, "-pix_fmt", "bgr24", "-f", "rawvideo", "-"]
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    n = len(raw) // (W * H * 3)
    return np.frombuffer(raw[: n * W * H * 3], np.uint8).reshape(n, H, W, 3)

def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1]); x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0, x2 - x1) * max(0, y2 - y1)
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-6)

clock = {"decode": 0.0, "detect": 0.0, "embed": 0.0, "asd": 0.0, "heur": 0.0}
results = {}
t_start = time.time(); cpu0 = time.process_time()
for s, e, idxs in segs:
    t = time.time(); frames = decode(s, e); clock["decode"] += time.time() - t
    n = len(frames)
    if n < 10:
        continue
    # 1. détection toutes les DET_EVERY images
    t = time.time()
    dets = {}
    for k in range(0, n, DET_EVERY):
        dets[k] = [f for f in det.detect(frames[k]) if f.min_side >= 24 and f.score >= 0.6]
    clock["detect"] += time.time() - t
    # 2. pistes par recouvrement d'une détection à la suivante
    tracks = []
    for k in sorted(dets):
        for f in dets[k]:
            best, bi = None, 0.3
            for tr in tracks:
                if tr["last"] == k - DET_EVERY and iou(tr["boxes"][-1][1], f.box) > bi:
                    best, bi = tr, iou(tr["boxes"][-1][1], f.box)
            if best is None:
                best = {"boxes": [], "faces": [], "last": None}; tracks.append(best)
            best["boxes"].append((k, f.box.copy())); best["faces"].append((k, f)); best["last"] = k
    tracks = [tr for tr in tracks if len(tr["boxes"]) >= 3]  # au moins 0,4 s
    # 3. identité : empreinte du plus grand visage
    t = time.time()
    for tr in tracks:
        k, f = max(tr["faces"], key=lambda kf: kf[1].min_side)
        crop = align(frames[k], f.kps)
        v = emb.embed([crop])[0]
        sims = cent @ (v / np.linalg.norm(v))
        o = np.argsort(-sims)
        tr["pid"] = cent_ids[o[0]] if sims[o[0]] >= 0.30 else None
        tr["sim"] = float(sims[o[0]])
    clock["embed"] += time.time() - t
    # 4. boîtes à chaque image (interpolation linéaire entre deux détections)
    for tr in tracks:
        ks = np.array([k for k, _ in tr["boxes"]]); bx = np.array([b for _, b in tr["boxes"]])
        fr = np.arange(ks[0], min(n, ks[-1] + DET_EVERY))
        tr["frames"] = fr
        tr["box"] = np.stack([np.interp(fr, ks, bx[:, j]) for j in range(4)], 1)
        # lissage comme Columbia_test (médiane sur 13 images)
    # 5. Light-ASD par piste, pour chaque langue
    t = time.time()
    for tr in tracks:
        crops = []
        for fi, b in zip(tr["frames"], tr["box"]):
            bs = max(b[3] - b[1], b[2] - b[0]) / 2; cs = 0.4
            bsi = int(bs * (1 + 2 * cs))
            img = cv2.copyMakeBorder(frames[fi], bsi, bsi, bsi, bsi, cv2.BORDER_CONSTANT, value=(110, 110, 110))
            my, mx = (b[1] + b[3]) / 2 + bsi, (b[0] + b[2]) / 2 + bsi
            face = img[int(my - bs):int(my + bs * (1 + 2 * cs)), int(mx - bs * (1 + cs)):int(mx + bs * (1 + cs))]
            g = cv2.cvtColor(cv2.resize(face, (224, 224)), cv2.COLOR_BGR2GRAY)
            crops.append(g[56:168, 56:168])
        V = np.array(crops, np.float32)
        tr["asd"] = []
        t0 = s + tr["frames"][0] / FPS
        for au in audios:
            a0 = int(max(0, t0) * 16000); a1 = a0 + int(len(V) / FPS * 16000)
            mf = python_speech_features.mfcc(au[a0:a1], 16000, numcep=13, winlen=0.025, winstep=0.010)
            L = min(len(mf) // 4 * 4 / 100, len(V) / FPS)
            if L < 0.2:
                tr["asd"].append(np.zeros(len(V))); continue
            mfa = torch.FloatTensor(mf[: int(round(L * 100))]).unsqueeze(0)
            va = torch.FloatTensor(V[: int(round(L * 25))]).unsqueeze(0)
            with torch.no_grad():
                sc = model.lossAV.forward(model.model.forward_audio_visual_backend(
                    model.model.forward_audio_frontend(mfa), model.model.forward_visual_frontend(va)), labels=None)
            full = np.full(len(V), np.nan); full[: len(sc)] = sc
            tr["asd"].append(full)
    clock["asd"] += time.time() - t
    # 6. heuristique : énergie de mouvement de la bouche (bas du visage) moins celle du haut
    t = time.time()
    for tr in tracks:
        mot = []
        prev = None
        for fi, b in zip(tr["frames"], tr["box"]):
            x1, y1, x2, y2 = [int(round(v)) for v in b]
            h = y2 - y1; w = x2 - x1
            if h < 10 or w < 10:
                mot.append(np.nan); prev = None; continue
            g = cv2.cvtColor(frames[fi], cv2.COLOR_BGR2GRAY)
            face = cv2.resize(g[max(0, y1):y2, max(0, x1):x2], (48, 48)).astype(np.float32)
            if prev is not None:
                d = np.abs(face - prev)
                mot.append(d[30:44, 12:36].mean() - d[6:22, 8:40].mean())
            else:
                mot.append(np.nan)
            prev = face
        tr["heur"] = np.array(mot)
    clock["heur"] += time.time() - t
    # 7. par réplique : la piste la plus « parlante » pendant la réplique
    for i in idxs:
        c = cues[i]
        a = int((c["start"] - s) * FPS); b = int((c["end"] - s) * FPS)
        cand = []
        for tr in tracks:
            m = (tr["frames"] >= a) & (tr["frames"] < b)
            if m.sum() < 5:
                continue
            cand.append({"pid": tr["pid"], "sim": tr["sim"],
                         "asd": [float(np.nanmean(x[m])) if np.isfinite(x[m]).any() else None for x in tr["asd"]],
                         "heur": float(np.nanmean(tr["heur"][m])) if np.isfinite(tr["heur"][m]).any() else None,
                         "cover": float(m.sum() / max(1, b - a)), "size": float(np.mean(tr["box"][m][:, 3] - tr["box"][m][:, 1]))})
        results[i] = {"gt": gt[i], "start": c["start"], "cands": cand}
    print(f"seg {s:.0f}-{e:.0f} {len(idxs)} répliques {len(tracks)} pistes", flush=True)

wall = time.time() - t_start
cpu = time.process_time() - cpu0
vid_s = sum(e - s for s, e, _ in segs)
json.dump({"results": results, "clock": clock, "wall": wall, "cpu": cpu, "video_s": vid_s, "cast": cast,
           "langs": A.wavs}, open(A.out, "w"))
print(f"fini : {len(results)} répliques, {vid_s:.0f} s de vidéo, mur {wall:.0f} s, CPU {cpu:.0f} s, {clock}")
