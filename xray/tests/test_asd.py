"""Lecture des lèvres : poids lus sans PyTorch, réseau OpenVINO contre une référence numpy, MFCC, choix des
voix et des instants, votes, et ce que les votes font aux voix (nom, mémoire, renommage)."""

import collections
import io
import json
import pickle
import sys
import types
import zipfile

import numpy as np
import pytest
from scipy.special import erf

from app import asd as asdmod
from app import asdjob, relabel, voicejob
from app.asdjob import AsdParams, VoicePlan, link_tracks, piece_votes, plan, windows
from app.faces import Face
from app.voices import VoiceParams, VoiceResult, build
from conftest import noisy, unit
from test_voices import dialogue, rng, scenes_of, shots_for  # noqa: F401  (rng : fixture)


# ---- poids au format torch.save, sans torch ------------------------------------------------------------

def random_state(rng) -> dict[str, np.ndarray]:
    s: dict[str, np.ndarray] = {}

    def conv(name, shape):
        fan = int(np.prod(shape[1:]))
        s[name + ".weight"] = (rng.standard_normal(shape) * np.sqrt(2.0 / fan)).astype(np.float32)

    def bn(name, n):
        s[name + ".weight"] = rng.uniform(0.5, 1.5, n).astype(np.float32)
        s[name + ".bias"] = rng.uniform(-0.2, 0.2, n).astype(np.float32)
        s[name + ".running_mean"] = rng.uniform(-0.2, 0.2, n).astype(np.float32)
        s[name + ".running_var"] = rng.uniform(0.5, 2.0, n).astype(np.float32)

    for k, (i, o) in enumerate(((1, 32), (32, 64), (64, 128)), 1):
        p = f"model.visualEncoder.block{k}"
        for c, shp in (("s_3", (o, i, 1, 3, 3)), ("t_3", (o, o, 3, 1, 1)), ("s_5", (o, i, 1, 5, 5)),
                       ("t_5", (o, o, 5, 1, 1)), ("last", (o, o, 1, 1, 1))):
            conv(f"{p}.{c}", shp)
            bn(f"{p}.bn_{c}", o)
        p = f"model.audioEncoder.block{k}"
        for c, shp in (("m_3", (o, i, 3, 1)), ("t_3", (o, o, 1, 3)), ("m_5", (o, i, 5, 1)),
                       ("t_5", (o, o, 1, 5)), ("last", (o, o, 1, 1))):
            conv(f"{p}.{c}", shp)
            bn(f"{p}.bn_{c}", o)
    for g in ("gru_forward", "gru_backward"):
        for k in ("weight_ih_l0", "weight_hh_l0"):
            s[f"model.GRU.{g}.{k}"] = (rng.standard_normal((384, 128)) * 0.1).astype(np.float32)
        for k in ("bias_ih_l0", "bias_hh_l0"):
            s[f"model.GRU.{g}.{k}"] = (rng.standard_normal(384) * 0.1).astype(np.float32)
    s["lossAV.FC.weight"] = (rng.standard_normal((2, 128)) * 0.1).astype(np.float32)
    s["lossAV.FC.bias"] = (rng.standard_normal(2) * 0.1).astype(np.float32)
    return s


