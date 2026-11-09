import json, sys
d = json.load(open(sys.argv[1])); a, b = float(sys.argv[2]), float(sys.argv[3])
cast = {int(k): v.split()[-1] for k, v in d["cast"].items()}
sh = d["shots"]
def sim(x, y): return 1 - 0.5 * sum(abs(p - q) for p, q in zip(x, y)) / 3
bounds = {s["start"] for s in d["scenes"]}
for i, s in enumerate(sh):
    if not (a <= s["s"] <= b): continue
    prev = [sim(s["h"], sh[j]["h"]) for j in range(max(0, i - 4), i)]
    ppl = ", ".join(f"{cast.get(p, 'anon' if p < 0 else p)}" for p, t in s["p"])
    mark = "=== SCÈNE ===" if round(s["s"], 3) in bounds else ""
    print(f"{s['s']:7.2f} {s['e'] - s['s']:5.1f}s  sim-1 {prev[-1] if prev else 0:.2f} max4 {max(prev) if prev else 0:.2f}  {ppl:40s} {mark}")
