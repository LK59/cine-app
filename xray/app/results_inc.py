"""Assemblage incrémental (essai 11/2026) : le même résultat que `results.build`, sans tout refaire
à chaque tronçon.

Mesuré sur Bullet Train (64 tronçons, ~3 000 pistes) : `build` refait à chaque tronçon coûtait
~25 s au total, dont les trois quarts en calculs répétés à l'identique :

- les distances cosinus entre pistes (`pdist`, boucle scalaire de SciPy) — ici une matrice de
  similarités tenue à jour : seules les lignes des pistes nouvelles sont calculées (produit
  matriciel), la liaison moyenne repart de cette matrice ;
- les notes groupe × acteur, une boucle Python par couple — ici un produit matriciel par acteur ;
- les ressemblances de couleurs entre plans, recalculées à chaque regroupement en scènes — ici
  gardées d'un tronçon à l'autre (elles ne dépendent que des deux plans).

Le regroupement lui-même (liaison moyenne) et le découpage en scènes sont refaits : un tronçon
nouveau peut changer les groupes et donc les scènes. La règle est celle de `results.build`.
"""

from __future__ import annotations

import numpy as np

from . import shots as shotsmod
from .cluster import (DOUBT_GAP, DOUBT_MARGIN, DOUBT_MIN_TIME, DOUBT_MIN_TRACKS, SECOND_PASS_MIN_TIME,
                      SURE_MARGIN, TOP_K, TWIN_MARGIN, Assignment, PersonRefs, confidence)
from .faces import normalize
from .results import Built, ShotRow, TrackRow, analyzed_until, merge_intervals
from .shots import ShotInfo


def _scores(centroids: np.ndarray, refs: list[PersonRefs]) -> tuple[np.ndarray, np.ndarray]:
    k, p = len(centroids), len(refs)
    score = np.full((k, p), -1.0)
    photo = np.full((k, p), -1.0)
    for j, ref in enumerate(refs):
        if len(ref.photos):
            sims = -np.sort(-(centroids @ ref.photos.T), axis=1)  # (k, m), décroissant
            photo[:, j] = sims[:, :min(TOP_K, sims.shape[1])].mean(axis=1)
        series = (centroids @ ref.series) if ref.series is not None else np.full(k, -1.0)
        score[:, j] = np.maximum(photo[:, j], series)
    return score, photo


def label_clusters_fast(centroids, weights, refs, threshold, cluster_threshold, tracks=None):
    """`cluster.label_clusters`, notes calculées par produits matriciels, acceptation vectorisée."""
    k, p = len(centroids), len(refs)
    if k == 0 or p == 0:
        return {}
    from scipy.optimize import linear_sum_assignment

    if tracks is None:
        tracks = np.zeros(k, dtype=np.int64)
    centroids = normalize(centroids.astype(np.float32))
    score, photo = _scores(centroids, refs)
    # Meilleure note d'un *autre* acteur, pour chaque case.
    if p >= 2:
        order = np.argsort(-score, axis=1, kind="stable")
        top1 = score[np.arange(k), order[:, 0]]
        top2 = score[np.arange(k), order[:, 1]]
        runner = np.where(np.arange(p)[None, :] == order[:, :1], top2[:, None], top1[:, None])
    else:
        runner = np.zeros((k, p))
    seen_ok = (weights[:, None] >= DOUBT_MIN_TIME) | (tracks[:, None] >= DOUBT_MIN_TRACKS)
    ok = (score >= threshold + SURE_MARGIN) | (
        (score >= threshold + DOUBT_MARGIN) & (score - np.maximum(runner, 0.0) >= DOUBT_GAP) & seen_ok)
    w = 1.0 + 0.05 * np.log1p(np.maximum(weights, 0.0))[:, None]
    gain = np.where(ok, score * w, 0.0)
    rows, cols = linear_sum_assignment(-gain)
    out: dict[int, Assignment] = {}
    for i, j in zip(rows, cols):
        if ok[i, j]:
            out[int(i)] = Assignment(refs[j].person_id, float(score[i, j]), confidence(score[i, j], threshold),
                                     float(photo[i, j]))
    named = {a.person_id: i for i, a in out.items()}
    for i in range(k):
        if i in out or float(weights[i]) < SECOND_PASS_MIN_TIME:
            continue
        j = int(np.argmax(score[i]))
        pid = refs[j].person_id
        if pid not in named:
            continue
        s = float(score[i, j])
        if s >= threshold + SURE_MARGIN:
            if float(centroids[i] @ centroids[named[pid]]) < cluster_threshold - TWIN_MARGIN:
                continue
        elif not ok[i, j]:
            continue
        out[i] = Assignment(pid, s, confidence(s, threshold), float(photo[i, j]))
    return out


