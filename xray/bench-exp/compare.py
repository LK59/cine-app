"""Compare deux bancs (avant / après) : temps, étapes, noms, temps de présence, scènes.
usage: python3 compare.py BEFORE_DIR AFTER_DIR"""
import json, sys
from pathlib import Path

A, B = Path(sys.argv[1]), Path(sys.argv[2])
SKIP = {"mg6": [(208.3, 224.8), (2502.1, 2551.4)], "pitt201": [(3068.9, 3170.1)], "mg5": None, "pitt101": None}


def load(d, n):
    poll = (d / f"{n}.poll.log").read_text().splitlines()
    item = json.loads(next(l for l in poll if l.startswith("ITEM "))[5:])
    scenes = json.loads(next(l for l in poll if l.startswith("SCENES "))[7:])
    cast = {c["personId"]: c["name"] for c in json.loads((d / f"{n}.order.json").read_text())["cast"]}
    return item, scenes, cast


def people(scenes, cast, skips=None):
    tot, inskip = {}, {}
    for s in scenes["scenes"]:
        dur = s["end"] - s["start"]
        ov = 0.0
        for a, b in skips or []:
            ov += max(0.0, min(b, s["end"]) - max(a, s["start"]))
        for p in s["people"]:
            nm = cast.get(p["personId"], p["personId"])
            tot[nm] = tot.get(nm, 0) + p["screenTime"]
            if ov and dur:
                inskip[nm] = inskip.get(nm, 0) + p["screenTime"] * ov / dur
    return tot, inskip


for n in ("mg5", "mg6", "pitt101", "pitt201", "bullet"):
    try:
        ia, sa, ca = load(A, n)
        ib, sb, cb = load(B, n)
    except (FileNotFoundError, StopIteration):
        print(n, "manquant"); continue
    sta, stb = ia.get("stats") or {}, ib.get("stats") or {}
    print(f"\n=== {n} ===")
    print(f"temps {sta.get('seconds')} s ({sta.get('realtime')}×) → {stb.get('seconds')} s ({stb.get('realtime')}×), sauté {stb.get('skippedSeconds', 0)} s")
    for k in sorted(set(sta.get("stages", {})) | set(stb.get("stages", {}))):
        print(f"   {k:12s} {sta.get('stages', {}).get(k, 0):8.1f} → {stb.get('stages', {}).get(k, 0):8.1f}")
    print("   comptes avant", sta.get("counts"))
    print("   comptes après", stb.get("counts"))
    ta, ska = people(sa, ca, SKIP.get(n))
    tb, _ = people(sb, cb)
    print(f"   scènes {len(sa['scenes'])} → {len(sb['scenes'])}; personnes {len(ta)} → {len(tb)}")
    for nm in sorted(set(ta) | set(tb), key=lambda k: -max(ta.get(k, 0), tb.get(k, 0))):
        a, b = ta.get(nm, 0), tb.get(nm, 0)
        flag = "" if (nm in ta) == (nm in tb) else ("  ← DISPARU" if nm in ta else "  ← NOUVEAU")
        print(f"   {nm:28s} {a:7.1f} → {b:7.1f}  ({b - a:+6.1f}; dont {ska.get(nm, 0):5.1f} s avant dans des plages sautées){flag}")
