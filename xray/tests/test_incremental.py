"""Assemblage incrémental : à chaque tronçon, exactement le résultat du recalcul complet."""

import json

import numpy as np
import pytest

from app.cluster import (PersonRefs, _runner_up, acceptable, confidence, label_clusters, person_score)
from app.faces import normalize
from app.results import Assembler, ShotRow, TrackRow, build
from conftest import noisy, unit
from test_results import hist


def _episode(seed=20, chunks=8, step=120.0):
    """Un épisode synthétique, tronçon par tronçon : des décors, des personnages de la
    distribution (dont deux qui se ressemblent), des inconnus, des plans sans personne."""
    rng = np.random.default_rng(seed)
    people = [unit(rng) for _ in range(6)]
    people[5] = noisy(rng, people[4], 0.9)  # deux acteurs proches
    strangers = [unit(rng) for _ in range(3)]
    rooms = [hist(rng) for _ in range(5)]
    out = []
    for c in range(chunks):
        t, end = c * step, (c + 1) * step
        shots, tracks = [], []
        room = rooms[int(rng.integers(0, len(rooms)))]
        while t < end - 1e-6:
            d = float(min(end - t, rng.choice([1.5, 2.5, 4.0, 7.0, 12.0])))
            if rng.random() < 0.15:
                room = rooms[int(rng.integers(0, len(rooms)))]
            shots.append(ShotRow(round(t, 3), round(t + d, 3), hist(rng, room, 0.02)))
            for _ in range(int(rng.integers(0, 3))):
                who = people[int(rng.integers(0, len(people)))] if rng.random() < 0.8 else strangers[int(rng.integers(0, 3))]
                tracks.append(TrackRow(round(t, 3), round(t + d, 3), round(d * float(rng.uniform(0.3, 1.0)), 3),
                                       float(rng.uniform(0.2, 0.9)), noisy(rng, who, float(rng.uniform(0.55, 0.85)))))
            t += d
        out.append(((c * step, end), shots, tracks))
    refs = [PersonRefs(100 + i, np.stack([noisy(rng, p, 1.0) for _ in range(int(rng.integers(1, 5)))]))
            for i, p in enumerate(people)]
    refs[0].series = noisy(rng, people[0], 0.5)
    refs.append(PersonRefs(999, np.zeros((0, 512), np.float32), noisy(rng, people[2], 0.6)))
    return out, refs


def _same(a, b):
    assert json.dumps(a.scenes) == json.dumps(b.scenes)
    assert (a.analyzed_until, a.progress, a.complete) == (b.analyzed_until, b.progress, b.complete)
    assert a.assignments == b.assignments
    assert np.array_equal(a.cluster_time, b.cluster_time)


@pytest.mark.parametrize("seed,start", [(20, 0), (21, 3), (22, 6)])
def test_identique_au_recalcul_complet_a_chaque_troncon(seed, start):
    chunks, refs = _episode(seed)
    order = chunks[start:] + chunks[:start]  # comme l'ouvrier : le tronçon de startAt d'abord
    duration, anchor = 8 * 120.0, order[0][0][0]
    asm = Assembler(duration, len(chunks), anchor, refs, 0.30, 0.42)
    done, shots, tracks = [], [], []
    named = 0
    for interval, s, t in order:
        done.append(interval)
        shots += s
        tracks += t
        asm.add(done, s, t)
        inc = asm.build()
        full = build(duration, done, len(chunks), anchor, shots, tracks, refs, 0.30, 0.42)
        _same(inc, full)
        named = max(named, len(full.assignments))
    assert inc.complete and named >= 4 and len(inc.scenes) > 10


def test_reprise_depuis_la_base_puis_suite():
    # Un nouveau passage (redémarrage) repart de tout ce qui est en base, en un seul ajout.
    chunks, refs = _episode(23)
    asm = Assembler(960.0, 8, 0.0, refs, 0.30, 0.42)
    shots = [s for _, ss, _ in chunks[:5] for s in ss]
    tracks = [t for _, _, ts in chunks[:5] for t in ts]
    done = [c[0] for c in chunks[:5]]
    asm.add(done, shots, tracks)
    _same(asm.build(), build(960.0, done, 8, 0.0, shots, tracks, refs, 0.30, 0.42))
    for interval, s, t in chunks[5:]:
        done.append(interval)
        shots += s
        tracks += t
        asm.add(done, s, t)
    _same(asm.build(), build(960.0, done, 8, 0.0, shots, tracks, refs, 0.30, 0.42))


