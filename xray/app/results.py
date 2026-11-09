"""Assemblage du résultat : des tronçons faits, des plans et des pistes jusqu'aux scènes.

Refait à chaque tronçon terminé : un regroupement fait sur plus de pistes est meilleur, et un
nom donné tôt peut changer ensuite. Le résultat partiel est donc toujours le meilleur possible
avec ce qui a été vu.

Deux façons de le faire, pour le même résultat :

- `build` recalcule tout depuis les pistes et les plans (la référence, `XRAY_INCREMENTAL=0`) ;
- `Assembler` (par défaut) garde d'un tronçon à l'autre ce qui ne change pas : la matrice des
  similarités entre pistes, dont seules les lignes des pistes nouvelles sont calculées (un
  produit matriciel), et les ressemblances de couleurs entre plans et entre scènes
  (`shots.CachedSimilarity`). Le regroupement (lien moyen), les noms et les scènes sont refaits
  à chaque fois : une piste nouvelle peut tout changer.

Mesuré le 09/11/2026 : sur *Bullet Train* (64 tronçons, ~3 000 pistes), refaire `build` à chaque
tronçon coûtait ~25 s au total, dont les trois quarts en calculs répétés à l'identique (distances
`pdist`, notes groupe × acteur une à une, ressemblances de plans) ; l'assemblage incrémental est
3 à 6 fois moins cher, scènes identiques à l'octet près sur les cinq titres du banc
(`test_results.py` le vérifie sur des données synthétiques, tronçon par tronçon).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .cluster import Assignment, PersonRefs, cluster_embeddings, label_clusters, labels_from_linkage
from .faces import normalize
from .shots import CachedSimilarity, ShotInfo, Similarity, group_scenes


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
    # « Qui parle » (11/2026) : qui est à l'image, plan par plan — (début, fin, personId, part du plan
    # où on le voit), la plus grande de ses pistes du plan. Ce que `voices.py` compare aux voix.
    presence: list = field(default_factory=list)


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
    labels = cluster_embeddings(np.stack([t.emb for t in tracks]), cluster_threshold) if tracks else None
    return _assemble(duration, done_chunks, total_chunks, anchor, shots, tracks, labels, refs,
                     label_threshold, cluster_threshold, None)


def _assemble(
    duration: float,
    done_chunks: list[tuple[float, float]],
    total_chunks: int,
    anchor: float,
    shots: list[ShotRow],
    tracks: list[TrackRow],
    labels: np.ndarray | None,
    refs: list[PersonRefs],
    label_threshold: float,
    cluster_threshold: float,
    sim: Similarity | None,
) -> Built:
    """Le résultat, une fois les pistes regroupées (`labels`, rangs par première apparition)."""
    intervals = merge_intervals(done_chunks)
    complete = total_chunks > 0 and len(done_chunks) >= total_chunks
    done_time = sum(min(e, duration) - s for s, e in intervals)
    progress = 1.0 if complete else (min(1.0, done_time / duration) if duration > 0 else 0.0)
    until = round(duration, 3) if complete else analyzed_until(intervals, anchor)

    # 1. Groupes de pistes (personnes), et leurs noms.
    if tracks:
        embs = np.stack([t.emb for t in tracks])
        assert labels is not None
        k = int(labels.max()) + 1
        centroids = np.zeros((k, embs.shape[1]), dtype=np.float32)
        ctime = np.zeros(k, dtype=np.float64)
        for t, l in zip(tracks, labels):
            w = max(t.quality, 1e-3) * max(t.screen_time, 0.1)
            centroids[l] += t.emb * w
            ctime[l] += t.screen_time
        centroids = normalize(centroids)
        assignments = label_clusters(centroids, ctime, refs, label_threshold, cluster_threshold,
                                     np.bincount(labels, minlength=k))
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
        for scene in group_scenes(part, sim=sim):
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
    shown: dict[tuple[float, float, int], float] = {}
    for i, t in enumerate(tracks):
        asg = assignments.get(int(labels[i]))
        if asg is None:
            continue
        key = (t.shot_start, t.shot_end, asg.person_id)
        frac = min(1.0, t.screen_time / max(t.shot_end - t.shot_start, 1e-3))
        shown[key] = max(shown.get(key, 0.0), frac)
    presence = sorted((a, b, pid, f) for (a, b, pid), f in shown.items())
    return Built(scenes_out, until, round(progress, 4), complete, assignments, centroids, ctime, presence)


class Assembler:
    """`build`, tronçon après tronçon, sans refaire ce qui ne change pas (voir l'en-tête).

    Les pistes sont ajoutées dans l'ordre où `build` les lirait (l'ordre d'écriture en base) :
    l'ordre fixe la numérotation des groupes, donc le départage à notes égales."""

    def __init__(self, duration: float, total_chunks: int, anchor: float, refs: list[PersonRefs],
                 label_threshold: float, cluster_threshold: float):
        self.duration, self.total, self.anchor = duration, total_chunks, anchor
        self.refs, self.label_t, self.cluster_t = refs, label_threshold, cluster_threshold
        self.done: list[tuple[float, float]] = []
        self.shots: list[ShotRow] = []
        self.tracks: list[TrackRow] = []
        self._unit = np.zeros((0, 512), dtype=np.float64)  # empreintes normalisées
        self._sims = np.zeros((0, 0), dtype=np.float64)    # similarités cosinus entre pistes
        self.sim = CachedSimilarity()

    def add(self, done: list[tuple[float, float]], shots: list[ShotRow], tracks: list[TrackRow]) -> None:
        """`done` : toutes les plages faites ; `shots`, `tracks` : seulement les nouveaux."""
        self.done = list(done)
        self.shots += shots
        if not tracks:
            return
        new = normalize(np.stack([t.emb for t in tracks]).astype(np.float64))
        n0 = len(self._unit)
        unit = np.vstack([self._unit, new])
        sims = np.empty((len(unit), len(unit)), dtype=np.float64)
        sims[:n0, :n0] = self._sims
        cross = new @ unit.T  # lignes des pistes nouvelles, contre toutes
        sims[n0:, :] = cross
        sims[:n0, n0:] = cross[:, :n0].T
        self._unit, self._sims = unit, sims
        self.tracks += tracks

    def labels(self) -> np.ndarray | None:
        n = len(self.tracks)
        if n == 0:
            return None
        if n == 1:
            return np.zeros(1, dtype=np.int64)
        iu = np.triu_indices(n, 1)
        return labels_from_linkage(np.clip(1.0 - self._sims[iu], 0.0, 2.0), self.cluster_t)

    def build(self) -> Built:
        return _assemble(self.duration, self.done, self.total, self.anchor, self.shots, self.tracks,
                         self.labels(), self.refs, self.label_t, self.cluster_t, self.sim)
