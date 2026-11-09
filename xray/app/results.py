"""Assemblage du résultat : des tronçons faits, des plans et des pistes jusqu'aux scènes.

Recalculé en entier à chaque tronçon terminé (quelques millisecondes pour un épisode) : un
regroupement fait sur plus de pistes est meilleur, et un nom donné tôt peut changer ensuite.
Le résultat partiel est donc toujours le meilleur possible avec ce qui a été vu.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .cluster import Assignment, PersonRefs, cluster_embeddings, label_clusters
from .faces import normalize
from .shots import ShotInfo, group_scenes


@dataclass
class TrackRow:
    shot_start: float
    shot_end: float
    screen_time: float
    quality: float
    emb: np.ndarray


@dataclass
class ShotRow:
    start: float
    end: float
    hist: np.ndarray


@dataclass
class Built:
    scenes: list[dict]
    analyzed_until: float
    progress: float
    complete: bool
    assignments: dict[int, Assignment] = field(default_factory=dict)
    centroids: np.ndarray | None = None
    cluster_time: np.ndarray | None = None


def merge_intervals(chunks: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[list[float]] = []
    for s, e in sorted(chunks):
        if out and s <= out[-1][1] + 1e-3:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(a, b) for a, b in out]


def analyzed_until(intervals: list[tuple[float, float]], anchor: float) -> float:
    """Fin de la plage analysée d'un seul tenant qui contient `anchor` (le début du tronçon de
    `startAt`) ; 0 tant que ce tronçon n'est pas fait. Laterna sait ainsi jusqu'où, à partir de
    là où l'on regarde, les scènes sont prêtes."""
    for s, e in intervals:
        if s <= anchor + 1e-3 and anchor < e:
            return e
    return 0.0


def build(
    duration: float,
    done_chunks: list[tuple[float, float]],
    total_chunks: int,
    anchor: float,
    shots: list[ShotRow],
    tracks: list[TrackRow],
    refs: list[PersonRefs],
    label_threshold: float,
    cluster_threshold: float,
) -> Built:
    intervals = merge_intervals(done_chunks)
    complete = total_chunks > 0 and len(done_chunks) >= total_chunks
    done_time = sum(min(e, duration) - s for s, e in intervals)
    progress = 1.0 if complete else (min(1.0, done_time / duration) if duration > 0 else 0.0)
    until = round(duration, 3) if complete else analyzed_until(intervals, anchor)

    # 1. Regroupement de toutes les pistes vues jusqu'ici.
    if tracks:
        embs = np.stack([t.emb for t in tracks])
        labels = cluster_embeddings(embs, cluster_threshold)
        k = int(labels.max()) + 1
        centroids = np.zeros((k, embs.shape[1]), dtype=np.float32)
        ctime = np.zeros(k, dtype=np.float64)
        for t, l in zip(tracks, labels):
            w = max(t.quality, 1e-3) * max(t.screen_time, 0.1)
            centroids[l] += t.emb * w
            ctime[l] += t.screen_time
        centroids = normalize(centroids)
        assignments = label_clusters(centroids, ctime, refs, label_threshold, cluster_threshold)
    else:
        labels = np.zeros(0, dtype=np.int64)
        centroids = np.zeros((0, 512), dtype=np.float32)
        ctime = np.zeros(0)
        assignments = {}

    # 2. Plans → scènes, plage par plage (deux plages disjointes ne partagent aucune scène).
    by_shot: dict[float, list[int]] = {}
    for idx, t in enumerate(tracks):
        by_shot.setdefault(round(t.shot_start, 3), []).append(idx)
    infos = sorted(
        (ShotInfo(s.start, s.end, s.hist, {int(labels[i]) for i in by_shot.get(round(s.start, 3), [])}) for s in shots),
        key=lambda s: s.start,
    )
    scenes_out: list[dict] = []
    for a, b in intervals:
        part = [s for s in infos if a - 1e-3 <= s.start < b]
        for scene in group_scenes(part):
            start, end = scene[0].start, min(scene[-1].end, b)
            people: dict[int, dict] = {}
            for s in scene:
                for i in by_shot.get(round(s.start, 3), []):
                    asg = assignments.get(int(labels[i]))
                    if asg is None:
                        continue  # anonyme : jamais montré
                    p = people.setdefault(asg.person_id, {"personId": asg.person_id, "screenTime": 0.0,
                                                          "confidence": asg.confidence})
                    p["screenTime"] += tracks[i].screen_time
            # Une personne vue deux fois dans le même plan (deux pistes) ne compte pas double :
            # le temps de présence est borné par la durée de la scène.
            plist = []
            for p in people.values():
                p["screenTime"] = round(min(p["screenTime"], end - start), 3)
                p["confidence"] = round(p["confidence"], 3)
                plist.append(p)
            plist.sort(key=lambda p: (-p["screenTime"], -p["confidence"], p["personId"]))
            scenes_out.append({"start": round(start, 3), "end": round(end, 3), "people": plist})
    scenes_out.sort(key=lambda s: s["start"])
    return Built(scenes_out, until, round(progress, 4), complete, assignments, centroids, ctime)
