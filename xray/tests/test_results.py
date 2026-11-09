"""Du stockage aux scènes : plages analysées, temps de présence, anonymes exclus."""

import numpy as np

from app.cluster import PersonRefs
from app.results import ShotRow, TrackRow, analyzed_until, build, merge_intervals
from conftest import noisy, unit


def hist(rng, base=None, amount=0.0):
    """Sans base : un décor (lumière concentrée sur une teinte) ; avec : un plan de ce décor."""
    if base is None:
        h = np.full(64, 0.002, np.float32)
        for a, b in ((0, 32), (32, 48), (48, 64)):
            h[a + int(rng.integers(0, b - a))] += 1.0
    else:
        h = np.clip(base + amount * rng.random(64), 0, None).astype(np.float32)
    for a, b in ((0, 32), (32, 48), (48, 64)):
        h[a:b] /= h[a:b].sum()
    return h


def test_plages():
    assert merge_intervals([(240, 360), (0, 120), (120, 240), (600, 720)]) == [(0, 360), (600, 720)]
    iv = [(0, 360), (600, 720)]
    assert analyzed_until(iv, 0) == 360
    assert analyzed_until(iv, 600) == 720
    assert analyzed_until(iv, 480) == 0.0


def test_scenes_et_personnes():
    rng = np.random.default_rng(10)
    a, b, stranger = unit(rng), unit(rng), unit(rng)
    room1, room2 = hist(rng), hist(rng)
    shots, tracks = [], []
    # Scène 1 (0–40 s) : champ-contrechamp A / B dans la même pièce.
    t = 0.0
    for i in range(8):
        shots.append(ShotRow(t, t + 5, hist(rng, room1, 0.02)))
        who = a if i % 2 == 0 else b
        tracks.append(TrackRow(t, t + 5, 5.0, 0.8, noisy(rng, who, 0.7)))
        t += 5
    # Scène 2 (40–70 s) : ailleurs, A et un inconnu absent de la distribution.
    for i in range(6):
        shots.append(ShotRow(t, t + 5, hist(rng, room2, 0.02)))
        tracks.append(TrackRow(t, t + 5, 4.0, 0.8, noisy(rng, a, 0.7)))
        tracks.append(TrackRow(t, t + 5, 5.0, 0.8, noisy(rng, stranger, 0.7)))
        t += 5
    refs = [PersonRefs(1, np.stack([noisy(rng, a, 1.0) for _ in range(3)])),
            PersonRefs(2, np.stack([noisy(rng, b, 1.0) for _ in range(3)]))]
    built = build(70.0, [(0, 70)], 1, 0.0, shots, tracks, refs, 0.30, 0.42)
    assert built.complete and built.progress == 1.0 and built.analyzed_until == 70.0
    assert [(s["start"], s["end"]) for s in built.scenes] == [(0.0, 40.0), (40.0, 70.0)]
    s1, s2 = built.scenes
    assert [p["personId"] for p in s1["people"]] == [1, 2]  # 20 s chacun, départage stable
    assert s1["people"][0]["screenTime"] == 20.0
    # L'inconnu (plus présent que A) n'apparaît pas.
    assert [p["personId"] for p in s2["people"]] == [1]
    assert s2["people"][0]["screenTime"] == 24.0
    assert 0.5 <= s2["people"][0]["confidence"] <= 1.0


def test_resultat_partiel_depuis_startAt():
    rng = np.random.default_rng(11)
    room = hist(rng)
    shots = [ShotRow(t, t + 20, hist(rng, room, 0.01)) for t in range(240, 360, 20)]
    built = build(600.0, [(240, 360)], 5, 240.0, shots, [], [], 0.30, 0.42)
    assert not built.complete
    assert built.analyzed_until == 360
    assert built.progress == 0.2
    assert built.scenes == [{"start": 240.0, "end": 360.0, "people": []}]


def test_aucune_scene_ne_traverse_un_trou():
    rng = np.random.default_rng(12)
    room = hist(rng)
    shots = [ShotRow(t, t + 20, hist(rng, room, 0.01)) for t in list(range(0, 120, 20)) + list(range(240, 360, 20))]
    built = build(600.0, [(0, 120), (240, 360)], 5, 0.0, shots, [], [], 0.30, 0.42)
    assert [(s["start"], s["end"]) for s in built.scenes] == [(0.0, 120.0), (240.0, 360.0)]
    assert built.analyzed_until == 120
