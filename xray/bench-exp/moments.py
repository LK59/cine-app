"""« Moments » : suites de plans où les mêmes personnes nommées sont à l'écran — l'unité qu'utiliserait
Laterna pour rattacher une réplique à qui est à l'image à cet instant. Calculé sur les extractions
(dumps/*.json). Un plan sans personne prolonge le moment en cours (au plus GAP s) ; un plan dont les
personnes diffèrent ouvre un nouveau moment."""
import json, sys
GAP = 3.0
for f in sys.argv[1:]:
    d = json.load(open(f)); cast = {int(k): v.split()[-1] for k, v in d["cast"].items()}
    mom = []
    for s in d["shots"]:
        ppl = frozenset(p for p, t in s["p"] if p >= 0)
        if mom and (ppl == mom[-1]["p"] or (not ppl and s["s"] - mom[-1]["last"] <= GAP)):
            mom[-1]["e"] = s["e"]
            if ppl: mom[-1]["last"] = s["e"]
        elif ppl:
            mom.append({"s": s["s"], "e": s["e"], "last": s["e"], "p": ppl})
    out = [{"start": round(m["s"], 2), "end": round(m["e"], 2), "people": sorted(m["p"])} for m in mom]
    size = len(json.dumps(out, separators=(",", ":")))
    print(f"{f.split('/')[-1]}: {len(d['shots'])} plans, {len(out)} moments, {size / 1024:.0f} Ko JSON, "
          f"durée médiane {sorted(m['end'] - m['start'] for m in out)[len(out) // 2]:.1f} s")
    if len(sys.argv) > 1 and "bullet" in f:
        for m in out:
            if 880 <= m["start"] <= 960 or 3640 <= m["start"] <= 3700:
                print("   ", m["start"], m["end"], [cast.get(p, p) for p in m["people"]])
