#!/usr/bin/env python3
"""Normalise ce qu'un passage du banc a recueilli (brut.json) en ce que deux passages doivent partager.

Gardé : les genres de lignes, le chemin pris (remux / serveur), les relais et leurs motifs, les
erreurs et les chaînes de refus (exactes : la page Activité les regroupe par elles), les pistes
choisies et ce qui a été fait du son, `openedFrom`, les motifs de reconstruction, les compteurs du
bilan `stop` (sauts, changements de piste, arrière-plans, reconstructions) et, par paliers, les
attentes. Et, côté navigateur, l'issue de chaque étape du parcours.

Écarté : horodatages, identifiants de séance, build et version, agent, toutes les durées en ms, les
débits, la réserve, `diag.*`, `timeline`, `steps` (la trace), les positions exactes.

Mis à part (`volatil`, affiché par la comparaison, jamais compté comme un écart) : ce qui dépend de
la charge de la machine et non du code, mesuré en passant deux fois le même commit — les lignes
`stall`, les `waits` et `recoveries` du bilan, et les `seeks` du lecteur serveur (hls.js en
compte un nombre variable pour un même geste).

Les lignes d'une séance sont rangées par genre (dans un ordre fixe), puis dans leur ordre d'écriture :
l'instant où part `opening` par rapport aux premiers sauts dépend de la machine, pas du code.

Usage : normalise.py <dossier de résultats>   (lit brut.json, écrit normalise.json et couverture.txt)
"""
import json
import os
import re
import sys

COMMON = ("path", "player", "container", "video", "range", "cast", "target")
KEEP = {
    "start": ("reason", "why", "hls", "rebuild", "openedFrom", "hdrLightCap", "hdrChoice", "displayHdr",
              "wideGamut", "audioStreamIndex", "retry", "rung", "trigger", "dialogue", "error"),
    "opening": (),
    "seek": ("superseded", "arrived"),
    "audio": ("from", "to", "via", "fromTrack", "toTrack", "applied", "processing", "reason"),
    "fallback": ("reason", "takeover.audioStreamIndex", "takeover.subtitleStreamIndex", "takeover.cast"),
    "error": ("reason", "startup.stage", "mediaError"),
    "rebuild": ("reason", "source", "attempt"),
    "network": ("reason",),
    "stall": (),
    "stop": ("why", "ended", "rebuild", "audio", "audioSwitches", "subtitleSwitches", "seeks", "backgrounds",
             "backgroundRebuilds", "restarts", "restartWhy", "error", "identicalRetries", "resumeFix",
             "startup.stage"),
    "cast": ("event",),
    "reserve": ("event", "message"),
    "subtitle-gen": ("event", "status"),
}
ORDER = ["start", "opening", "seek", "audio", "rebuild", "network", "stall", "fallback", "error", "cast", "stop"]


def bucket(n, edges):
    """0, puis des paliers : `1-2`, `3-5`, `6+`…"""
    if not isinstance(n, (int, float)):
        return n
    if n <= 0:
        return "0"
    lo = 1
    for hi in edges:
        if n <= hi:
            return f"{lo}-{hi}" if lo != hi else str(hi)
        lo = hi + 1
    return f"{lo}+"


def normalise_line(raw):
    kind = raw.get("kind")
    out = {"kind": kind}
    for k in COMMON + KEEP.get(kind, ()):
        if k in raw:
            out[k] = raw[k]
    # Ce qui compte d'une position, c'est début ou pas.
    if kind == "start":
        out["at"] = "0" if not raw.get("at") else ">0"
        if "deviceBytes" in raw:
            out["deviceBytes"] = "0" if not raw["deviceBytes"] else ">0"
    if kind == "stop":
        if "evictions" in raw:
            out["evictions"] = "0" if not raw["evictions"] else ">0"
        if raw.get("player") == "serveur":
            out.pop("seeks", None)
    if kind == "seek" and "buffered" in raw:
        out["buffered"] = raw["buffered"]
    if kind == "reserve" and raw.get("event") not in ("erreur", "arrêt"):
        return None
    return out


