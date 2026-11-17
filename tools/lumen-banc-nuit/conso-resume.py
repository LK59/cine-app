#!/usr/bin/env python3
"""Résumé de la consommation : par titre et par lecteur, la moyenne des répétitions (CPU-s par heure de lecture côté
navigateur — processus WebKit seuls —, côté instance, mémoire), l'écart lecteur actuel − Lumen serveur, et chaque
répétition à côté pour juger de la dispersion. Lit resultats/conso.jsonl (analyse.py). Usage : conso-resume.py <résultats>"""
import json, os, statistics, sys
from collections import defaultdict
R = sys.argv[1]
rows = [json.loads(l) for l in open(os.path.join(R, "conso.jsonl"))]
g = defaultdict(list)
for r in rows:
    g[(r["title"], r["decode"], r["player"])].append(r)
def m(v): return statistics.mean(v) if v else None
print("| titre | décodage | lecteur | rép. | lu par rép. | WebKit CPU-s/h (chaque rép.) | moyenne | WebProcess / NetworkProcess CPU-s/h | instance CPU-s/h | mém. moy. / pic Mo | charge moy. |")
print("|---|---|---|---|---|---|---|---|---|---|---|")
summary = {}
for (title, dec, player), rs in sorted(g.items()):
    w = [r["webkitCpuSperH"] for r in rs if r.get("webkitCpuSperH")]
    per = lambda k: m([r["procsCpuS"].get(k, 0) / r["playedS"] * 3600 for r in rs if r.get("procsCpuS")])
    summary[(title, dec, player)] = {"webkit": m(w), "app": m([r.get("appCpuSperH") for r in rs if r.get("appCpuSperH") is not None]), "mem": m([r.get("navMemMeanMB") for r in rs if r.get("navMemMeanMB")])}
    print(f"| {title} | {dec} | {player} | {len(rs)} | {round(statistics.mean(r['playedS'] for r in rs))} s | {' · '.join(str(round(x)) for x in w)} | **{round(m(w))}** | {round(per('WebProcess'))} / {round(per('NetworkProcess'))} | "
          f"{round(summary[(title, dec, player)]['app'])} | {round(m([r.get('navMemMeanMB') for r in rs]))} / {max(r.get('navMemMaxMB') or 0 for r in rs)} | {round(m([r.get('load') for r in rs]), 1)} |")
print()
print("| titre | décodage | WebKit : actuel − serveur | en % du serveur | en cœurs | instance : actuel − serveur | mémoire : actuel − serveur |")
print("|---|---|---|---|---|---|---|")
for (title, dec, player), s in sorted(summary.items()):
    if player != "serveur" or (title, dec, "actuel") not in summary:
        continue
    a = summary[(title, dec, "actuel")]
    d = a["webkit"] - s["webkit"]
    print(f"| {title} | {dec} | {d:+.0f} CPU-s/h | {d / s['webkit'] * 100:+.1f} % | {d / 3600:+.3f} | {a['app'] - s['app']:+.0f} CPU-s/h | {a['mem'] - s['mem']:+.0f} Mo |")
