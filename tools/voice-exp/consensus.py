"""Attribution par consensus de plusieurs seuils de regroupement (et éventuellement plusieurs
modèles) : un nom n'est gardé que si au moins `need` des avis le donnent, et aucun autre nom.
python consensus.py need model[,model2] thr1,thr2,...  -> une ligne par titre"""
import json, subprocess, sys, collections
need = int(sys.argv[1]); models = sys.argv[2].split(","); thrs = sys.argv[3].split(",")
titles = [("ted", "/w/data/ted.fr.srt", "/w/gt/ted.txt"), ("mac", "/w/data/mac.embedded.fr.srt", "/w/gt/mac.txt"),
          ("bt", "/w/data/bt.fr.srt", "/w/gt/bt.txt")]
ALIAS = {"nate": "nathan", "mac": "macgyver"}
def ok(g, ch):
    g = ALIAS.get(g.lower(), g.lower()); ch = ch.lower()
    return g in ch or ch.split()[0] == g
import os
for t, srt, gt in titles:
    votes = collections.defaultdict(collections.Counter); cues = None
    for m in models:
        npz = f"/w/out/{t}_{m}.npz"
        if not os.path.exists(npz):
            continue
        for thr in thrs:
            dump = f"/tmp/{t}_{m}_{thr}.json"
            subprocess.run([sys.executable, "/w/code/analyse.py", t, npz, "--srt", srt, "--gt", gt, "--thr", thr, "--quiet",
                            "--dump", dump], capture_output=True)
            cues = json.load(open(dump))["cues"]
            for i, c in enumerate(cues):
                votes[i][c["speaker"]] += 1
    r = w = u = pr = pb = 0
    n = 0
    for i, c in enumerate(cues):
        if not c["gt"]:
            continue
        top = [(k, v) for k, v in votes[i].most_common() if k]
        name = top[0][0] if top and top[0][1] >= need and (len(top) == 1 or top[1][1] < top[0][1]) and \
            votes[i][None] < top[0][1] else None
        if c["gt"] == "PHONE":
            if name and "maria" not in name.lower(): pb += 1
            else: pr += 1
            continue
        n += 1
        if name is None: u += 1
        elif ok(c["gt"], name): r += 1
        else: w += 1
    print(f"{t}: modèles {models} seuils {thrs} besoin {need} → nommé {(r + w) / n:.3f} précision {r / max(1, r + w):.3f} "
          f"(justes {r}, fausses {w}, inconnues {u}) ; voix hors champ : inconnues {pr}, nommées à tort {pb}", flush=True)
