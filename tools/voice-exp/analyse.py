"""Répliques → voix → personnages, et mesure contre la vérité de terrain.

python3 analyse.py <titre> <npz> [--thr 0.5] [--srt fr.srt] [--gt gt.txt] [--dump out.json]
"""
import argparse, json, sys, collections
import numpy as np
from scipy.cluster.hierarchy import linkage, fcluster
from scipy.spatial.distance import pdist
sys.path.insert(0, __file__.rsplit("/", 1)[0])
from srt import parse

ap = argparse.ArgumentParser()
ap.add_argument("title"); ap.add_argument("npz")
ap.add_argument("--srt"); ap.add_argument("--gt"); ap.add_argument("--faces")
ap.add_argument("--thr", type=float, default=0.5)
ap.add_argument("--pad", type=float, default=0.15)
ap.add_argument("--dump")
ap.add_argument("--quiet", action="store_true")
ap.add_argument("--range", default="")
ap.add_argument("--second", type=int, default=1)
ap.add_argument("--exclusive", type=int, default=1)
ap.add_argument("--onevoice", type=float, default=0.6)
ap.add_argument("--bigvoice", type=int, default=20)
ap.add_argument("--save-profiles")
ap.add_argument("--load-profiles")
ap.add_argument("--tau", type=float, default=0.5)
ap.add_argument("--margin", type=float, default=0.1)
A = ap.parse_args()
base = A.npz.rsplit("/", 2)[0]
srt = A.srt or f"{base}/data/{A.title}.fr.srt"
faces = json.load(open(A.faces or f"{base}/out/{A.title}_faces.json"))
z = np.load(A.npz)
wins, embs, regions = z["wins"], z["embs"], z["regions"]
embs = embs / np.linalg.norm(embs, axis=1, keepdims=True)
cues = parse(srt)
lo, hi = (float(x) for x in A.range.split(":")) if A.range else (0, 1e9)

# ---------- vérité de terrain ----------
gt = {}
if A.gt:
    for line in open(A.gt):
        line = line.split("#")[0].strip()
        if not line:
            continue
        rng, who = line.split(None, 1)
        a, _, b = rng.partition("-")
        for i in range(int(a), int(b or a) + 1):
            gt[i] = who.strip()

# ---------- parole sous chaque réplique ----------
def speech_overlap(s, e):
    return sum(max(0, min(e, b) - max(s, a)) for a, b in regions)

centers = (wins[:, 0] + wins[:, 1]) / 2
cue_emb, cue_ok, cue_speech = [], [], []
for c in cues:
    s, e = c["start"] - A.pad, c["end"] + A.pad
    # une fenêtre compte si au moins la moitié d'elle tombe dans la réplique
    ov = np.minimum(wins[:, 1], e) - np.maximum(wins[:, 0], s)
    sel = ov >= 0.5 * (wins[:, 1] - wins[:, 0])
    if not sel.any():  # réplique plus courte qu'une fenêtre : la fenêtre la plus centrée qui la recouvre
        sel = (ov > 0.3)
        if sel.any():
            k = np.argmin(np.abs(centers - (c["start"] + c["end"]) / 2) + 1e3 * (~sel))
            sel = np.zeros(len(wins), bool); sel[k] = True
    sp = speech_overlap(c["start"], c["end"]) / max(c["end"] - c["start"], 1e-3)
    cue_speech.append(sp)
    if sel.any() and sp > 0.15:
        v = embs[sel].mean(0); cue_emb.append(v / np.linalg.norm(v)); cue_ok.append(True)
    else:
        cue_emb.append(np.zeros(embs.shape[1], np.float32)); cue_ok.append(False)
cue_emb = np.array(cue_emb); cue_ok = np.array(cue_ok)
in_range = np.array([lo <= c["start"] < hi for c in cues])

