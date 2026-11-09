"""Charge d'inférence continue (détection par 8 + empreintes par 32) pendant N secondes, sur GPU ou CPU."""
import sys, time, numpy as np
sys.path.insert(0, "/srv")
from app.config import settings
from app.faces import Scrfd, Embedder
dev, secs = sys.argv[1], float(sys.argv[2])
settings.ov_device = dev
d = Scrfd("/data/models/buffalo_l/det_10g.onnx", 10); e = Embedder("/data/models/buffalo_l/w600k_r50.onnx", 10)
ims = list(np.load("/x/testframes.npz")["mg6"][:8]); crops = list(np.random.randint(0, 255, (32, 112, 112, 3), np.uint8))
d.detect_batch(ims); e.embed(crops)
print("prêt", flush=True); t0 = time.time(); n = 0
while time.time() - t0 < secs:
    d.detect_batch(ims); e.embed(crops); n += 1
print(f"{dev}: {n * 8 / (time.time() - t0):.1f} images/s + {n * 32 / (time.time() - t0):.1f} visages/s")
