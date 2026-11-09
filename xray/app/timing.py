"""Où passe le temps : un chronomètre par étape, gardé avec chaque tronçon.

Chaque tronçon note ses secondes par étape (décodage, plans, détection, empreinte…) et ses
comptes (images décodées, analysées, visages empreintés) ; l'ordre y ajoute ce qui ne
dépend d'aucun tronçon (photos de la distribution, assemblage des scènes). La somme est
écrite dans le journal à la fin de l'ordre et rendue par `GET /items/{id}` (`stats`).

Sans ces chiffres, « l'analyse est lente » ne disait pas *quoi* : le 09/11/2026, avant toute
optimisation, la détection et l'empreinte se partageaient presque tout le temps, le
décodage sur l'iGPU presque rien (voir README, « Performances »).

Un appel à `perf_counter` coûte une centaine de nanosecondes : le chronomètre reste en place.
"""

from __future__ import annotations

import json
import time
from contextlib import contextmanager

# Étapes, dans l'ordre où le journal les écrit.
#   decode_wait : le fil de l'ouvrier attend une image de ffmpeg (le décodage court en parallèle :
#                 seul ce qu'il fait *attendre* coûte au total) ;
#   shots       : signatures et coupes ;      convert : NV12 → BGR des images analysées ;
#   detect      : détecteur de visages ;      grade   : alignement, netteté, frontalité ;
#   embed       : réseau d'empreinte ;        track   : pistes dans un plan ;
#   write       : écriture du tronçon ;       build   : regroupement, noms, scènes ;
#   photos      : photos de la distribution (téléchargement et empreinte).
STAGES = ("decode_wait", "shots", "convert", "detect", "grade", "embed", "track", "write", "build", "photos")


class StageClock:
    def __init__(self) -> None:
        self.seconds: dict[str, float] = {}
        self.counts: dict[str, int] = {}

    @contextmanager
    def stage(self, name: str):
        t0 = time.perf_counter()
        try:
            yield
        finally:
            self.add(name, time.perf_counter() - t0)

    def add(self, name: str, seconds: float) -> None:
        self.seconds[name] = self.seconds.get(name, 0.0) + seconds

    def count(self, name: str, n: int = 1) -> None:
        self.counts[name] = self.counts.get(name, 0) + n

    def as_dict(self) -> dict:
        return {"seconds": {k: round(v, 3) for k, v in self.seconds.items()}, "counts": dict(self.counts)}

    def merge(self, other: dict | None) -> None:
        if not other:
            return
        for k, v in (other.get("seconds") or {}).items():
            self.add(k, float(v))
        for k, v in (other.get("counts") or {}).items():
            self.count(k, int(v))


INNER = ("decode_wait", "shots", "convert", "detect", "grade", "embed", "track")


def summary(clock: StageClock, duration: float) -> dict:
    """Ce que rend l'API : secondes par étape, total, × temps réel.

    `wall` est la durée de l'analyse des tronçons (décodage compris) ; s'y ajoutent l'écriture,
    l'assemblage et les photos. `other` est ce que l'analyse a coûté hors des étapes nommées."""
    sec = clock.seconds
    wall = sec.get("wall", 0.0)
    stages = {k: round(sec[k], 1) for k in STAGES if k in sec}
    if wall:
        stages["other"] = round(max(0.0, wall - sum(sec.get(k, 0.0) for k in INNER)), 1)
    total = wall + sum(sec.get(k, 0.0) for k in STAGES if k not in INNER)
    out = {
        "seconds": round(total, 1),
        "realtime": round(duration / total, 2) if total > 0 and duration else None,
        "stages": stages,
        "counts": dict(clock.counts),
    }
    if sec.get("skipped"):
        out["skippedSeconds"] = round(sec["skipped"], 1)  # vidéo sautée (génériques, rappel)
    if "decode" in sec:
        out["decodeSeconds"] = round(sec["decode"], 1)  # ffmpeg de bout en bout, en parallèle
    return out


def line(d: dict) -> str:
    """Une ligne lisible pour le journal : `détection 120 s (41 %) · empreinte …`."""
    names = {"decode_wait": "attente décodage", "shots": "plans", "convert": "conversion", "detect": "détection",
             "grade": "tri", "embed": "empreinte", "track": "pistes", "write": "écriture", "build": "assemblage",
             "photos": "photos", "other": "reste"}
    total = d.get("seconds") or 0.0
    parts = []
    for k, v in d.get("stages", {}).items():
        if v >= 0.05:
            parts.append(f"{names.get(k, k)} {v:.1f} s ({100 * v / total:.0f} %)" if total else f"{names.get(k, k)} {v:.1f} s")
    return " · ".join(parts)


def job_stats(db, item_id: str, duration: float) -> dict:
    """Somme des chronomètres des tronçons et de l'ordre (voir `timing`)."""
    acc = StageClock()
    for r in db.q("SELECT stats FROM chunks WHERE item_id=? AND stats IS NOT NULL", (item_id,)):
        acc.merge(json.loads(r["stats"]))
    row = db.one("SELECT stats_json FROM items WHERE item_id=?", (item_id,))
    if row is not None and row["stats_json"]:
        acc.merge(json.loads(row["stats_json"]))
    return summary(acc, duration)