# ---------- regroupement des répliques en voix ----------
idx = np.where(cue_ok)[0]
Z = linkage(pdist(cue_emb[idx], "cosine"), "average")
lab = fcluster(Z, A.thr, "distance")
cluster = -np.ones(len(cues), int); cluster[idx] = lab
sizes = collections.Counter(lab)

# ---------- visages à l'écran pendant chaque réplique ----------
cast = faces["cast"]
fshots = faces["faces"]
pids = sorted({p for s in fshots for p in s["people"] if not p.startswith("anon")})
P = {p: i for i, p in enumerate(pids)}
pres = np.zeros((len(cues), len(pids)))
anyface = np.zeros(len(cues))
for ci, c in enumerate(cues):
    d = max(c["end"] - c["start"], 1e-3)
    for s in fshots:
        ov = min(c["end"], s["end"]) - max(c["start"], s["start"])
        if ov <= 0:
            continue
        for p, frac in s["people"].items():
            if p in P:
                pres[ci, P[p]] += ov / d * frac
            anyface[ci] += ov / d * frac
pres = np.minimum(pres, 1)

# scène X-Ray de chaque réplique
scenes = faces["scenes"]
def scene_of(t):
    for k, s in enumerate(scenes):
        if s["start"] <= t < s["end"]:
            return k
    return -1
cue_scene = np.array([scene_of((c["start"] + c["end"]) / 2) for c in cues])

# ---------- voix → personnage : contraste local ----------
# Pour une voix c et une personne p : présence moyenne de p pendant les répliques de c, moins sa
# présence pendant les répliques des AUTRES voix dans les mêmes scènes (base locale). Un
# champ-contrechamp montre les deux interlocuteurs ; seul celui qui parle est plus souvent à l'image
# quand SA voix parle.
voices = sorted(sizes)
M = {}
for v in voices:
    mine = np.where(cluster == v)[0]
    sc = set(cue_scene[mine])
    other = np.where((cluster != v) & (cluster > 0) & np.isin(cue_scene, list(sc)))[0]
    a = pres[mine].mean(0)
    b = pres[other].mean(0) if len(other) else np.zeros(len(pids))
    score = a - b
    order = np.argsort(-score)
    best, second = order[0], (order[1] if len(order) > 1 else order[0])
    M[v] = dict(n=len(mine), pid=pids[best], score=float(score[best]), margin=float(score[best] - score[second]),
                present=float(a[best]), second=pids[second], scores=score.tolist(), pres=a.tolist())

def accepted(m):
    return m["score"] > -1 and m["n"] >= 3 and m["score"] >= 0.12 and m["margin"] >= 0.06 and m["present"] >= 0.3

# Deuxième chance pour une voix refusée faute de marge (deux personnes toujours ensemble à l'image,
# un couple) : une personne déjà prise par une AUTRE voix, nettement différente de celle-ci, est
# écartée, et la marge est recalculée sur ceux qui restent.
cent = {v: (lambda x: x / np.linalg.norm(x))(cue_emb[cluster == v].mean(0)) for v in voices}
if A.exclusive:
    for _ in range(3):
        owners = {v: M[v]["pid"] for v in voices if accepted(M[v])}
        for v in voices:
            m = M[v]
            if accepted(m) or m["n"] < 3:
                continue
            taken = {p for w, p in owners.items() if w != v and float(cent[w] @ cent[v]) < 0.5}
            sc = np.array(m["scores"]); keep = [k for k, p in enumerate(pids) if p not in taken]
            if not keep:
                continue
            o = sorted(keep, key=lambda k: -sc[k])
            b, s2 = o[0], (o[1] if len(o) > 1 else o[0])
            m2 = dict(m, pid=pids[b], score=float(sc[b]), margin=float(sc[b] - sc[s2]), present=float(m["pres"][b]))
            if accepted(m2):
                m2["exclusive"] = True; M[v] = m2

