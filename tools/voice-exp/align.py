"""Calage des répliques sur la parole détectée : part de chaque réplique couverte par la VAD, et
décalage global qui la maximise. python3 align.py <srt> <npz> [<npz>...]"""
import sys
import numpy as np
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from srt import parse

cues = parse(sys.argv[1])
for path in sys.argv[2:]:
    z = np.load(path)
    prob = z["prob"]; hop = 512 / 16000
    sp = prob >= 0.5
    def cov(s, e):
        a, b = int(max(0, s) / hop), int(max(0, e) / hop)
        return sp[a:b].mean() if b > a else 0.0
    res = []
    for d in np.arange(-1.0, 1.01, 0.1):
        c = np.array([cov(x["start"] + d, x["end"] + d) for x in cues])
        res.append((round(float(d), 1), float(c.mean())))
    best = max(res, key=lambda r: r[1])
    c0 = np.array([cov(x["start"], x["end"]) for x in cues])
    # attaque : écart entre le début de la réplique et le début de parole le plus proche (±1,5 s)
    onsets = np.where(np.diff(sp.astype(int)) == 1)[0] * hop
    lag = []
    for x in cues:
        k = onsets[np.abs(onsets - x["start"]) < 1.5]
        if len(k):
            lag.append(float(k[np.argmin(np.abs(k - x["start"]))] - x["start"]))
    lag = np.array(lag)
    print(f"{path.rsplit('/',1)[1]}: couverture moyenne {c0.mean():.2f} (sans parole <15 % : {(c0 < 0.15).mean()*100:.1f} %), "
          f"meilleur décalage {best[0]:+.1f} s → {best[1]:.2f} ; attaque parole − réplique : médiane {np.median(lag):+.2f} s, "
          f"|écart| p90 {np.percentile(np.abs(lag), 90):.2f} s")
