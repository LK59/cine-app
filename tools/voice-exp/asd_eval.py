"""Mesure de l'ASD : par réplique (qui bouge les lèvres), et voix → personnage par votes ASD.
python3 asd_eval.py <asd.json> <dump.json> [lang_index]"""
import json, sys, collections

asd = json.load(open(sys.argv[1]))
dump = json.load(open(sys.argv[2]))["cues"]
L = int(sys.argv[3]) if len(sys.argv) > 3 else 0
cast = asd["cast"]
ALIAS = {"nate": "nathan", "mac": "macgyver"}

def name(pid):
    return cast.get(pid, {}).get("character", str(pid)) if pid else None

def ok(g, ch):
    if ch is None:
        return None
    g = ALIAS.get(g.lower(), g.lower()); ch = ch.lower()
    return g in ch or ch.split()[0] == g

res = asd["results"]
stats = collections.Counter()
votes = collections.defaultdict(collections.Counter)
for i, r in res.items():
    i = int(i)
    g = r["gt"]
    cands = [c for c in r["cands"] if c["pid"]]
    named_c = [c for c in cands if c["asd"][L] is not None]
    # ASD : la piste la plus « parlante », si son score dépasse 0 (logit du modèle)
    pred = None
    if named_c:
        best = max(named_c, key=lambda c: c["asd"][L])
        if best["asd"][L] > 0:
            pred = best["pid"]
            v = dump[i]["voice"]
            if v > 0:
                votes[v][pred] += 1
    o = ok(g, name(pred))
    stats["asd_" + ("right" if o else "wrong" if o is False else "none")] += 1
    # heuristique
    hc = [c for c in cands if c["heur"] is not None]
    hp = max(hc, key=lambda c: c["heur"])["pid"] if hc else None
    o = ok(g, name(hp)); stats["heur_" + ("right" if o else "wrong" if o is False else "none")] += 1
    # plus grand visage
    bp = max(cands, key=lambda c: c["size"] * c["cover"])["pid"] if cands else None
    o = ok(g, name(bp)); stats["biggest_" + ("right" if o else "wrong" if o is False else "none")] += 1
    # voix + co-présence (analyse.py)
    o = ok(g, dump[i]["speaker"]); stats["voice_" + ("right" if o else "wrong" if o is False else "none")] += 1
    stats["n"] += 1

# voix → personnage par votes ASD, puis toutes les répliques de la voix
vmap = {}
for v, c in votes.items():
    pid, k = c.most_common(1)[0]
    if k >= 2 and k / sum(c.values()) >= 0.6:
        vmap[v] = pid
for i, r in res.items():
    i = int(i)
    v = dump[i]["voice"]
    hy = name(vmap[v]) if v in vmap else dump[i]["speaker"]  # ASD d'abord, co-présence sinon
    o = ok(r["gt"], hy); stats["hybrid_" + ("right" if o else "wrong" if o is False else "none")] += 1

def line(k):
    r, w, n = stats[k + "_right"], stats[k + "_wrong"], stats[k + "_none"]
    return f"{k:8s} justes {r:3d}  fausses {w:3d}  sans avis {n:3d}  précision {r / max(1, r + w):.3f}  couverture {(r + w) / max(1, stats['n']):.3f}"

print(f"{sys.argv[1].rsplit('/',1)[1]} langue {L} ({asd['langs'][L].rsplit('/',1)[1]}) : {stats['n']} répliques ambiguës (≥ 2 personnes nommées à l'image)")
for k in ("biggest", "heur", "asd", "voice", "hybrid"):
    print("  " + line(k))
print(f"  coût : {asd['video_s']:.0f} s de vidéo, CPU {asd['cpu']:.0f} s, mur {asd['wall']:.0f} s, {json.dumps({k: round(v) for k, v in asd['clock'].items()})}")