# Une personne, une voix : deux voix nettement différentes ne peuvent pas être la même personne.
# La plus fournie garde le nom ; une autre ne le garde que si elle lui ressemble (un fragment de la
# même voix). Sinon c'est presque toujours une voix hors champ — téléphone, narration, voix off —
# qui parle pendant que la personne est seule à l'image.
conflicts = []
if A.onevoice:
    acc = [v for v in voices if accepted(M[v])]
    for pid in {M[v]["pid"] for v in acc}:
        vs = sorted([v for v in acc if M[v]["pid"] == pid], key=lambda v: -M[v]["n"])
        anchor = vs[0]
        for w in vs[1:]:
            c = float(cent[w] @ cent[anchor])
            M[w]["cos_anchor"] = c
            if c < A.onevoice and M[w]["n"] >= A.bigvoice:
                M[w] = dict(M[w], rejected="autre voix", score=-1.0); conflicts.append((int(w), int(M[w]["n"]), round(c, 2)))

def charname(pid):
    return cast.get(pid, {}).get("character", pid)

ALIAS = {"nate": "nathan", "beard": "beard", "mac": "macgyver", "jack": "dalton", "bozer": "bozer"}
def gt_match(g, pid):
    ch = charname(pid).lower()
    g = ALIAS.get(g.lower(), g.lower())
    g = g.lower()
    return g in ch or ch.split()[0] == g

# ---------- mesures ----------
G = [i for i in sorted(gt) if i < len(cues) and in_range[i]]
GN = [i for i in G if gt[i] != "PHONE"]
voiced = [i for i in G if cue_ok[i] and gt[i] != "PHONE"]
out = {"title": A.title, "npz": A.npz.rsplit('/', 1)[1], "thr": A.thr}
out["cues"] = int(in_range.sum()); out["gt"] = len(G)
out["voiced_all"] = round(float(cue_ok[in_range].mean()), 3)
out["voiced_gt"] = round(len(voiced) / max(1, len(G)), 3)
out["voices"] = len(voices)
# pureté : part des répliques d'une voix qui sont du personnage majoritaire de cette voix
byv = collections.defaultdict(collections.Counter); byc = collections.defaultdict(collections.Counter)
for i in voiced:
    byv[cluster[i]][gt[i]] += 1; byc[gt[i]][cluster[i]] += 1
out["purity"] = round(sum(c.most_common(1)[0][1] for c in byv.values()) / max(1, len(voiced)), 3)
out["coverage"] = round(sum(c.most_common(1)[0][1] for c in byc.values()) / max(1, len(voiced)), 3)
out["frag"] = {k: len(v) for k, v in sorted(byc.items(), key=lambda kv: -sum(kv[1].values()))}
# attribution
right = wrong = unk = 0; errs = []
pred = {}
for i in range(len(cues)):
    if cluster[i] > 0 and accepted(M[cluster[i]]):
        pred[i] = M[cluster[i]]["pid"]
# 2e passe : profil de voix par personnage (moyenne des répliques des voix acceptées), puis chaque
# réplique encore anonyme rejoint le profil le plus proche s'il l'emporte nettement.
prof_ids = sorted(set(pred.values()))
second = {}
if A.second and prof_ids:
    prof = np.stack([cue_emb[[i for i in pred if pred[i] == p]].mean(0) for p in prof_ids])
    prof /= np.linalg.norm(prof, axis=1, keepdims=True)
    for i in range(len(cues)):
        if i in pred or not cue_ok[i]:
            continue
        sims = prof @ cue_emb[i]
        o = np.argsort(-sims)
        b, s2 = sims[o[0]], (sims[o[1]] if len(o) > 1 else -1)
        if b >= A.tau and b - s2 >= A.margin:
            pred[i] = prof_ids[o[0]]; second[i] = float(b)
