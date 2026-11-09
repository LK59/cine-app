"""Vitesse et écart de deux réseaux (ou deux périphériques) sur les mêmes images des titres du banc.
usage : python infer_cmp.py REF_DET REF_EMB CAND_DET CAND_EMB [CAND_DEVICE] [REPS]
  chemins relatifs à /data/models ; CAND_DEVICE : CPU (défaut) ou GPU.
Les images de test (/x/testframes.npz) sont extraites une fois : 3 titres × 64 images, réparties."""
import sys, os, time, json
import numpy as np, cv2
sys.path.insert(0, "/srv")
from app import decode
from app.config import settings
from app.faces import Scrfd, Embedder, FaceEngine, QualityRules, align
from app.inference import OvSession
from app.tracks import iou

M = "/data/models/"
ref_det, ref_emb, cand_det, cand_emb = sys.argv[1:5]
dev = sys.argv[5] if len(sys.argv) > 5 else "CPU"
reps = int(sys.argv[6]) if len(sys.argv) > 6 else 3
T = settings.threads
TF = "/x/testframes.npz"
TITLES = [
    ("/media/tv/MacGyver (2016)/MacGyver (2016) - S01E06 - Wrench.mkv", "mg6"),
    ("/media/tv/The Pitt/Season 2/The Pitt - S02E01 - 7-00 A.M.mkv", "pitt201"),
    ("/media/movies/Bullet Train (2022)/Bullet Train (2022).mkv", "bullet"),
]
if not os.path.exists(TF):
    frames = {}
    for path, name in TITLES:
        if not os.path.exists(path):
            import glob
            print("introuvable", path, glob.glob(os.path.dirname(path) + "/*")[:5]); sys.exit(1)
        info = decode.probe(path)
        ims = []
        for t in np.linspace(0.08, 0.92, 64) * info.duration:
            st = decode.DecodeStats("vaapi")
            fr = next(iter(decode.read_frames(path, float(t), 1.0, info, decode.vaapi_suits(info) and decode.vaapi_available(), st)), None)
            if fr is not None:
                ims.append(cv2.cvtColor(fr[1], cv2.COLOR_YUV2BGR_NV12))
        frames[name] = np.stack(ims)
    np.savez(TF, **frames)
frames = dict(np.load(TF))


def mk(det, emb, device):
    settings.ov_device = device
    d = Scrfd(M + det, T)
    e = Embedder(M + emb, T, batch=32)
    return FaceEngine("x", d, e, QualityRules(min_face=settings.min_face))


def run(eng, name):
    out = {}
    for k, ims in frames.items():
        ims = list(ims)
        for i in range(0, len(ims), 8):  # chauffe : toutes les formes de lot (compilation sur GPU)
            eng.detector.detect_batch(ims[i:i + 8])
        t0 = time.perf_counter(); c0 = time.process_time()
        for _ in range(reps):
            found = []
            for i in range(0, len(ims), 8):
                found += eng.detector.detect_batch(ims[i:i + 8])
        tdet = (time.perf_counter() - t0) / reps / len(ims)
        cdet = (time.process_time() - c0) / reps / len(ims)
        for im, fs in zip(ims, found):
            eng._grade(im, fs)
        crops = [f.crop for fs in found for f in fs if f.accepted]
        eng.embedder.embed(crops)
        t0 = time.perf_counter(); c0 = time.process_time()
        for _ in range(reps):
            embs = eng.embedder.embed(crops)
        temb = (time.perf_counter() - t0) / reps / max(len(crops), 1)
        cemb = (time.process_time() - c0) / reps / max(len(crops), 1)
        out[k] = (found, crops, embs, tdet, temb)
        print(f"{name:5s} {k:8s} détection {1000 * tdet:6.1f} ms/image (processeur {1000 * cdet:6.1f}) ({len(ims)})  empreinte {1000 * temb:6.1f} ms/visage (processeur {1000 * cemb:6.1f}) ({len(crops)})  charge {os.getloadavg()[0]:.0f}", flush=True)
    return out


ref = run(mk(ref_det, ref_emb, "CPU"), "réf")
cand_eng = mk(cand_det, cand_emb, dev)
cand = run(cand_eng, "cand")
for k in frames:
    fa, ca, ea, *_ = ref[k]
    fb, _, _, *_ = cand[k]
    match = miss = extra = 0
    miss_small = 0
    dscore = []
    for A, B in zip(fa, fb):
        used = set()
        for a in A:
            j = max(range(len(B)), key=lambda j: iou(a.box, B[j].box), default=None)
            if j is not None and iou(a.box, B[j].box) >= 0.5 and j not in used:
                used.add(j); match += 1; dscore.append(B[j].score - a.score)
            else:
                miss += 1; miss_small += a.min_side < 36
        extra += len(B) - len(used)
    # Empreintes du candidat sur les MÊMES visages alignés que la référence (écart du seul réseau).
    eb = cand_eng.embedder.embed(ca)
    cos = (ea * eb).sum(1) if len(ea) else np.zeros(0)
    print(f"{k:8s} visages réf {match + miss}: retrouvés {match}, perdus {miss} (dont {miss_small} < 36 px), en plus {extra}; "
          f"écart de score médian {np.median(dscore) if dscore else 0:+.4f} ; cosinus empreintes min {cos.min() if len(cos) else 1:.4f} "
          f"p1 {np.percentile(cos, 1) if len(cos) else 1:.4f} médian {np.median(cos) if len(cos) else 1:.4f}")
