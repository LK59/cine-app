import sys, resource, numpy as np
sys.path.insert(0, "/srv")
from app.faces import Scrfd, Embedder
from app.config import settings
det = sys.argv[1]; dev = sys.argv[2] if len(sys.argv) > 2 else "CPU"
settings.ov_device = dev
fr = dict(np.load("/x/testframes.npz"))
d = Scrfd("/data/models/" + det, 8)
e = Embedder("/data/models/buffalo_l/w600k_r50.onnx", 8)
rss = lambda: resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
print("départ", rss(), "Mo", flush=True)
for k, ims in fr.items():
    for n in range(1, 9):
        d.detect_batch(list(ims[:n]))
    print(k, "après lots 1..8", rss(), "Mo", flush=True)
crops = np.random.randint(0, 255, (40, 112, 112, 3), np.uint8)
for n in range(1, 33):
    e.embed(list(crops[:n]))
print("après empreintes 1..32", rss(), "Mo")