phone_ok = phone_bad = 0
for i in G:
    if gt[i] == "PHONE":  # voix hors champ : la seule bonne réponse est « inconnu »
        if i in pred and "maria" not in charname(pred[i]).lower(): phone_bad += 1; errs.append((i, round(cues[i]["start"]), "PHONE", charname(pred[i]), cues[i]["text"][:50]))
        else: phone_ok += 1
        continue
    if i not in pred:
        unk += 1
    elif gt_match(gt[i], pred[i]):
        right += 1
    else:
        wrong += 1; errs.append((i, round(cues[i]["start"]), gt[i], charname(pred[i]), cues[i]["text"][:50]))
out["named"] = round((right + wrong) / max(1, len(GN)), 3)
out["precision"] = round(right / max(1, right + wrong), 3)
out["right"], out["wrong"], out["unknown"] = right, wrong, unk
out["phone_unknown_ok"], out["phone_named_bad"] = phone_ok, phone_bad
out["unk_by"] = dict(collections.Counter(gt[i] for i in G if i not in pred).most_common(8))
out["conflicts"] = conflicts
out["second_pass"] = len([i for i in G if i in second])
# référence sans son : la personne la plus visible pendant la réplique (si visible ≥ 50 %)
br = bw = 0
for i in G:
    k = int(np.argmax(pres[i])) if len(pids) else 0
    if len(pids) and pres[i, k] >= 0.5:
        if gt_match(gt[i], pids[k]): br += 1
        else: bw += 1
out["faceonly"] = {"named": round((br + bw) / max(1, len(G)), 3), "precision": round(br / max(1, br + bw), 3)}
print(json.dumps(out, ensure_ascii=False))
if not A.quiet:
    for v in sorted(voices, key=lambda v: -sizes[v]):
        m = M[v]
        if m["n"] < 2:
            continue
        print(f"  voix {v:3d} n={m['n']:3d} → {charname(m['pid'])[:22]:22s} s={m['score']:.2f} marge={m['margin']:.2f} "
              f"prés={m['present']:.2f} cos={m.get('cos_anchor',1):.2f} {'OK' if accepted(m) else '--'}  vérité={dict(byv[v].most_common(3))}")
    for e in errs[:40]:
        print("  ERREUR", e)
if A.save_profiles:
    pp = {}
    for p_ in set(pred.values()):
        ii = [i for i in pred if pred[i] == p_ and i not in second]
        if len(ii) >= 5:
            v_ = cue_emb[ii].mean(0); pp[p_] = (v_ / np.linalg.norm(v_)).tolist()
    json.dump(pp, open(A.save_profiles, "w"))
if A.load_profiles:
    # Mémoire de série : chaque réplique de CET épisode comparée aux voix nommées d'un épisode
    # précédent, sans regarder les visages ; accord mesuré avec l'attribution par les visages.
    pp = json.load(open(A.load_profiles)); ids = list(pp); P_ = np.array([pp[k] for k in ids])
    agree = disagree = only_prof = only_face = 0; ex = []
    for i in range(len(cues)):
        if not cue_ok[i]:
            continue
        s_ = P_ @ cue_emb[i]; o_ = np.argsort(-s_)
        pr = ids[o_[0]] if s_[o_[0]] >= A.tau and s_[o_[0]] - (s_[o_[1]] if len(o_) > 1 else -1) >= A.margin else None
        fc = pred.get(i)
        if pr and fc:
            if pr == fc: agree += 1
            else: disagree += 1; ex.append((round(cues[i]["start"]), charname(pr), charname(fc), cues[i]["text"][:40]))
        elif pr: only_prof += 1
        elif fc: only_face += 1
    print(json.dumps({"profiles": len(ids), "agree": agree, "disagree": disagree, "only_profile": only_prof, "only_face": only_face,
                      "agree_rate": round(agree / max(1, agree + disagree), 3)}, ensure_ascii=False))
    for e_ in ex[:12]: print("   désaccord", e_)
if A.dump:
    json.dump({"cues": [dict(c, voice=int(cluster[i]), speaker=(charname(pred[i]) if i in pred else None),
                             gt=gt.get(i)) for i, c in enumerate(cues)]}, open(A.dump, "w"), ensure_ascii=False)
