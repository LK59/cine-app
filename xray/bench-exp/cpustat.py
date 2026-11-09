"""Temps processeur (cgroup) par titre et par heure de vidéo analysée, par banc.
usage : python3 cpustat.py TAG..."""
import sys, json, datetime, bisect
X = "/tmp/claude-1000/-opt-stacks-cine-app/9bf72156-c396-4d6d-80d5-0d784ed2dcfd/scratchpad/xexp"
log = {}
for l in open(f"{X}/cpu.log"):
    n, t, u, ld = l.split()
    log.setdefault(n, []).append((int(t), int(u) / 1e6, float(ld)))
def at(n, ts):
    xs = log[n]; ks = [x[0] for x in xs]; i = min(max(bisect.bisect_left(ks, ts), 1), len(xs) - 1)
    (t0, u0, _), (t1, u1, _) = xs[i - 1], xs[i]
    return u0 + (u1 - u0) * (ts - t0) / max(t1 - t0, 1)
for tag in sys.argv[1:]:
    import os
    if not os.path.exists(f"{X}/{tag}/timing"): continue
    n = "xray-exp-" + tag.split("-")[0]; st = {}
    for l in open(f"{X}/{tag}/timing"):
        p = l.split()
        if p[0] in ("start", "end"):
            st.setdefault(p[1], {})[p[0]] = int(datetime.datetime.fromisoformat(p[2]).timestamp())
    for name, d in st.items():
        if "end" not in d or not any(l.startswith("ITEM ") for l in open(f"{X}/{tag}/{name}.poll.log")): continue
        poll = open(f"{X}/{tag}/{name}.poll.log").read().splitlines()
        item = json.loads(next(l for l in poll if l.startswith("ITEM "))[5:]); s = item["stats"]
        analysed = s.get("decodeSeconds") or 0
        cpu = at(n, d["end"]) - at(n, d["start"])
        loads = [x[2] for x in log[n] if d["start"] <= x[0] <= d["end"]]
        dur = item.get("analyzedUntil") or 1
        print(f"{tag:8s} {name:8s} processeur {cpu:7.0f} s = {cpu / (dur / 3600):6.0f} s par heure de vidéo ; mur {d['end'] - d['start']:5d} s ; "
              f"étapes {json.dumps({k: round(v) for k, v in s['stages'].items() if v >= 1})} ; images {s['counts'].get('images')} visages emp. {s['counts'].get('embedded')} "
              f"portées {s['counts'].get('tracked_images', 0)} ; charge moy {sum(loads) / max(len(loads), 1):.1f}")