def normalise_server(raw):
    msg = str(raw.get("message") or raw.get("error") or raw.get("msg") or "")
    msg = re.sub(r"\d+(\.\d+)?", "#", msg.split("\n")[0])[:160]
    return {"scope": raw.get("scope"), "context": raw.get("context") or raw.get("where"), "message": msg}


def normalise_case(case):
    lines = []
    volatile = {"stalls": 0, "waits": 0, "recoveries": 0, "serverSeeks": 0}
    for text in case.get("playerLines", []):
        try:
            raw = json.loads(text)
        except ValueError:
            continue
        if raw.get("kind") == "stall":
            volatile["stalls"] += 1
            continue
        if raw.get("kind") == "stop":
            volatile["waits"] += raw.get("waits") or 0
            volatile["recoveries"] += raw.get("recoveries") or 0
            if raw.get("player") == "serveur":
                volatile["serverSeeks"] += raw.get("seeks") or 0
        n = normalise_line(raw)
        if n:
            lines.append(n)
    rank = {k: i for i, k in enumerate(ORDER)}
    lines = [l for _, l in sorted(enumerate(lines), key=lambda p: (rank.get(p[1]["kind"], len(ORDER)), p[0]))]
    server = []
    for text in case.get("serverLines", []):
        try:
            server.append(normalise_server(json.loads(text)))
        except ValueError:
            continue
    steps = [{k: v for k, v in s.items()} for s in case.get("steps", [])]
    return {"steps": steps, "lines": lines, "server": server, "volatil": volatile}


def coverage(case, norm):
    starts = [l for l in norm["lines"] if l["kind"] == "start"]
    first = starts[0] if starts else {}
    video = next((l["video"] for l in norm["lines"] if l.get("video")), "—")
    path = first.get("path", "—")
    paths = sorted({l.get("path") for l in starts if l.get("path")})
    fallbacks = [l.get("reason") for l in norm["lines"] if l["kind"] == "fallback"]
    audio = [f'{l.get("fromTrack")} → {l.get("toTrack")} : {l.get("processing")}' if l.get("applied") else f'refusé ({l.get("reason")})' for l in norm["lines"] if l["kind"] == "audio"]
    src = next((s.get("source") for s in norm["steps"] if s.get("source")), "—")
    failed = [f'{s["step"]}: {s["outcome"]}' for s in norm["steps"] if s["outcome"] not in ("fait", "choisi", "allumés puis éteints")]
    return (f'{case["profile"]:<9} {case["key"]:<15} {video:<26} chemin {"/".join(paths) or path:<13} '
            f'élément {src:<5} relais {"; ".join(fallbacks) or "—"} | son {"; ".join(audio) or "—"}'
            + (f' | étapes : {"; ".join(failed)}' if failed else ""))


def main():
    out = sys.argv[1]
    cases = json.load(open(os.path.join(out, "brut.json")))
    titles = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "titres.json")))
    unstable = {t["key"]: t.get("instable", []) for t in titles}
    result, cov = {}, []
    for case in cases:
        norm = normalise_case(case)
        # Un profil où ce titre s'est montré instable entre deux passages du même commit (titres.json) :
        # ses écarts sont affichés, pas comptés.
        norm["instable"] = case["profile"] in unstable.get(case["key"], [])
        result[f'{case["profile"]}/{case["key"]}'] = norm
        cov.append(coverage(case, norm))
    versions = sorted({f'{c["profile"]} {c.get("version", "?")}' for c in cases})
    json.dump(result, open(os.path.join(out, "normalise.json"), "w"), ensure_ascii=False, indent=1, sort_keys=True)
    with open(os.path.join(out, "couverture.txt"), "w") as f:
        f.write("Navigateurs : " + ", ".join(versions) + "\n\n" + "\n".join(cov) + "\n")
    print(open(os.path.join(out, "couverture.txt")).read())


if __name__ == "__main__":
    main()
