"""Le suivi contre le détecteur : sur des tronçons réels, toutes les images choisies sont détectées
(référence) ; on porte les visages de l'image k−1 (détectés) — et de k−2 via k−1 (portés) — jusqu'à k,
et on compare à ce que le détecteur trouve en k.
usage (dans un conteneur de l'image exp) : python trackeval.py FICHIER DEBUT1,DEBUT2,... [durée]"""
import sys, time, json
import numpy as np, cv2
sys.path.insert(0, "/srv")
from app import decode
from app.config import settings
from app.models import ModelManager
from app.shots import ShotSplitter, frames_to_sample, pick_indices
import os
from app.tracking import propagate as _lk, roi_redetect
MODE=os.environ.get('XRAY_TRACK_MODE','roi')
from app.tracks import iou

path = sys.argv[1]
starts = [float(x) for x in sys.argv[2].split(",")]
length = float(sys.argv[3]) if len(sys.argv) > 3 else 120.0
info = decode.probe(path)
mm = ModelManager("buffalo_l", settings.models_dir)
mm.ready = True
eng = mm.load_engine(settings.threads, settings.min_face)
w, h = info.out_size(settings.frame_width)
step = 1.0 / settings.sample_fps
stats = {k: 0 for k in ("det_faces", "det_accepted", "found", "found_acc", "carried", "carried_ok",
                        "carried_acc", "carried_acc_ok", "new_missed_acc", "pairs", "src", "src_matched_truth")}
stats2 = dict(stats)
kerr, kerr2 = [], []
t_trk, n_trk = 0.0, 0


def compare(carried, truth, st, errs):
    st["pairs"] += 1
    st["det_faces"] += len(truth)
    st["det_accepted"] += sum(f.accepted for f in truth)
    st["carried"] += len(carried)
    eng._grade_dummy = None
    used = set()
    for c in carried:
        best, bj = 0.0, -1
        for j, t in enumerate(truth):
            o = iou(c.box, t.box)
            if o > best:
                best, bj = o, j
        if best >= 0.5 and bj not in used:
            used.add(bj)
            st["carried_ok"] += 1
            t = truth[bj]
            io = np.linalg.norm(t.kps[0] - t.kps[1])
            errs.append(float(np.linalg.norm(c.kps - t.kps, axis=1).mean() / max(io, 1)))
        if c.accepted:
            st["carried_acc"] += 1
            st["carried_acc_ok"] += int(best >= 0.5)
    st["found"] += len(used)
    st["found_acc"] += sum(truth[j].accepted for j in used)
    st["new_missed_acc"] += sum(1 for j, t in enumerate(truth) if t.accepted and j not in used)


for s0 in starts:
    splitter = ShotSplitter(w, h, step)
    ds = decode.DecodeStats("vaapi")
    shots = []
    for ts, fr in decode.read_frames(path, s0, length, info, decode.vaapi_suits(info) and decode.vaapi_available(), ds):
        d = splitter.push(ts, fr)
        if d is not None:
            shots.append(d)
    last = splitter.flush(s0 + length)
    if last is not None:
        shots.append(last)
    for sh in shots:
        if not sh.frames:
            continue
        sel = pick_indices(len(sh.frames), frames_to_sample(sh.end - sh.start, sh.static))
        if len(sel) < 2:
            continue
        imgs = [cv2.cvtColor(sh.frames[i][1], cv2.COLOR_YUV2BGR_NV12) for i in sel]
        truth = eng.detect_grade_batch(imgs)
        lum = lambda a, b: [sh.frames[j][1][:h] for j in range(sel[a], sel[b] + 1)]
        prev_carried = None
        for k in range(1, len(sel)):
            t0 = time.perf_counter()
            car = roi_redetect(truth[k - 1], imgs[k], eng.detector) if MODE=='roi' else _lk(truth[k - 1], lum(k - 1, k))
            stats["src"] += len(truth[k - 1])
            # visages de k−1 qui ont un « jumeau » plausible en k (même taille à 30 % près, centre à moins d'une largeur)
            for a in truth[k - 1]:
                ca = (a.box[:2] + a.box[2:]) / 2; wa = a.box[2] - a.box[0]
                if any(abs((b.box[2] - b.box[0]) / max(wa, 1) - 1) < 0.3 and np.linalg.norm((b.box[:2] + b.box[2:]) / 2 - ca) < wa for b in truth[k]):
                    stats["src_matched_truth"] += 1
            t_trk += time.perf_counter() - t0; n_trk += 1
            eng._grade(imgs[k], car)
            compare(car, truth[k], stats, kerr)
            if k >= 2 and prev_carried is not None:
                car2 = roi_redetect(prev_carried, imgs[k], eng.detector) if MODE=='roi' else _lk(prev_carried, lum(k - 1, k))
                eng._grade(imgs[k], car2)
                compare(car2, truth[k], stats2, kerr2)
            prev_carried = car

def show(name, st, errs):
    print(name, json.dumps(st))
    if st["det_faces"]:
        print(f"  rappel visages {st['found'] / st['det_faces']:.3f}  rappel bons visages {st['found_acc'] / max(st['det_accepted'], 1):.3f}"
              f"  précision portés {st['carried_ok'] / max(st['carried'], 1):.3f}"
              f"  erreur points médiane {np.median(errs) if errs else float('nan'):.3f} (× écart des yeux), p90 {np.percentile(errs, 90) if errs else float('nan'):.3f}")

show("1 saut (N=2)", stats, kerr)
show("2 sauts (N=3, via une image portée)", stats2, kerr2)
print(f"suivi {1000 * t_trk / max(n_trk, 1):.1f} ms par image portée ({n_trk})")