def _label_clusters_reference(centroids, weights, refs, threshold, cluster_threshold, tracks):
    """La version d'avant (une boucle par couple groupe × acteur), gardée ici comme référence."""
    from scipy.optimize import linear_sum_assignment

    from app.cluster import Assignment, SECOND_PASS_MIN_TIME, SURE_MARGIN, TWIN_MARGIN

    k, p = len(centroids), len(refs)
    centroids = normalize(centroids.astype(np.float32))
    score = np.full((k, p), -1.0)
    photo = np.full((k, p), -1.0)
    for j, ref in enumerate(refs):
        for i in range(k):
            score[i, j], photo[i, j] = person_score(centroids[i], ref)
    ok = np.zeros((k, p), dtype=bool)
    for i in range(k):
        for j in range(p):
            ok[i, j] = acceptable(score[i, j], _runner_up(score[i], j), float(weights[i]), int(tracks[i]), threshold)
    w = 1.0 + 0.05 * np.log1p(np.maximum(weights, 0.0))[:, None]
    rows, cols = linear_sum_assignment(-np.where(ok, score * w, 0.0))
    out = {}
    for i, j in zip(rows, cols):
        if ok[i, j]:
            out[int(i)] = Assignment(refs[j].person_id, float(score[i, j]), confidence(score[i, j], threshold), float(photo[i, j]))
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


@pytest.mark.parametrize("seed", range(6))
def test_noms_vectorises_comme_avant(seed):
    rng = np.random.default_rng(seed)
    people = [unit(rng) for _ in range(5)]
    refs = [PersonRefs(i, np.stack([noisy(rng, p, 1.0) for _ in range(int(rng.integers(1, 6)))])) for i, p in enumerate(people)]
    refs[1].series = noisy(rng, people[1], 0.5)
    refs.append(PersonRefs(77, np.zeros((0, 512), np.float32), noisy(rng, people[3], 0.7)))
    cents = np.stack([noisy(rng, people[int(rng.integers(0, 5))], float(rng.uniform(0.6, 1.2))) for _ in range(14)]
                     + [unit(rng) for _ in range(4)])
    weights = rng.uniform(0.2, 30, len(cents))
    tracks = rng.integers(1, 6, len(cents))
    # Deux acteurs très proches : la meilleure note d'un *autre* acteur compte (bande « à confirmer »).
    refs.append(PersonRefs(88, np.stack([noisy(rng, people[0], 0.4) for _ in range(3)])))
    a = label_clusters(cents, weights, refs, 0.30, 0.42, tracks)
    b = _label_clusters_reference(cents, weights, refs, 0.30, 0.42, tracks)
    assert {i: x.person_id for i, x in a.items()} == {i: x.person_id for i, x in b.items()}
    for i in a:
        assert a[i].score == pytest.approx(b[i].score, abs=1e-6)
        assert a[i].photo_score == pytest.approx(b[i].photo_score, abs=1e-6)
    assert len(a) >= 2


def test_ouvrier_incremental_ecrit_le_meme_resultat(db, monkeypatch):
    """Par la base, comme en production : `checkpoint` incrémental puis complet, même JSON."""
    from app.config import settings
    from app.jobs import JobStore, validate_job
    from app.worker import Worker
    from conftest import MEDIA, job

    chunks, refs = _episode(24, chunks=5)
    store = JobStore(db)
    store.submit(validate_job(job(), MEDIA))
    item = "a" * 32
    with db.tx() as c:
        for i, ((a, b), _, _) in enumerate(chunks):
            c.execute("INSERT INTO chunks (item_id, idx, start, end) VALUES (?, ?, ?, ?)", (item, i, a, b))
    w = Worker(db, store, models=None, guard=None)
    got = {}
    for mode in (True, False):
        monkeypatch.setattr(settings, "incremental", mode)
        w._asm = None
        db.run("UPDATE chunks SET done=0 WHERE item_id=?", (item,))
        db.run("DELETE FROM shots WHERE item_id=?", (item,))
        db.run("DELETE FROM tracks WHERE item_id=?", (item,))
        seen = []
        for i in [2, 3, 4, 0, 1]:
            _, shots, tracks = chunks[i]
            with db.tx() as c:
                for s in shots:
                    c.execute("INSERT INTO shots (item_id, chunk_idx, start, end, hist) VALUES (?, ?, ?, ?, ?)",
                              (item, i, s.start, s.end, s.hist.astype(np.float32).tobytes()))
                for t in tracks:
                    c.execute("INSERT INTO tracks (item_id, chunk_idx, shot_start, shot_end, screen_time, quality, faces, emb)"
                              " VALUES (?, ?, ?, ?, ?, ?, 2, ?)", (item, i, t.shot_start, t.shot_end, t.screen_time,
                                                                   t.quality, t.emb.astype(np.float32).tobytes()))
                c.execute("UPDATE chunks SET done=1 WHERE item_id=? AND idx=?", (item, i))
            w.checkpoint(item, "etag-1", "buffalo_l", 600.0, 240.0, refs)
            seen.append(db.one("SELECT scenes_json, analyzed_until, progress FROM results WHERE item_id=?", (item,)))
        got[mode] = [tuple(r) for r in seen]
    assert got[True] == got[False]
    assert json.loads(got[True][-1][0])
