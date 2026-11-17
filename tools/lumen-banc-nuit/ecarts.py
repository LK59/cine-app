#!/usr/bin/env python3
"""Écart serveur − actuel (médiane) par profil réseau et décodage, avec un intervalle à 95 % par rééchantillonnage
(2 000 tirages). Lit resultats/essais.jsonl et resultats/sauts.jsonl (analyse.py). Usage : ecarts.py <dossier résultats>"""
import json, os, random, statistics, sys
R = sys.argv[1]
random.seed(1)
def jl(p): return [json.loads(l) for l in open(os.path.join(R, p))]
essais = [e for e in jl("essais.jsonl") if not e.get("modes") and e.get("targetS") in (None, 4)]
sauts = [s for s in jl("sauts.jsonl") if not s.get("modes") and s.get("targetS") in (None, 4)]
def boot(a, b, n=2000):
    if len(a) < 3 or len(b) < 3: return None
    d = []
    for _ in range(n):
        d.append(statistics.median(random.choices(a, k=len(a))) - statistics.median(random.choices(b, k=len(b))))
    d.sort()
    return statistics.median(a) - statistics.median(b), d[int(.025 * n)], d[int(.975 * n)]
print("| réseau | décodage | mesure | n serveur | n actuel | médiane serveur | médiane actuel | écart (IC 95 %) |")
print("|---|---|---|---|---|---|---|---|")
keys = sorted({(e["net"], e["decode"]) for e in essais})
for net, dec in keys:
    for name, rows, field in (("1re image", essais, "firstFrameMs"), ("image au saut (seeked)", sauts, "seekedMs"), ("reprise après saut", sauts, "advanceMs")):
        sel = lambda p: [r[field] for r in rows if r["net"] == net and r["decode"] == dec and r["player"] == p and r.get(field) is not None and (field == "firstFrameMs" or r.get("ok"))]
        a, b = sel("serveur"), sel("actuel")
        res = boot(a, b)
        if res:
            m, lo, hi = res
            print(f"| {net} | {dec} | {name} | {len(a)} | {len(b)} | {statistics.median(a):.0f} | {statistics.median(b):.0f} | {m:+.0f} ms ({lo:+.0f} à {hi:+.0f}) |")
