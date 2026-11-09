"""Toutes les combinaisons modèle × titre × seuil, dans un seul conteneur.
python compare.py model1 model2 ... -> une ligne par (modèle, seuil), moyenne sur les titres."""
import json, subprocess, sys, os
titles = [("ted", "/w/data/ted.fr.srt", "/w/gt/ted.txt"), ("mac", "/w/data/mac.embedded.fr.srt", "/w/gt/mac.txt"),
          ("bt", "/w/data/bt.fr.srt", "/w/gt/bt.txt")]
rows = []
for m in sys.argv[1:]:
    for thr in (0.55, 0.6, 0.65, 0.7, 0.75, 0.8):
        per = {}
        for t, srt, gt in titles:
            npz = f"/w/out/{t}_{m}.npz"
            if not os.path.exists(npz):
                continue
            out = subprocess.run([sys.executable, "/w/code/analyse.py", t, npz, "--srt", srt, "--gt", gt, "--thr", str(thr), "--quiet"],
                                 capture_output=True, text=True).stdout.splitlines()[0]
            d = json.loads(out)
            per[t] = d
        if not per:
            continue
        line = f"{m:22s} thr={thr:.2f} "
        for t, d in per.items():
            line += f"| {t}: pur {d['purity']:.2f} frag {d['coverage']:.2f} nommé {d['named']:.2f} préc {d['precision']:.3f} "
        rows.append(line)
        print(line, flush=True)
