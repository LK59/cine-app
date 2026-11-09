"""Jeu de calibrage INT8 : images de la médiathèque (hors titres du banc), et visages alignés.
Écrit /out/det.npy (N×3×384×640 float32, prétraité comme Scrfd) et /out/emb.npy (M×3×112×112, prétraité
comme Embedder). usage : python calibset.py /out DOSSIER1 DOSSIER2 ..."""
import sys, os, glob, random
import numpy as np, cv2
sys.path.insert(0, "/srv")
from app import decode
from app.config import settings
from app.models import ModelManager

out = sys.argv[1]
dirs = sys.argv[2:]
random.seed(7)
mm = ModelManager("buffalo_l", settings.models_dir); mm.ready = True
eng = mm.load_engine(settings.threads, settings.min_face)
det_blobs, crops = [], []
for d in dirs:
    files = sorted(f for f in glob.glob(os.path.join(d, "**", "*.mkv"), recursive=True) + glob.glob(os.path.join(d, "**", "*.mp4"), recursive=True))
    if not files:
        continue
    f = random.choice(files)
    try:
        info = decode.probe(f)
    except Exception as e:
        print("skip", f, e); continue
    w, h = info.out_size(640)
    n = 0
    for t in np.linspace(0.12, 0.88, 14) * info.duration:
        st = decode.DecodeStats("cpu")
        fr = next(iter(decode.read_frames(f, float(t), 1.0, info, False, st)), None)
        if fr is None:
            continue
        img = cv2.cvtColor(fr[1], cv2.COLOR_YUV2BGR_NV12)
        canvas = np.zeros((384, 640, 3), np.uint8)
        canvas[:min(h, 384), :640] = img[:384]
        det_blobs.append(cv2.dnn.blobFromImage(canvas, 1.0 / 128.0, (640, 384), (127.5,) * 3, swapRB=True)[0])
        for face in eng.detect_grade(img):
            if face.accepted:
                crops.append(face.crop)
        n += 1
    print(d, os.path.basename(f), info.codec, "hdr" if info.hdr else "sdr", n, "images", len(crops), "visages", flush=True)
np.save(os.path.join(out, "det.npy"), np.stack(det_blobs).astype(np.float32))
np.save(os.path.join(out, "emb.npy"), cv2.dnn.blobFromImages(crops, 1.0 / 127.5, (112, 112), (127.5,) * 3, swapRB=True).astype(np.float32))
print("images", len(det_blobs), "visages", len(crops))
