#!/usr/bin/env python3
"""Relevé processeur et mémoire du banc de nuit, sur l'hôte, toutes les PERIOD secondes (défaut 2).

Par conteneur suivi (le navigateur `lumen-nuit-nav`, l'instance `lumen-nuit-app`, et pour le contexte `jellyfin` et
`cine-app`) : le compteur du cgroup v2 (`cpu.stat` usage/user/system en µs, `memory.current`, `memory.peak` s'il
existe) ; pour le navigateur, en plus, chaque processus (nom, pid, utime+stime en tops d'horloge, RSS) — WebProcess,
NetworkProcess, le pilote Node de Playwright, etc. Et `loadavg`. Une ligne JSON par relevé dans OUT.

Le cgroup d'un conteneur est retrouvé par son identifiant (`docker inspect`, une fois par conteneur nouveau) : le
relevé lui-même ne parle pas à Docker. Lecture seule partout.

Usage : sampler.py <sortie.jsonl> [période en s]
"""
import json
import os
import subprocess
import sys
import time

OUT = sys.argv[1]
PERIOD = float(sys.argv[2]) if len(sys.argv) > 2 else 2.0
NAMES = ["lumen-nuit-nav", "lumen-nuit-app", "jellyfin", "cine-app"]
CG = "/sys/fs/cgroup/system.slice"
TICK = os.sysconf("SC_CLK_TCK")
PAGE = os.sysconf("SC_PAGE_SIZE")
known = {}  # nom -> (id, chemin du cgroup)


def resolve(name):
    try:
        out = subprocess.run(["docker", "inspect", "-f", "{{.Id}}", name], capture_output=True, text=True, timeout=10)
    except Exception:
        return None
    cid = out.stdout.strip()
    if out.returncode != 0 or not cid:
        return None
    path = f"{CG}/docker-{cid}.scope"
    return (cid, path) if os.path.isdir(path) else None


def read_kv(path):
    out = {}
    try:
        with open(path) as f:
            for line in f:
                k, v = line.split()
                out[k] = int(v)
    except Exception:
        pass
    return out


def read_int(path):
    try:
        with open(path) as f:
            return int(f.read().strip())
    except Exception:
        return None


def processes(path):
    procs = []
    try:
        pids = open(f"{path}/cgroup.procs").read().split()
    except Exception:
        return procs
    for pid in pids:
        try:
            raw = open(f"/proc/{pid}/stat").read()
            comm = raw[raw.index("(") + 1:raw.rindex(")")]
            fields = raw[raw.rindex(")") + 2:].split()
            ticks = int(fields[11]) + int(fields[12])
            rss = int(fields[21]) * PAGE
            procs.append({"pid": int(pid), "comm": comm, "ticks": ticks, "rss": rss})
        except Exception:
            continue
    return procs


last_resolve = 0.0
with open(OUT, "a", buffering=1) as out:
    while True:
        now = time.time()
        if now - last_resolve > 10:
            # Un conteneur recréé (le navigateur l'est à chaque passage) change d'identifiant : on revérifie.
            for name in NAMES:
                cur = known.get(name)
                if not cur or not os.path.isdir(cur[1]):
                    r = resolve(name)
                    if r:
                        known[name] = r
                    else:
                        known.pop(name, None)
            last_resolve = now
        rec = {"t": int(now * 1000), "load": os.getloadavg()}
        for name, (cid, path) in list(known.items()):
            if not os.path.isdir(path):
                known.pop(name, None)
                continue
            cpu = read_kv(f"{path}/cpu.stat")
            c = {"id": cid[:12], "usage": cpu.get("usage_usec"), "user": cpu.get("user_usec"), "sys": cpu.get("system_usec"),
                 "mem": read_int(f"{path}/memory.current"), "peak": read_int(f"{path}/memory.peak")}
            if name == "lumen-nuit-nav":
                c["procs"] = processes(path)
                ms = read_kv(f"{path}/memory.stat")
                c["stat"] = {k: ms.get(k) for k in ("anon", "file", "shmem", "sock", "kernel", "file_mapped")}
            rec[name] = c
        out.write(json.dumps(rec, separators=(",", ":")) + "\n")
        time.sleep(max(0.1, PERIOD - (time.time() - now)))