class IncrementalBuilder:
    def __init__(self, duration, total_chunks, anchor, refs, label_threshold, cluster_threshold):
        self.duration, self.total, self.anchor = duration, total_chunks, anchor
        self.refs, self.label_t, self.cluster_t = refs, label_threshold, cluster_threshold
        self.done: list[tuple[float, float]] = []
        self.shots: list[ShotRow] = []
        self.tracks: list[TrackRow] = []
        self.E = np.zeros((0, 512))
        self.S = np.zeros((0, 0))
        self._sim: dict[tuple[float, float], float] = {}
        self._hist_ids: set[int] = set()
        self._scene_hists: dict = {}

    def add_chunk(self, interval, shots: list[ShotRow], tracks: list[TrackRow]) -> Built:
        self.done.append(interval)
        self.shots += shots
        for s in shots:
            self._hist_ids.add(id(s.hist))
        if tracks:
            new = normalize(np.stack([t.emb for t in tracks]).astype(np.float64))
            n0 = len(self.E)
            E = np.vstack([self.E, new])
            S = np.empty((len(E), len(E)))
            S[:n0, :n0] = self.S
            cross = new @ E.T
            S[n0:, :] = cross
            S[:, n0:] = cross.T
            self.E, self.S = E, S
            self.tracks += tracks
        return self._build()

    def _cluster(self) -> np.ndarray:
        n = len(self.tracks)
        if n == 0:
            return np.zeros(0, dtype=np.int64)
        if n == 1:
            return np.zeros(1, dtype=np.int64)
        from scipy.cluster.hierarchy import fcluster, linkage

        iu = np.triu_indices(n, 1)
        d = np.clip(1.0 - self.S[iu], 0.0, 2.0)
        z = linkage(d, method="average")
        labels = fcluster(z, t=1.0 - self.cluster_t, criterion="distance")
        order: dict[int, int] = {}
        out = np.empty(n, dtype=np.int64)
        for i, l in enumerate(labels):
            out[i] = order.setdefault(int(l), len(order))
        return out

    def _build(self) -> Built:
        duration, tracks = self.duration, self.tracks
        intervals = merge_intervals(self.done)
        complete = self.total > 0 and len(self.done) >= self.total
        done_time = sum(min(e, duration) - s for s, e in intervals)
        progress = 1.0 if complete else (min(1.0, done_time / duration) if duration > 0 else 0.0)
        until = round(duration, 3) if complete else analyzed_until(intervals, self.anchor)
        if tracks:
            embs = np.stack([t.emb for t in tracks])
            labels = self._cluster()
            k = int(labels.max()) + 1
            centroids = np.zeros((k, embs.shape[1]), dtype=np.float32)
            ctime = np.zeros(k, dtype=np.float64)
            for t, l in zip(tracks, labels):
                w = max(t.quality, 1e-3) * max(t.screen_time, 0.1)
                centroids[l] += t.emb * w
                ctime[l] += t.screen_time
            centroids = normalize(centroids)
            assignments = label_clusters_fast(centroids, ctime, self.refs, self.label_t, self.cluster_t,
                                              np.bincount(labels, minlength=k))
        else:
            labels = np.zeros(0, dtype=np.int64)
            centroids = np.zeros((0, 512), dtype=np.float32)
            ctime = np.zeros(0)
            assignments = {}
        by_shot: dict[float, list[int]] = {}
        for idx, t in enumerate(tracks):
            by_shot.setdefault(round(t.shot_start, 3), []).append(idx)
        infos = sorted(
            (ShotInfo(s.start, s.end, s.hist, {int(labels[i]) for i in by_shot.get(round(s.start, 3), [])},
                      {assignments[int(labels[i])].person_id for i in by_shot.get(round(s.start, 3), [])
                       if int(labels[i]) in assignments}) for s in self.shots),
            key=lambda s: s.start,
        )
        scenes_out: list[dict] = []
        orig = shotsmod.hist_similarity
        orig_sh = shotsmod._scene_hist
        shotsmod.hist_similarity = self._cached_similarity(orig)
        shotsmod._scene_hist = self._cached_scene_hist(orig_sh)
        try:
            for a, b in intervals:
                part = [s for s in infos if a - 1e-3 <= s.start < b]
                for scene in shotsmod.group_scenes(part):
                    start, end = scene[0].start, min(scene[-1].end, b)
                    people: dict[int, dict] = {}
                    for s in scene:
                        for i in by_shot.get(round(s.start, 3), []):
                            asg = assignments.get(int(labels[i]))
                            if asg is None:
                                continue
                            p = people.setdefault(asg.person_id, {"personId": asg.person_id, "screenTime": 0.0,
                                                                  "confidence": asg.confidence})
                            p["screenTime"] += tracks[i].screen_time
                    plist = []
                    for p in people.values():
                        p["screenTime"] = round(min(p["screenTime"], end - start), 3)
                        p["confidence"] = round(p["confidence"], 3)
                        plist.append(p)
                    plist.sort(key=lambda p: (-p["screenTime"], -p["confidence"], p["personId"]))
                    scenes_out.append({"start": round(start, 3), "end": round(end, 3), "people": plist})
        finally:
            shotsmod.hist_similarity = orig
            shotsmod._scene_hist = orig_sh
        scenes_out.sort(key=lambda s: s["start"])
        return Built(scenes_out, until, round(progress, 4), complete, assignments, centroids, ctime)

    def _cached_scene_hist(self, orig):
        """Couleur moyenne d'une suite de plans contigus : la même suite (premier, dernier, nombre)
        donne la même valeur d'un tronçon à l'autre. Le tableau rendu est enregistré comme
        persistant, pour que ses ressemblances soient gardées elles aussi."""
        cache, ids = self._scene_hists, self._hist_ids

        def sh(scene):
            key = (scene[0].start, scene[-1].start, len(scene))
            v = cache.get(key)
            if v is None:
                v = cache[key] = orig(scene)
                ids.add(id(v))
            return v

        return sh

    def _cached_similarity(self, orig):
        cache, ids = self._sim, self._hist_ids

        def sim(a, b):
            if id(a) in ids and id(b) in ids:
                key = (id(a), id(b))
                v = cache.get(key)
                if v is None:
                    v = cache[key] = orig(a, b)
                return v
            return orig(a, b)

        return sim
