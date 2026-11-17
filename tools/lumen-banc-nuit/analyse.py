#!/usr/bin/env python3
"""Dépouillement du banc de nuit — voir README.md.

Entrées (dans le dossier de travail) : `data/logs/startup.log` de l'instance (lignes `kind: "lumen-test"`),
`out/marks.jsonl` (début/fin de chaque passage, écrits par banc.mjs, avec décodage et profil réseau), `out/samples.jsonl`
(sampler.py), `out/*.gpu.json` (intel_gpu_top).

Sorties (dans OUT, défaut <travail>/resultats) :
- `essais.jsonl` : une ligne par lecture d'un essai de série, annotée du passage (décodage, réseau, ordre, passe) ;
- `sauts.jsonl` : une ligne par saut ;
- `conso.jsonl` : une ligne par lecture continue mesurée (CPU navigateur par processus, instance, Jellyfin, mémoire,
  charge, iGPU) ;
- `tableaux.md` : les tableaux du rapport.

Usage : analyse.py <dossier de travail> [OUT]
"""
import glob
import json
import os
import statistics
import sys
from collections import defaultdict

WORK = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(WORK, "resultats")
os.makedirs(OUT, exist_ok=True)


def jl(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out


def pct(values, p):
    v = sorted(x for x in values if x is not None)
    if not v:
        return None
    k = (len(v) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return v[lo] + (v[hi] - v[lo]) * (k - lo)


def fmt(x, nd=0):
    if x is None:
        return "—"
    return f"{x:,.{nd}f}".replace(",", " ") if nd else f"{round(x):,}".replace(",", " ")


marks = jl(os.path.join(WORK, "out/marks.jsonl"))
# Les fenêtres des passages : (début, fin, contexte). Le contexte vient du label (serie-<passe>-<ordre>-<décodage>-<réseau>-HHMM).
windows = []
open_by_label = {}
for m in marks:
    if m["phase"] == "debut":
        open_by_label[m["label"]] = m
    elif m["phase"] in ("fin", "erreur", "echec") and m["label"] in open_by_label:
        d = open_by_label.pop(m["label"])
        windows.append((d, m))


def context_of(label):
    try:
        return _context_of(label)
    except Exception:
        return {"kind": "autre"}


def _context_of(label):
    parts = label.split("-")
    if len(parts) < 5:
        return {"kind": "autre"}
    if parts[0] == "serie":
        # serie-<passe>-<ordre>-<décodage>-<réseau…>-HHMM ; « wifi-faible » contient un tiret
        return {"kind": "serie", "pass": parts[1], "order": parts[2], "decode": parts[3], "net": "-".join(parts[4:-1])}
    if parts[0] == "essai":
        # essai-<titre>-<lecteur>[-mux]-<décodage>-<réseau…>-HHMMSS
        mux = parts[3] == "mux"
        rest = parts[4:] if mux else parts[3:]
        return {"kind": "essai", "title": parts[1], "player": parts[2], "mux": mux, "decode": rest[0], "net": "-".join(rest[1:-1]), "pass": "essai", "order": "-"}
    if parts[0] == "conso":
        return {"kind": "conso", "title": parts[1], "player": parts[2], "decode": parts[3], "net": "-".join(parts[4:-1])}
    return {"kind": parts[0]}


# --- Les essais de série ---------------------------------------------------------------------------------------
startup = [d for d in jl(os.path.join(WORK, "data/logs/startup.log")) if d.get("kind") == "lumen-test"]
from datetime import datetime


def ts(d):
    return datetime.fromisoformat(d["timestamp"].replace("Z", "+00:00")).timestamp() * 1000


serie_windows = [(d["t"] - 5000, (f["t"] if f else d["t"]) + 60000, d, context_of(d["label"])) for d, f in windows if d["mode"] == "serie" and context_of(d["label"])["kind"] == "serie"]
# Un essai seul : sa ligne (« Envoyer les résultats ») part juste avant la marque de fin.
essai_windows = [(d["t"] - 60000, f["t"] + 5000, d, context_of(d["label"])) for d, f in windows if d["mode"] == "essai" and context_of(d["label"])["kind"] == "essai"]
trials, seeks = [], []
NAMES = {"d4513bcf59bba90a23656f40ed816c3d": "À la Maison Blanche S03E01", "3f79d20c0c10289f3c6df5f72f62b84b": "Black Monday S02E10",
         "55027c51fd0cdeceec6062202c73a4db": "Coup de foudre à Notting Hill", "7f17493b25683f0db7125defa08b70a0": "American Housewife — Attaque de poux",
         "1694ff6c78fd793f321d348511771a47": "Ghosted", "a1e058d682294a1de3cf5bb47d904e0e": "Pearl Harbor", "edaa7d0071b034dc32fabf1834484278": "Ted Lasso S02E01",
         "697cf1d483e4e736edf416d8b510f19f": "Alien : Romulus", "579892073db7f5021e7ba6426cb163e5": "The Knick S01E01", "23505fbd074bc303c0a41dbc8a8d207f": "Le Prestige"}
for line in startup:
    a = line.get("auto")
    t = ts(line)
    if a and a.get("summary"):
        continue
    if a:
        ctx = next((c | {"label": d["label"]} for lo, hi, d, c in serie_windows if lo <= t <= hi), None)
    else:
        ctx = next((c | {"label": d["label"]} for lo, hi, d, c in essai_windows if lo <= t <= hi), None)
        if ctx:
            a = {"pass": "essai", "order": "-", "trial": f"{ctx['title']}-{ctx['player']}{'-mux' if ctx['mux'] else ''}", "status": "ok", "serie": None}
    if not ctx:
        continue
    for r in line.get("runs", []):
        waits = r.get("waits") or {}
        rec = {
            "t": line["timestamp"], "label": ctx["label"], "pass": a.get("pass"), "order": a.get("order"), "decode": ctx["decode"], "net": ctx["net"],
            "serie": a.get("serie"), "trial": a.get("trial"), "status": a.get("status"), "player": r.get("player"), "title": NAMES.get(r.get("itemId"), r.get("title") or r.get("itemId")),
            # Le mode manuel ne porte pas `modes` dans sa ligne : le multiplexage se lit dans la version (`3m1-…`).
            "modes": r.get("modes") or ({"mux": True} if ctx.get("mux") or "m1-" in str(r.get("version", "")) else None), "targetS": r.get("targetS"), "firstFrameMs": r.get("firstFrameMs"), "targetFrameMs": r.get("targetFrameMs"),
            "waits": waits.get("count"), "waitMs": waits.get("totalMs"), "errors": r.get("errors") or [], "freezes": r.get("freezes") or [],
            "quality": r.get("qualityDelta"), "framesPresented": r.get("framesPresented"), "end": r.get("end"),
            "chrono": (r.get("chrono") or {}).get("summary"), "srvBuildMaxMs": r.get("srv.buildMaxMs"), "srvMB": r.get("srv.MB"),
        }
        trials.append(rec)
        for s in r.get("seeks") or []:
            # « barre » à 0,3 s : le saut que fait le moteur du lecteur actuel à l'ouverture, vu par la page comme un geste.
            if s.get("kind") != "parcours":
                continue
            seeks.append({k: rec[k] for k in ("label", "pass", "order", "decode", "net", "trial", "player", "title", "modes", "targetS")} | s)

with open(os.path.join(OUT, "essais.jsonl"), "w") as f:
    for r in trials:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
with open(os.path.join(OUT, "sauts.jsonl"), "w") as f:
    for r in seeks:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

md = []


def table(title, header, rows):
    md.append(f"\n### {title}\n")
    md.append("| " + " | ".join(header) + " |")
    md.append("|" + "---|" * len(header))
    for row in rows:
        md.append("| " + " | ".join(str(c) for c in row) + " |")


def is_rule(r):
    """Un essai « règle » : sans levier ni cible d'essai — ceux qui se comparent d'un lecteur à l'autre."""
    return not r.get("modes") and (r.get("targetS") in (None, 4))


def group_table(title, key):
    groups = defaultdict(list)
    sgroups = defaultdict(list)
    for r in trials:
        if r["pass"] in ("courte", "complète", "essai") and is_rule(r):
            groups[key(r) + (r["player"],)].append(r)
    for s in seeks:
        if s["pass"] in ("courte", "complète", "essai") and is_rule(s):
            sgroups[key(s) + (s["player"],)].append(s)
    rows = []
    for k in sorted(groups):
        rs, ss = groups[k], sgroups.get(k, [])
        ff = [r["firstFrameMs"] for r in rs if r["firstFrameMs"] is not None]
        ok = [s for s in ss if s.get("ok")]
        seeked = [s.get("seekedMs") for s in ok]
        adv = [s.get("advanceMs") for s in ok]
        missed = sum(1 for s in ss if not s.get("ok"))
        rows.append(list(k) + [len(rs), len(ff), fmt(pct(ff, .5)), fmt(pct(ff, .9)), len(ss), fmt(pct(seeked, .5)), fmt(pct(seeked, .9)), fmt(pct(adv, .5)), fmt(pct(adv, .9)), missed,
                               sum(r["waits"] or 0 for r in rs), sum(len(r["freezes"]) for r in rs), sum(len(r["errors"]) for r in rs), sum(1 for r in rs if r["status"] not in ("ok", None))])
    return rows


hdr_tail = ["lecteur", "essais", "1res images", "1re image méd. ms", "p90", "sauts", "seeked méd.", "p90", "reprise méd.", "p90", "sauts manqués", "attentes", "gels", "erreurs", "essais en échec"]
table("Par lecteur, profil réseau et décodage (essais de la règle, passes courte et complète)", ["réseau", "décodage"] + hdr_tail, group_table("", lambda r: (r["net"], r["decode"])))
table("Par titre (tous profils confondus)", ["titre"] + hdr_tail, group_table("", lambda r: (r["title"],)))
table("Par ordre des lecteurs (réseau « aucun »)", ["ordre", "réseau"] + hdr_tail, [row for row in group_table("", lambda r: (r["order"], r["net"])) if row[1] == "aucun"])

# La chronologie (étape 3e) : médianes des résumés par essai.
ck = ["firstReqMs", "firstVideoReadyMs", "firstVideoRecvMs", "seekedToAdvanceMs", "readyMaxMs", "videoAdvance", "recvAdvance", "aheadSeekedS", "aheadAdvanceS"]
cg = defaultdict(list)
for r in trials:
    if r.get("chrono") and is_rule(r):
        cg[(r["net"], r["decode"], r["player"])].append(r["chrono"])
table("Chronologie (médiane des résumés d'essai)", ["réseau", "décodage", "lecteur", "essais"] + ck,
      [list(k) + [len(v)] + [fmt(pct([c.get(f) for c in v], .5), 1) if any(c.get(f) is not None for c in v) else "—" for f in ck] for k, v in sorted(cg.items())])

# Les leviers et le son multiplexé : chaque essai de levier contre le témoin du même titre dans la même passe.
lever_rows = defaultdict(lambda: {"ff": [], "tf": [], "adv": [], "n": 0})
for r in trials:
    if r["pass"] in ("leviers", "multiplexé", "courte", "essai") and r["player"] == "serveur":
        tag = r["trial"].split("-serveur")[-1].strip("-") or "règle"
        k = (r["pass"], r["net"], r["title"], tag)
        lever_rows[k]["ff"].append(r["firstFrameMs"])
        lever_rows[k]["tf"].append(r["targetFrameMs"])
        lever_rows[k]["n"] += 1
for s in seeks:
    if s["pass"] in ("leviers", "multiplexé", "courte", "essai") and s["player"] == "serveur":
        tag = s["trial"].split("-serveur")[-1].strip("-") or "règle"
        k = (s["pass"], s["net"], s["title"], tag)
        if s.get("ok"):
            lever_rows[k]["adv"].append(s.get("advanceMs"))
table("Leviers de démarrage et son multiplexé (Lumen serveur)", ["passe", "réseau", "titre", "essai", "lectures", "1re image méd.", "image au départ méd.", "reprise méd.", "reprise p90", "sauts"],
      [list(k) + [v["n"], fmt(pct(v["ff"], .5)), fmt(pct(v["tf"], .5)), fmt(pct(v["adv"], .5)), fmt(pct(v["adv"], .9)), len(v["adv"])] for k, v in sorted(lever_rows.items()) if k[0] != "courte" or k[3] != "règle"])

# --- La consommation -------------------------------------------------------------------------------------------
samples = jl(os.path.join(WORK, "out/samples.jsonl"))


def at(t):
    """Le relevé le plus proche de t (ms)."""
    lo, hi = 0, len(samples) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if samples[mid]["t"] < t:
            lo = mid + 1
        else:
            hi = mid
    best = lo
    if lo > 0 and abs(samples[lo - 1]["t"] - t) < abs(samples[lo]["t"] - t):
        best = lo - 1
    return samples[best] if samples else None


def proc_kind(comm):
    c = comm.lower()
    if "webprocess" in c or c.startswith("wpewebprocess"):
        return "WebProcess"
    if "network" in c:
        return "NetworkProcess"
    if "gpuprocess" in c:
        return "GPUProcess"
    if c.startswith("node") or c == "mainthread":
        return "pilote Node (Playwright)"
    if "minibrowser" in c or "pw_run" in c or "playwright" in c:
        return "MiniBrowser (UI)"
    return comm


conso = []
for d, f in windows:
    if d["mode"] != "conso" or f["phase"] != "fin" or context_of(d["label"])["kind"] != "conso":
        continue
    a, b = at(d["t"]), at(f["t"])
    if not a or not b:
        continue
    secs = (b["t"] - a["t"]) / 1000
    played = f.get("playedS") or secs
    rec = {"label": d["label"], **context_of(d["label"]), "item": d.get("item"), "audio": d.get("audio"), "wallS": round(secs, 1), "playedS": played,
           "startMs": d.get("startMs"), "lag": f.get("lag"), "dropped": (f.get("s1") or {}).get("dropped"), "frames": (f.get("s1") or {}).get("frames"),
           "w": (f.get("s1") or {}).get("w"), "h": (f.get("s1") or {}).get("h")}
    window = [s for s in samples if a["t"] <= s["t"] <= b["t"]]
    rec["load"] = round(statistics.mean(s["load"][0] for s in window), 2) if window else None
    rec["loadMax"] = round(max(s["load"][0] for s in window), 2) if window else None
    for name, key in (("lumen-nuit-nav", "nav"), ("lumen-nuit-app", "app"), ("jellyfin", "jellyfin"), ("cine-app", "prod")):
        if name in a and name in b and a[name]["id"] == b[name]["id"]:
            used = (b[name]["usage"] - a[name]["usage"]) / 1e6
            rec[f"{key}CpuS"] = round(used, 2)
            rec[f"{key}CpuSperH"] = round(used / played * 3600, 1) if played else None
            mems = [s[name]["mem"] for s in window if name in s and s[name].get("mem")]
            if mems:
                rec[f"{key}MemMeanMB"] = round(statistics.mean(mems) / 2**20)
                rec[f"{key}MemMaxMB"] = round(max(mems) / 2**20)
    # Par processus du navigateur : les tops d'horloge entre les deux bornes (100 par seconde sur Linux).
    if "lumen-nuit-nav" in a and "lumen-nuit-nav" in b:
        pa = {p["pid"]: p for p in a["lumen-nuit-nav"].get("procs", [])}
        by = defaultdict(float)
        rss = defaultdict(int)
        for p in b["lumen-nuit-nav"].get("procs", []):
            base = pa.get(p["pid"], {"ticks": 0})["ticks"] if p["pid"] in pa else 0
            k = proc_kind(p["comm"])
            by[k] += (p["ticks"] - base) / 100
        for s in window:
            cur = defaultdict(int)
            for p in s.get("lumen-nuit-nav", {}).get("procs", []):
                cur[proc_kind(p["comm"])] += p["rss"]
            for k, v in cur.items():
                rss[k] = max(rss[k], v)
        rec["procsCpuS"] = {k: round(v, 2) for k, v in sorted(by.items(), key=lambda kv: -kv[1])}
        rec["procsRssMaxMB"] = {k: round(v / 2**20) for k, v in rss.items()}
        browser = sum(v for k, v in by.items() if not k.startswith("pilote"))
        rec["webkitCpuS"] = round(browser, 2)
        rec["webkitCpuSperH"] = round(browser / played * 3600, 1) if played else None
    # L'iGPU : moyenne de l'occupation de chaque moteur pendant la fenêtre (intel_gpu_top, global à la machine).
    gpu_file = os.path.join(WORK, "out", d["label"] + ".gpu.json")
    if os.path.exists(gpu_file):
        txt = open(gpu_file).read()
        # intel_gpu_top -J écrit des objets à la suite, et `docker logs` coupe son flux par blocs de 16 Ko : on lit les
        # occupations moteur par moteur (`"Video/0": { "busy": x`), sans relire le JSON entier.
        import re
        eng = defaultdict(list)
        for name, busy in re.findall(r'"([A-Za-z/0-9]+)":\s*\{\s*"busy":\s*([0-9.]+)', txt):
            eng[name].append(float(busy))
        pw = [float(x) for x in re.findall(r'"Package":\s*([0-9.]+)', txt)]
        rec["gpuBusy"] = {k: round(statistics.mean(v[1:] or v), 1) for k, v in eng.items()}
        if pw:
            rec["packageW"] = round(statistics.mean(pw[1:] or pw), 1)
    conso.append(rec)

with open(os.path.join(OUT, "conso.jsonl"), "w") as f:
    for r in conso:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

rows = []
for r in conso:
    rows.append([r["title"], r["player"], r["decode"], r["label"][-4:], fmt(r["playedS"]), fmt(r.get("webkitCpuSperH")), fmt(r.get("navCpuSperH")), fmt(r.get("appCpuSperH")),
                 fmt(r.get("jellyfinCpuSperH")), fmt(r.get("navMemMeanMB")), fmt(r.get("navMemMaxMB")), r.get("load"), (r.get("lag") or {}).get("n50"), r.get("dropped"),
                 json.dumps(r.get("procsCpuS"), ensure_ascii=False), json.dumps(r.get("gpuBusy"), ensure_ascii=False)])
table("Consommation, une ligne par lecture continue", ["titre", "lecteur", "décodage", "heure", "lu s", "WebKit CPU-s/h", "conteneur nav. CPU-s/h", "instance CPU-s/h", "Jellyfin CPU-s/h (machine)",
      "mém. nav. moy. Mo", "pic Mo", "charge moy.", "retards >50 ms", "images perdues", "par processus (CPU-s)", "iGPU % occupé"], rows)

open(os.path.join(OUT, "tableaux.md"), "w").write("\n".join(md) + "\n")
print(f"{len(trials)} lectures d'essai, {len(seeks)} sauts, {len(conso)} mesures de consommation → {OUT}")

# --- Redémarrage du serveur et son capté (essais à part) ---------------------------------------------------------
hote = jl(os.path.join(WORK, "out/marks-hote.jsonl"))
obs = [m for m in marks if str(m.get("phase", "")).startswith("obs-")]
rows = []
for m in obs:
    case = m["phase"][4:]
    srv = next((h for h in hote if h["label"] == m["label"] and h["phase"] == f"serveur-{case}"), None)
    down = srv["downMs"] if srv else None
    ev = " ".join(f"{e[1]}" for e in (m.get("events") or [])[:12])
    rows.append([m["label"], m.get("player"), case, down, m.get("stallMs"), m.get("endCt"), m.get("endErr") or "—", ev, " / ".join((m.get("logTail") or [])[-3:])[:200]])
if rows:
    md.append("")
    table("Redémarrage du serveur pendant la lecture", ["passage", "lecteur", "cas", "serveur rendu en ms", "arrêt de l'horloge ms", "position finale", "erreur finale", "évènements", "fin du journal de la page"], rows)
son_rows = []
for f in sorted(glob.glob(os.path.join(WORK, "out", "son-*.verdict.json"))):
    try:
        v = json.loads(open(f).read())
    except Exception:
        continue
    son_rows.append([os.path.basename(f)[4:-13], v.get("firstTrack"), json.dumps(v.get("summary"), ensure_ascii=False), v.get("decidedShare"), v.get("lagMs"), v.get("lagScore"), json.dumps(v.get("switches"), ensure_ascii=False)[:200]])
if son_rows:
    table("Son réellement joué (capté par Web Audio, comparé aux pistes du fichier)", ["capture", "piste reconnue", "fenêtres de 0,5 s", "part tranchée", "décalage ms", "score", "changements"], son_rows)
open(os.path.join(OUT, "tableaux.md"), "w").write("\n".join(md) + "\n")
