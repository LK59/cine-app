#!/usr/bin/env python3
"""Le temps processeur de chaque fil du processus web du navigateur sur une fenêtre (lecture seule de /proc) : ce qui
revient au fil principal (JavaScript : remux, MediaSource), aux décodeurs, au son, au rendu. Usage : fils.py <s> <sortie>"""
import json, os, subprocess, sys, time
from collections import defaultdict
cid = subprocess.run(["docker", "inspect", "-f", "{{.Id}}", "lumen-nuit-nav"], capture_output=True, text=True).stdout.strip()
procs = open(f"/sys/fs/cgroup/system.slice/docker-{cid}.scope/cgroup.procs").read().split()
def snap():
    out = {}
    for pid in procs:
        try:
            comm = open(f"/proc/{pid}/comm").read().strip()
        except Exception:
            continue
        for tid in os.listdir(f"/proc/{pid}/task"):
            try:
                raw = open(f"/proc/{pid}/task/{tid}/stat").read()
                name = raw[raw.index("(") + 1:raw.rindex(")")]
                f = raw[raw.rindex(")") + 2:].split()
                out[(pid, tid)] = (comm, name, int(f[11]) + int(f[12]))
            except Exception:
                pass
    return out
a = snap(); t0 = time.time(); time.sleep(float(sys.argv[1])); b = snap(); dt = time.time() - t0
agg = defaultdict(float)
for k, (comm, name, ticks) in b.items():
    base = a.get(k, (None, None, 0))[2]
    # Les fils numérotés d'une même famille (« avdec_h265-0 », « gst-… ») se regroupent par leur nom sans chiffres.
    fam = "".join(c for c in name if not c.isdigit()).rstrip(":-_ ")
    agg[(comm, fam)] += (ticks - base) / 100
res = sorted(((round(v / dt * 3600), c, n) for (c, n), v in agg.items() if v > 0), reverse=True)
json.dump({"t": int(time.time() * 1000), "seconds": dt, "cpuSperH": [{"proc": c, "fil": n, "cpuSperH": v} for v, c, n in res]}, open(sys.argv[2], "w"), ensure_ascii=False)
for v, c, n in res[:25]:
    print(f"{v:6d} CPU-s/h  {c:16s} {n}")