def torch_like_file(state: dict, path, extra_global=None) -> None:
    """Écrit un fichier au format de `torch.save` (zip : `archive/data.pkl` + un fichier par stockage),
    sans torch : des modules factices le temps de l'écriture, pour que le pickle nomme les mêmes classes."""
    fake_torch = types.ModuleType("torch")
    fake_utils = types.ModuleType("torch._utils")

    class FloatStorage:
        pass

    FloatStorage.__module__ = "torch"
    FloatStorage.__qualname__ = "FloatStorage"
    fake_torch.FloatStorage = FloatStorage

    def _rebuild_tensor_v2(*a):
        raise AssertionError

    _rebuild_tensor_v2.__module__ = "torch._utils"
    _rebuild_tensor_v2.__qualname__ = "_rebuild_tensor_v2"
    fake_utils._rebuild_tensor_v2 = _rebuild_tensor_v2
    saved = {k: sys.modules.get(k) for k in ("torch", "torch._utils")}
    sys.modules["torch"], sys.modules["torch._utils"] = fake_torch, fake_utils
    blobs = {}

    class Tensor:
        def __init__(self, key, arr):
            self.key, self.arr = key, arr

        def __reduce__(self):
            return (_rebuild_tensor_v2, (("st", self.key, self.arr.size), 0, tuple(self.arr.shape),
                                         tuple(s // 4 for s in self.arr.strides), False, collections.OrderedDict()))

    class P(pickle.Pickler):
        def persistent_id(self, obj):
            if isinstance(obj, tuple) and len(obj) == 3 and obj[0] == "st":
                return ("storage", FloatStorage, obj[1], "cpu", obj[2])
            return None

    try:
        od = collections.OrderedDict()
        for i, (k, v) in enumerate(state.items()):
            key = str(1000 + i)
            arr = np.ascontiguousarray(v, dtype=np.float32)
            blobs[key] = arr.tobytes()
            od["module." + k] = Tensor(key, arr)
        if extra_global is not None:
            od["piège"] = extra_global
        buf = io.BytesIO()
        P(buf, protocol=2).dump(od)
    finally:
        for k, v in saved.items():
            if v is None:
                sys.modules.pop(k, None)
            else:
                sys.modules[k] = v
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("archive/data.pkl", buf.getvalue())
        for k, b in blobs.items():
            z.writestr(f"archive/data/{k}", b)


def test_poids_lus_sans_torch(tmp_path):
    st = random_state(np.random.default_rng(1))
    torch_like_file(st, tmp_path / "w.model")
    got = asdmod.load_state(tmp_path / "w.model")
    assert set(got) == set(st)
    for k in st:
        assert got[k].shape == st[k].shape and np.array_equal(got[k], st[k])


def test_poids_piegés_refusés(tmp_path):
    import os

    torch_like_file({"a": np.zeros(2, np.float32)}, tmp_path / "w.model", extra_global=os.getcwd)
    with pytest.raises(pickle.UnpicklingError):
        asdmod.load_state(tmp_path / "w.model")


# ---- le réseau : OpenVINO contre une référence numpy (le code d'origine, couche par couche) -----------

def _conv(x, w, stride, pad):
    """x (C, *S), w (O, C, *K) : corrélation, remplissage nul."""
    nd = w.ndim - 2
    xp = np.pad(x, [(0, 0)] + [(p, p) for p in pad])
    win = np.lib.stride_tricks.sliding_window_view(xp, w.shape[2:], axis=tuple(range(1, nd + 1)))
    win = win[(slice(None),) + tuple(slice(None, None, s) for s in stride)]
    out = np.tensordot(win, w, axes=([0] + list(range(nd + 1, 2 * nd + 1)), [1] + list(range(2, nd + 2))))
    return np.moveaxis(out, -1, 0)


def _bn(x, st, name):
    s = (-1,) + (1,) * (x.ndim - 1)
    return ((x - st[name + ".running_mean"].reshape(s)) / np.sqrt(st[name + ".running_var"].reshape(s) + 1e-3)
            * st[name + ".weight"].reshape(s) + st[name + ".bias"].reshape(s))


def _pool(x, k, s, p):
    nd = len(k)
    xp = np.pad(x, [(0, 0)] + [(q, q) for q in p], constant_values=-np.inf)
    win = np.lib.stride_tricks.sliding_window_view(xp, k, axis=tuple(range(1, nd + 1)))
    win = win[(slice(None),) + tuple(slice(None, None, q) for q in s)]
    return win.max(axis=tuple(range(nd + 1, 2 * nd + 1)))


def _block(x, st, p, video, stride=None):
    def cbr(x, c, strd, pad):
        return np.maximum(_bn(_conv(x, st[f"{p}.{c}.weight"], strd, pad), st, f"{p}.bn_{c}"), 0)

    if video:
        s = stride or (1, 1, 1)
        x3 = cbr(cbr(x, "s_3", s, (0, 1, 1)), "t_3", (1, 1, 1), (1, 0, 0))
        x5 = cbr(cbr(x, "s_5", s, (0, 2, 2)), "t_5", (1, 1, 1), (2, 0, 0))
        return cbr(x3 + x5, "last", (1, 1, 1), (0, 0, 0))
    x3 = cbr(cbr(x, "m_3", (1, 1), (1, 0)), "t_3", (1, 1), (0, 1))
    x5 = cbr(cbr(x, "m_5", (1, 1), (2, 0)), "t_5", (1, 1), (0, 2))
    return cbr(x3 + x5, "last", (1, 1), (0, 0))


def _gru(x, st, name, reverse):
    wi, wh = st[name + ".weight_ih_l0"], st[name + ".weight_hh_l0"]
    bi, bh = st[name + ".bias_ih_l0"], st[name + ".bias_hh_l0"]
    H = 128
    h = np.zeros(H)
    out = np.zeros((len(x), H))
    order = range(len(x) - 1, -1, -1) if reverse else range(len(x))
    sig = lambda v: 1 / (1 + np.exp(-v))  # noqa: E731
    for t in order:
        gi, gh = wi @ x[t] + bi, wh @ h + bh
        r, z = sig(gi[:H] + gh[:H]), sig(gi[H:2 * H] + gh[H:2 * H])
        n = np.tanh(gi[2 * H:] + r * gh[2 * H:])
        h = (1 - z) * n + z * h
        out[t] = h
    return out


def reference(st, feats, crops):
    v = ((crops / 255.0 - 0.4161) / 0.1688)[None].astype(np.float64)
    v = _block(v, st, "model.visualEncoder.block1", True, (1, 2, 2))
    v = _pool(v, (1, 3, 3), (1, 2, 2), (0, 1, 1))
    v = _block(v, st, "model.visualEncoder.block2", True)
    v = _pool(v, (1, 3, 3), (1, 2, 2), (0, 1, 1))
    v = _block(v, st, "model.visualEncoder.block3", True)
    v = v.max(axis=(2, 3)).T                                    # (T, 128)
    a = feats.T[None].astype(np.float64)                        # (1, 13, 4T)
    a = _block(a, st, "model.audioEncoder.block1", False)
    a = _pool(a, (1, 3), (1, 2), (0, 1))
    a = _block(a, st, "model.audioEncoder.block2", False)
    a = _pool(a, (1, 3), (1, 2), (0, 1))
    a = _block(a, st, "model.audioEncoder.block3", False)
    a = a.mean(axis=1).T                                        # (T, 128)
    gelu = lambda u: 0.5 * u * (1 + erf(u / np.sqrt(2)))  # noqa: E731
    x = gelu(_gru(a + v, st, "model.GRU.gru_forward", False))
    x = gelu(_gru(x, st, "model.GRU.gru_backward", True))
    return x @ st["lossAV.FC.weight"][1] + st["lossAV.FC.bias"][1]


def test_reseau_openvino_identique_a_la_reference(tmp_path):
    rng = np.random.default_rng(3)
    st = random_state(rng)
    torch_like_file(st, tmp_path / "w.model")
    net = asdmod.AsdNet(tmp_path / "w.model", threads=1)
    T = 4
    crops = rng.integers(0, 255, (T, 112, 112)).astype(np.float32)
    feats = rng.standard_normal((4 * T, 13)).astype(np.float32) * 5
    got = net.score(feats, crops)
    want = reference(st, feats, crops)
    assert got.shape == (T,)
    assert np.max(np.abs(got - want)) < 1e-3 * max(1.0, float(np.abs(want).max()))
    # Un son plus court que l'image : on note ce que le son couvre.
    assert net.score(feats[:8], crops).shape == (2,)


def test_mfcc_forme_et_energie():
    rng = np.random.default_rng(0)
    pcm = (rng.standard_normal(16000) * 2000).astype(np.int16)
    f = asdmod.mfcc(pcm)
    assert f.shape == (99, 13) and np.all(np.isfinite(f))
    # Le premier coefficient est le log de l'énergie de la trame (préaccentuée, FFT de 512).
    x = np.append(pcm[0], pcm[1:] - 0.97 * pcm[:-1].astype(np.float64))[:400]
    e = (np.abs(np.fft.rfft(x, 512)) ** 2 / 512).sum()
    assert abs(f[0, 0] - np.log(e)) < 1e-9
    assert asdmod.mfcc(np.zeros(0, np.int16)).shape == (0, 13)


def test_recadrage_du_visage():
    img = np.full((360, 640), 50, np.uint8)
    img[100:200, 300:380] = 200
    c = asdmod.face_crop(img, (300, 100, 380, 200))
    assert c.shape == (112, 112) and c.mean() > 120
    # Un visage au bord de l'image : la bordure grise complète, sans erreur.
    assert asdmod.face_crop(img, (600, 300, 640, 360)).shape == (112, 112)


# ---- quelles voix, quels instants ----------------------------------------------------------------------

def result_of(rows, pres, pids, conflict=None):
    return VoiceResult([], {}, {}, rows, conflict or [False] * len(rows), [False] * len(rows), np.array(pres, float), pids)


def test_plan_voix_indecises_seulement():
    rows, pres = [], []
    t = 0.0
    for k in range(10):  # voix 1 : indécise, A et B ensemble à l'image
        rows.append((t, t + 2, 1, None, 0.0)); pres.append([0.8, 0.8, 0.0, 0.0, 0.0, 0.0]); t += 5
    for k in range(6):   # voix 2 : nommée
        rows.append((t, t + 2, 2, 7, 1.0)); pres.append([0.9, 0.0, 0.0, 0.0, 0.0, 0.0]); t += 5
    for k in range(6):   # voix 3 : hors champ (personne à l'image)
        rows.append((t, t + 2, 3, None, 0.0)); pres.append([0.0] * 6); t += 5
    for k in range(6):   # voix 4 : une foule (six personnes)
        rows.append((t, t + 2, 4, None, 0.0)); pres.append([0.6] * 6); t += 5
    for k in range(2):   # voix 5 : trop petite
        rows.append((t, t + 2, 5, None, 0.0)); pres.append([0.0, 0.9, 0.0, 0.0, 0.0, 0.0]); t += 5
    pl = plan(result_of(rows, pres, [10, 11, 12, 13, 14, 15]), AsdParams(lines=4))
    assert [vp.voice for vp in pl] == [1]
    assert pl[0].candidates[:2] == [10, 11] and len(pl[0].pieces) == 4
    # Étalés : jamais deux morceaux à moins de `spread_s`.
    cs = [(a + b) / 2 for a, b in pl[0].pieces]
    assert min(np.diff(cs)) >= 3.0


def test_plan_ignore_une_voix_en_desaccord():
    rows = [(k * 5.0, k * 5.0 + 2, 1, None, 0.0) for k in range(8)]
    pres = [[0.8, 0.8]] * 8
    assert plan(result_of(rows, pres, [1, 2], conflict=[True] * 8)) == []


def test_fenetres_jointes_et_bornees():
    vp = VoicePlan(1, 10, [1], [(10.0, 12.0), (12.5, 14.0), (30.0, 31.0)])
    w = windows([vp], AsdParams(pad=0.4, merge_gap=1.0, max_window=12.0))
    assert [(a, b) for a, b, _ in w] == [(9.6, 14.4), (29.6, 31.4)]
    assert w[0][2] == [(10.0, 12.0), (12.5, 14.0)]


# ---- pistes et votes ------------------------------------------------------------------------------------

def _f(box, score=0.9):
    return Face(box=np.array(box, np.float32), score=score, kps=np.zeros((5, 2), np.float32))


def test_pistes_par_recouvrement_et_interpolation():
    dets = {k: [_f((100 + k, 50, 160 + k, 120)), _f((400, 60, 460, 130))] for k in range(0, 50, 5)}
    dets[50] = [_f((400, 60, 460, 130))]
    tr = link_tracks(dets, 60, AsdParams())
    assert len(tr) == 2
    a = next(t for t in tr if t["box"][0][0] < 300)
    assert a["frames"][0] == 0 and a["frames"][-1] == 49
    assert abs(a["box"][2][0] - 102) < 1e-6  # interpolée entre deux détections


def test_vote_par_morceau():
    fr = np.arange(0, 100)
    speaking = {"frames": fr, "pid": 1, "scores": np.where(fr < 50, 2.0, -2.0).astype(np.float32)}
    listening = {"frames": fr, "pid": 2, "scores": np.where(fr < 50, -1.0, 1.5).astype(np.float32)}
    v = piece_votes([speaking, listening], 10.0, [(10.0, 12.0), (12.0, 14.0)], AsdParams())
    assert v[0][:5] == (10.0, 12.0, 1, 2.0, -1.0) and v[1][2] == 2
    # Trop de visages (une foule) ou aucun : un vote sans note.
    crowd = [dict(speaking, pid=k) for k in range(6)]
    assert piece_votes(crowd, 10.0, [(10.0, 12.0)], AsdParams())[0][3] is None
    assert piece_votes([], 10.0, [(10.0, 12.0)], AsdParams())[0][2:5] == (None, None, None)


# ---- ce que les votes font aux voix ---------------------------------------------------------------------

def _ensemble(rng):
    """Deux personnes toujours ensemble à l'image, à parts égales : les visages ne départagent pas."""
    A, B = unit(rng), unit(rng)
    turns = ["A", "B"] * 12
    regions, wins, embs = dialogue(rng, turns, {"A": A, "B": B})
    shown = {"A": [(1, 0.8), (2, 0.8)], "B": [(1, 0.8), (2, 0.8)]}
    return A, B, turns, regions, wins, embs, shots_for(regions, turns, shown)


def _votes(regions, turns, who):
    """Un vote par tour de parole : `who[voix]` (personne, note)."""
    out = []
    for (s, e), v in zip(regions, turns):
        pid, sc = who[v]
        out.append((s + 0.2, s + 1.8, pid, sc, -1.0))
    return out


def test_les_votes_nomment_une_voix_indecise(rng):
    A, B, turns, regions, wins, embs, pres = _ensemble(rng)
    bare = build(regions, wins, embs, pres, scenes_of(regions))
    assert all(s["personId"] is None for s in bare.segments)
    votes = _votes(regions, turns, {"A": (1, 1.5), "B": (2, 1.2)})
    r = build(regions, wins, embs, pres, scenes_of(regions), asd=votes)
    by_turn = collections.defaultdict(set)
    for s in r.segments:
        k = next(i for i, (a, b) in enumerate(regions) if a <= (s["start"] + s["end"]) / 2 < b)
        by_turn[turns[k]].add(s["personId"])
        if s["personId"] is not None:
            assert s.get("via") == "asd"
    assert by_turn["A"] == {1} and by_turn["B"] == {2}
    assert r.stats["voicesAsd"] == 2 and r.stats["voicesNamed"] == 2
    # Lecture des lèvres seule : elle ne nourrit pas la mémoire de la série.
    assert r.profiles == {}


def test_votes_partages_ou_faibles_sans_nom(rng):
    A, B, turns, regions, wins, embs, pres = _ensemble(rng)
    # La moitié des votes pour chacun : rien de net.
    split = []
    for k, ((s, e), v) in enumerate(zip(regions, turns)):
        split.append((s + 0.2, s + 1.8, 1 + k % 4 // 2, 1.0, -1.0))
    r = build(regions, wins, embs, pres, scenes_of(regions), asd=split)
    assert all(s["personId"] is None for s in r.segments)
    # Des notes sous le seuil ne comptent pas.
    weak = _votes(regions, turns, {"A": (1, -0.5), "B": (2, -0.5)})
    r = build(regions, wins, embs, pres, scenes_of(regions), asd=weak)
    assert all(s["personId"] is None for s in r.segments)


def test_la_memoire_contredite_laisse_sans_nom(rng):
    A, B, turns, regions, wins, embs, pres = _ensemble(rng)
    votes = _votes(regions, turns, {"A": (1, 1.5), "B": (2, 1.2)})
    # La mémoire tient la voix A pour la personne 2 et B pour 1 : elle nomme d'elle-même (avant la
    # lecture des lèvres) ; et quand elle n'est pas assez nette pour nommer mais préfère l'autre, la voix
    # reste sans nom et le dit.
    p = VoiceParams(memory_tau=1.5)
    r = build(regions, wins, embs, pres, scenes_of(regions), memory={2: A, 1: B}, params=p, asd=votes)
    assert all(s["personId"] is None for s in r.segments)
    assert all(s.get("conflict") for s in r.segments)


def test_petite_voix_confiance_haute_seulement(rng):
    A, B, C = unit(rng), unit(rng), unit(rng)
    turns = ["A", "B"] * 10 + ["C"] * 2
    regions, wins, embs = dialogue(rng, turns, {"A": A, "B": B, "C": C}, turn_len=3.0)
    shown = {"A": [(1, 0.9), (2, 0.2)], "B": [(2, 0.9), (1, 0.2)], "C": [(3, 0.9)]}
    pres = shots_for(regions, turns, shown)
    loose = build(regions, wins, embs, pres, scenes_of(regions), params=VoiceParams(small_voice=0, min_lines=2))
    strict = build(regions, wins, embs, pres, scenes_of(regions), params=VoiceParams(small_voice=6, small_conf=1.01, min_lines=2))
    small = lambda r: [s for s in r.segments if s["start"] >= regions[-2][0] - 1e-6]  # noqa: E731
    assert any(s["personId"] == 3 for s in small(loose))
    assert all(s["personId"] is None for s in small(strict))
    # Les grosses voix ne sont pas touchées.
    assert {s["personId"] for s in strict.segments if s["start"] < regions[-2][0]} >= {1, 2}


def test_le_renommage_garde_les_votes(db, rng):
    """Les votes sont en base, par instants : `voicejob.assemble` (analyse comme renommage) les relit."""
    A, B, turns, regions, wins, embs, pres = _ensemble(rng)
    item = "e" * 32
    db.run("""INSERT INTO items (item_id, etag, path, priority, cast_json, status, seq, created, updated, model, duration)
              VALUES (?, 'x', '/media/a.mkv', 2, '[]', 'done', 1, 0, 0, 'buffalo_l', 200)""", (item,))
    db.run("INSERT INTO chunks (item_id, idx, start, end, done, voice) VALUES (?, 0, 0, 200, 1, 1)", (item,))
    voicejob.store_chunk(db, item, "x", 0, regions, wins, embs)
    scenes = scenes_of(regions)
    plain = voicejob.assemble(db, item, "x", "m", None, None, pres, scenes, final=True)
    assert plain.stats["voicesAsd"] == 0
    with db.tx() as c:
        c.executemany("INSERT INTO asd_votes (item_id, start, end, person_id, score, second, faces) VALUES (?, ?, ?, ?, ?, ?, 2)",
                      [(item, s, e, p, sc, sec) for s, e, p, sc, sec in _votes(regions, turns, {"A": (1, 1.5), "B": (2, 1.2)})])
    again = voicejob.assemble(db, item, "x", "m", None, None, pres, scenes, final=True)
    assert again.stats["voicesAsd"] == 2
    seg = json.loads(db.one("SELECT segments_json FROM voice_results WHERE item_id=?", (item,))["segments_json"])
    assert any(s.get("via") == "asd" for s in seg)


def test_un_element_sans_voix_a_lire_est_note_fait(db, rng, monkeypatch):
    A, B = unit(rng), unit(rng)
    turns = ["A", "B"] * 12
    regions, wins, embs = dialogue(rng, turns, {"A": A, "B": B})
    shown = {"A": [(1, 0.9), (2, 0.2)], "B": [(2, 0.9), (1, 0.2)]}
    item = "f" * 32
    db.run("""INSERT INTO items (item_id, etag, path, priority, cast_json, status, seq, created, updated, model, duration)
              VALUES (?, 'x', '/media/a.mkv', 2, '[]', 'done', 1, 0, 0, 'buffalo_l', 200)""", (item,))
    db.run("INSERT INTO chunks (item_id, idx, start, end, done, voice) VALUES (?, 0, 0, 200, 1, 1)", (item,))
    voicejob.store_chunk(db, item, "x", 0, regions, wins, embs)
    pres = shots_for(regions, turns, shown)
    voicejob.assemble(db, item, "x", "m", None, None, pres, scenes_of(regions), final=True)
    assert asdjob.next_item(db, "m")["item_id"] == item

    class Built:
        presence, scenes, assignments, centroids = pres, scenes_of(regions), {}, None

    monkeypatch.setattr(asdjob.decode, "probe", lambda p: (_ for _ in ()).throw(AssertionError("rien à décoder")))
    row = db.one("SELECT * FROM items WHERE item_id=?", (item,))
    assert asdjob.run_item(db, row, None, None, "m", Built(), lambda: False) == "done"
    st = json.loads(db.one("SELECT stats_json FROM asd_runs WHERE item_id=?", (item,))["stats_json"])
    assert st["voicesTried"] == 0
    assert asdjob.next_item(db, "m") is None
