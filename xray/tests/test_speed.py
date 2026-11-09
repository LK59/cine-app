"""Les économies de calcul (11/2026) : meilleurs visages, lots, mémoire de série, plans fixes,
plages sautées, fils — chacune sans changer ce qu'elle ne doit pas changer."""

import math

import numpy as np
import pytest

from app import segments
from app.decode import MediaInfo, build_command
from app.faces import Embedder, Face, FaceEngine
from app.jobs import InvalidJob, check_skip, validate_job
from app.pipeline import EARLY_MARGIN, EARLY_SIM, ShotFaces, memory_match
from app.shots import ShotSplitter, frames_to_sample, pick_indices
from app.timing import StageClock
from app.tracks import best_faces, link, needs_full, summarize
from conftest import AUTH, ITEM, MEDIA, job, noisy, unit


# --- visages factices ------------------------------------------------------------------------


def face(x, rng=None, base=None, quality=0.5, accepted=True, side=60):
    """Un visage à l'abscisse `x` ; son « image » alignée porte l'empreinte qu'il rendra."""
    f = Face(box=np.array([x, 10, x + side, 10 + side], np.float32), score=0.9, kps=np.zeros((5, 2), np.float32))
    f.accepted = accepted
    f.quality = quality
    if accepted:
        e = base if rng is None else noisy(rng, base, 0.3)
        f.crop = e.astype(np.float32)  # l'empreinteur factice rend la « vignette » telle quelle
    return f


class FakeEmbedder:
    def __init__(self, batch=32):
        self.batch = batch
        self.calls = []

    def embed(self, crops):
        self.calls.append(len(crops))
        e = np.stack(crops)
        return e / np.linalg.norm(e, axis=1, keepdims=True)


def engine(batch=32):
    eng = FaceEngine("buffalo_l", detector=None, embedder=FakeEmbedder(batch))
    eng.clock = StageClock()
    return eng


# --- 1. meilleurs visages d'une piste ----------------------------------------------------------


def test_meilleurs_visages_par_qualite_puis_taille():
    rng = np.random.default_rng(0)
    a = unit(rng)
    f1, f2, f3 = face(0, base=a, quality=0.4), face(2, base=a, quality=0.9), face(4, base=a, quality=0.4, side=80)
    rejet = face(6, accepted=False, quality=0.99)
    tr = link([[f1], [f2], [f3], [rejet]])
    assert len(tr) == 1
    assert best_faces(tr[0], 2) == [f2, f3]       # f3 plus grand que f1 à qualité égale
    assert best_faces(tr[0], 5) == [f2, f3, f1]   # jamais un visage refusé au tri


def test_plan_simple_n_empreinte_que_les_meilleurs():
    rng = np.random.default_rng(1)
    a, b = unit(rng), unit(rng)
    frames = [[face(0, rng, a, q), face(300, rng, b, q)] for q in (0.3, 0.8, 0.5, 0.6)]
    eng = engine()
    sf = ShotFaces(eng, eng.clock, faces_per_track=2)
    assert sf.add(0.0, 10.0, frames) == []
    rows = sf.flush()
    assert eng.clock.counts["embedded"] == 4          # 2 pistes × 2 visages, au lieu de 8
    assert eng.clock.counts["lean_shots"] == 1
    assert sorted(r[3].faces for r in rows) == [2, 2]
    assert all(r[3].presence == 1.0 for r in rows)    # la présence compte toutes les images
    # Les deux empreintes de chaque piste sont bien les meilleurs visages (qualités 0,8 et 0,6).
    for _, _, _, s in rows:
        assert abs(s.quality - 0.7) < 1e-6


def test_plan_douteux_suit_la_regle_complete():
    rng = np.random.default_rng(2)
    a, b = unit(rng), unit(rng)
    # Deux personnes différentes qui ne sont jamais sur la même image : sans empreinte, le seul
    # recouvrement ne peut dire si c'est un même visage qui a bougé.
    frames = [[face(0, rng, a)], [face(400, rng, b)], [face(400, rng, b)]]
    tr = link(frames)
    assert needs_full(tr)
    # Même résultat que l'ancienne règle (tous les visages empreintés, pistes avec empreintes).
    old = [[face(f.box[0], base=f.crop) for f in fr] for fr in frames]
    eng = engine()
    sf = ShotFaces(eng, eng.clock, faces_per_track=1)
    sf.add(0.0, 6.0, frames)
    rows = sf.flush()
    assert eng.clock.counts["embedded"] == 3 and eng.clock.counts["full_shots"] == 1
    for fr in old:
        for f in fr:
            f.emb = f.crop / np.linalg.norm(f.crop)
    ref = [summarize(t, 3) for t in link(old)]
    assert sorted((r[3].faces, r[3].presence) for r in rows) == sorted((s.faces, s.presence) for s in ref)


def test_lien_moyen_sans_empreinte_est_douteux():
    rng = np.random.default_rng(3)
    a = unit(rng)
    # Recouvrement ~0,33 : la règle complète l'aurait confirmé par l'empreinte.
    tr = link([[face(0, rng, a)], [face(30, rng, a)]])
    assert len(tr) == 1 and tr[0].weak and needs_full(tr)
    # Recouvrement franc : rien de douteux.
    tr = link([[face(0, rng, a)], [face(5, rng, a)]])
    assert not tr[0].weak and not needs_full(tr)


# --- 2. lots ------------------------------------------------------------------------------------


def test_les_empreintes_partent_par_lots_de_plusieurs_plans():
    rng = np.random.default_rng(4)
    eng = engine(batch=8)
    sf = ShotFaces(eng, eng.clock, faces_per_track=1, batch=8)
    out = []
    for k in range(20):  # 20 plans d'une piste chacun
        out += sf.add(float(k), k + 1.0, [[face(0, rng, unit(rng))], [face(2, rng, unit(rng))]])
    out += sf.flush()
    assert len(out) == 20
    assert eng.embedder.calls == [8, 8, 4]  # trois appels au lieu de vingt


class _PerSample:
    """Session factice : un « réseau » qui calcule chaque image du lot à part (comme ArcFace
    à l'inférence), et qui note la taille des lots reçus."""

    backend = "factice"
    input_name = "x"
    input_shape = [None, 3, 112, 112]
    output_names = ["y"]

    def __init__(self):
        rng = np.random.default_rng(5)
        self.w = rng.standard_normal((3 * 112 * 112, 512)).astype(np.float32) / 300
        self.sizes = []

    def run(self, names, feed):
        x = feed["x"]
        self.sizes.append(len(x))
        return [np.tanh(x.reshape(len(x), -1) @ self.w)]


def test_lots_egaux_au_un_par_un(monkeypatch):
    import app.faces as faces

    monkeypatch.setattr(faces, "_session", lambda path, threads: _PerSample())
    rng = np.random.default_rng(6)
    crops = [rng.integers(0, 255, (112, 112, 3), dtype=np.uint8) for _ in range(37)]
    one = Embedder("x.onnx", 2, batch=1)
    many = Embedder("x.onnx", 2, batch=16)
    a, b = one.embed(crops), many.embed(crops)
    assert many.session.sizes == [16, 16, 5]
    assert np.allclose(a, b, atol=1e-6)


def _tiny_ir(tmp_path):
    """Petit réseau OpenVINO (convolution, ReLU, moyenne, produit) sauvé en IR : de quoi
    vérifier, sans les vrais poids, qu'un lot rend ce que rendent ses images une à une."""
    ov = pytest.importorskip("openvino")
    from openvino import opset13 as ops

    rng = np.random.default_rng(7)
    x = ops.parameter([-1, 3, 112, 112], np.float32, name="input.1")
    w = ops.constant(rng.standard_normal((8, 3, 3, 3)).astype(np.float32))
    c = ops.relu(ops.convolution(x, w, [2, 2], [1, 1], [1, 1], [1, 1]))
    m = ops.reduce_mean(c, ops.constant(np.array([2, 3], np.int64)), False)
    y = ops.matmul(m, ops.constant(rng.standard_normal((8, 512)).astype(np.float32)), False, False)
    y.get_output_tensor(0).set_names({"683"})
    model = ov.Model([y], [x], "tiny")
    path = tmp_path / "tiny.xml"
    ov.save_model(model, str(path))
    return path


def test_openvino_lot_egal_au_un_par_un(tmp_path):
    from app.inference import OvSession

    path = _tiny_ir(tmp_path)
    s = OvSession(path, 3)
    assert s._cfg["INFERENCE_NUM_THREADS"] == 3 and s._cfg["INFERENCE_PRECISION_HINT"] == "f32"
    assert s._cfg["ENABLE_CPU_PINNING"] is False
    rng = np.random.default_rng(8)
    x = rng.standard_normal((5, 3, 112, 112)).astype(np.float32)
    batched = s.run(s.output_names, {s.input_name: x})[0]
    assert batched.shape == (5, 512)  # un seul réseau compilé, lot libre
    single = np.concatenate([s.run(s.output_names, {s.input_name: x[i:i + 1]})[0] for i in range(5)])
    assert np.allclose(batched, single, rtol=1e-5, atol=1e-5)


# --- 3. mémoire de la série ----------------------------------------------------------------------


def test_sortie_anticipee_par_la_memoire():
    rng = np.random.default_rng(9)
    a, b, c = unit(rng), unit(rng), unit(rng)
    mem = np.stack([a, b])
    assert memory_match(a, mem)                    # 1,0 contre ~0
    assert not memory_match(noisy(rng, a, 2.0), mem)  # trop loin de tous
    # Proche de deux personnes à la fois : pas d'avance suffisante.
    ab = (a + b) / np.linalg.norm(a + b)
    assert not memory_match(ab, mem)
    assert not memory_match(a, None) and not memory_match(a, np.zeros((0, 512), np.float32))
    assert EARLY_SIM >= 0.6 and EARLY_MARGIN >= 0.25

    frames = [[face(0, base=a, quality=q), face(300, base=c, quality=q)] for q in (0.9, 0.5, 0.4)]
    eng = engine()
    sf = ShotFaces(eng, eng.clock, faces_per_track=2, memory=mem)
    sf.add(0.0, 8.0, frames)
    rows = sf.flush()
    # La piste de `a` (en mémoire) s'arrête à un visage ; celle de `c` (inconnu) en prend deux.
    assert eng.clock.counts["early_exit"] == 1 and eng.clock.counts["embedded"] == 3
    assert sorted(r[3].faces for r in rows) == [1, 2]
    assert all(r[3].presence == 1.0 for r in rows)


# --- 4. plages sautées ----------------------------------------------------------------------------


def test_morceaux_hors_des_plages_sautees():
    assert segments.pieces(0, 120, []) == [(0, 120)]
    assert segments.pieces(0, 120, [(30, 90)]) == [(0, 30), (90, 120)]
    assert segments.pieces(0, 120, [(0, 200)]) == []
    assert segments.pieces(120, 240, [(100, 130), (200, 239.8)]) == [(130, 200)]  # miette de 0,2 s sautée
    assert segments.pieces(0, 120, [(50, 60), (55, 70)]) == [(0, 50), (70, 120)]


def test_segments_de_jellyfin():
    data = {"Items": [
        {"Type": "Intro", "StartTicks": 2082984732, "EndTicks": 2248083923},
        {"Type": "Outro", "StartTicks": 25021054573, "EndTicks": 25513600000},
        {"Type": "Commercial", "StartTicks": 10_000_000, "EndTicks": 20_000_000},
        {"Type": "Intro", "StartTicks": 2082984732, "EndTicks": 2248083923},  # doublon
        {"Type": "Recap", "StartTicks": "x"},
    ]}
    got = segments.parse_segments(data)
    assert [(round(a, 1), round(b, 1)) for a, b in got] == [(208.3, 224.8), (2502.1, 2551.4)]
    assert segments.parse_segments(None) == [] and segments.parse_segments({"Items": None}) == []


def test_skip_dans_l_ordre():
    assert check_skip(None) is None
    assert check_skip([]) == []
    assert check_skip([{"start": 0, "end": 62.5}]) == [(0.0, 62.5)]
    for bad in ([{"start": 5, "end": 5}], [{"start": -1, "end": 5}], [{"start": "0", "end": 5}],
                [{"start": 0, "end": math.inf}], "0-60", [[0, 60]], [{"start": 0, "end": 1}] * 33,
                [{"start": True, "end": 5}]):
        with pytest.raises(InvalidJob):
            check_skip(bad)
    spec = validate_job(job(skip=[{"start": 10, "end": 20}]), MEDIA)
    assert spec.skip == [(10.0, 20.0)]
    assert validate_job(job(), MEDIA).skip is None


def test_skip_garde_avec_l_ordre(client):
    import json as _json

    r = client.post("/jobs", json=job(skip=[{"start": 0, "end": 30}]), headers=AUTH)
    assert r.status_code == 202
    row = client.db.one("SELECT skip_json FROM items WHERE item_id=?", (ITEM,))
    assert _json.loads(row["skip_json"]) == [[0.0, 30.0]]
    assert client.post("/jobs", json=job(item="d" * 32, skip=[{"start": 3}]), headers=AUTH).status_code == 400
    client.post("/jobs", json=job(item="e" * 32), headers=AUTH)
    assert client.db.one("SELECT skip_json FROM items WHERE item_id=?", ("e" * 32,))["skip_json"] is None


def test_troncon_entierement_saute(db):
    from app.worker import Worker

    w = Worker(db, store=None, models=None, guard=None)
    w.skips = [(2500.0, 2551.4)]
    shots, tracks, decoder, clock = w.process_chunk("a" * 32, "/media/x.mkv", None, 21, 2520.0, 2551.36)
    assert (shots, tracks, decoder) == ([], [], "skip")
    assert clock.seconds["skipped"] == pytest.approx(31.36)


def test_reprise_lit_les_plages_gardees(db):
    from app.worker import Worker

    w = Worker(db, store=None, models=None, guard=None)
    row = {"skip_json": "[[60, 90], [10, 20]]"}

    class R(dict):
        def keys(self):
            return super().keys()

    assert w._skips("a" * 32, R(row)) == [(10.0, 20.0), (60.0, 90.0)]
    # Ni plages ni Jellyfin configuré : rien n'est sauté.
    assert w._skips("a" * 32, R({"skip_json": None})) == []


# --- 5. plans fixes --------------------------------------------------------------------------------


def _nv12(y, w=64, h=36):
    f = np.full((h * 3 // 2, w), 128, np.uint8)
    f[:h] = y
    return f


def test_plan_fixe_deux_images():
    rng = np.random.default_rng(10)
    base = rng.integers(40, 200, (36, 64)).astype(np.uint8)
    sp = ShotSplitter(64, 36, 0.25)
    for i in range(40):  # 10 s d'une image immobile, au grain près
        sp.push(i * 0.25, _nv12(np.clip(base.astype(int) + rng.integers(-2, 3, base.shape), 0, 255)))
    shot = sp.flush(10.0)
    assert shot.static
    assert frames_to_sample(10.0) == 3 and frames_to_sample(10.0, static=True) == 2
    assert frames_to_sample(60.0, static=True) == 2
    assert frames_to_sample(1.5, static=True) == 2 and frames_to_sample(0.5, static=True) == 1
    assert pick_indices(40, 2) == [10, 30]

    # Quelqu'un traverse le cadre : le plan n'est plus fixe.
    sp = ShotSplitter(64, 36, 0.25)
    for i in range(40):
        y = base.copy()
        if 10 <= i < 30:
            x = (i - 10) * 2
            y[6:30, x:x + 14] = 20
        sp.push(i * 0.25, _nv12(y))
    assert not sp.flush(10.0).static


# --- 6. fils ---------------------------------------------------------------------------------------


def test_fils_bornes_partout(monkeypatch):
    info = MediaInfo(duration=100, codec="hevc", profile="Main", width=1920, height=1080, pix_fmt="yuv420p")
    for vaapi in (True, False):
        cmd = build_command("/media/x.mkv", 0, 120, info, vaapi, 4, 640, 6)
        assert cmd[cmd.index("-filter_threads") + 1] == "6"
    cmd = build_command("/media/x.mkv", 0, 120, info, False, 4, 640, 6)
    assert cmd[cmd.index("-threads") + 1] == "6"
    monkeypatch.setenv("XRAY_THREADS", "8")
    from app.config import Settings

    assert Settings().threads == 8
    monkeypatch.setenv("XRAY_THREADS", "0")
    assert Settings().threads == 1


def test_onnxruntime_respecte_les_fils(monkeypatch):
    import app.inference as inf

    seen = {}

    class FakeOrt:
        class SessionOptions:
            pass

        class ExecutionMode:
            ORT_SEQUENTIAL = 0

        class GraphOptimizationLevel:
            ORT_ENABLE_ALL = 99

        @staticmethod
        def set_default_logger_severity(n):
            pass

        @staticmethod
        def disable_telemetry_events():
            pass

        class InferenceSession:
            def __init__(self, path, sess_options, providers):
                seen["threads"] = sess_options.intra_op_num_threads
                seen["providers"] = providers

            def get_inputs(self):
                class I:
                    name, shape = "x", [None, 3, 112, 112]
                return [I()]

            def get_outputs(self):
                class O:
                    name = "y"
                return [O()]

    import sys

    monkeypatch.setitem(sys.modules, "onnxruntime", FakeOrt)
    s = inf.open_session("x.onnx", 5, "onnxruntime")
    assert s.backend == "onnxruntime" and seen == {"threads": 5, "providers": ["CPUExecutionProvider"]}
    # OpenVINO demandé mais en échec sur ce fichier : ONNX Runtime prend le relais.
    s = inf.open_session("/nonexistent.onnx", 5, "openvino")
    assert s.backend == "onnxruntime"


def test_detection_par_lot_redonne_les_sorties_image_par_image():
    # SCRFD range un lot en (hauteur, largeur, lot, ancre) : `split_batched` doit redonner, pour
    # chaque image, exactement ce qu'un lot de 1 aurait rendu (hauteur, largeur, ancre).
    from app.faces import split_batched

    rng = np.random.default_rng(11)
    tw, th, n, A = 64, 32, 3, 2
    strides = [8, 16, 32]
    singles = []  # par image : 9 sorties (scores, boîtes, points)
    for _ in range(n):
        outs = []
        for c in (1, 4, 10):
            for st in strides:
                outs.append(rng.standard_normal(((th // st) * (tw // st) * A, c)).astype(np.float32))
        singles.append(outs)
    batched = []
    for j in range(9):
        st = strides[j % 3]
        gh, gw = th // st, tw // st
        c = singles[0][j].shape[1]
        z = np.stack([singles[k][j].reshape(gh, gw, A, c) for k in range(n)], axis=2)  # H, W, N, A, C
        batched.append(z.reshape(-1, c))
    per = split_batched(batched, n, strides, 3, A, tw, th)
    for k in range(n):
        for j in range(9):
            assert np.array_equal(per[k][j], singles[k][j])


def test_detection_par_lot_sans_moteur_capable_image_par_image():
    from app.faces import Scrfd

    class S:
        batchable = False

    det = Scrfd.__new__(Scrfd)
    det.session = S()
    det.anchors = 2
    calls = []
    det.detect = lambda im: calls.append(im.shape) or []
    assert det.detect_batch([np.zeros((36, 64, 3), np.uint8)] * 3) == [[], [], []]
    assert len(calls) == 3


def test_images_detectees_par_lots_de_plans():
    from app import pipeline

    class Det:
        def __init__(self):
            self.calls = []

        def detect_batch(self, imgs):
            self.calls.append(len(imgs))
            return [[] for _ in imgs]

    eng = engine()
    eng.detector = Det()
    sf = ShotFaces(eng, eng.clock)
    img = np.zeros((36, 64, 3), np.uint8)
    for k in range(7):  # 7 plans de 3 images = 21 images
        sf.add_images(float(k), k + 1.0, [img] * 3)
    sf.flush()
    assert eng.detector.calls == [pipeline.DETECT_BATCH, pipeline.DETECT_BATCH, 5]
    assert eng.clock.counts["images"] == 21


# --- 7. fichier remplacé de même durée ---------------------------------------------------------------


def _done(client, duration=2551.36):
    client.post("/jobs", json=job(), headers=AUTH)
    client.db.run("UPDATE items SET status='done', duration=? WHERE item_id=?", (duration, ITEM))
    client.db.run("INSERT INTO results (item_id, etag, model, scenes_json, analyzed_until, progress, complete, updated, version)"
                  " VALUES (?, 'etag-1', 'buffalo_l', '[]', ?, 1, 1, 0, 3)", (ITEM, duration))


def test_reprise_d_un_fichier_remplace_de_meme_duree(client):
    _done(client)
    r = client.post("/jobs", json=job(etag="etag-2", rebindIfSameDuration=True, durationS=2551.9), headers=AUTH)
    assert r.status_code == 200 and r.json()["status"] == "done"
    it = client.get(f"/items/{ITEM}", headers=AUTH).json()
    assert it["etag"] == "etag-2" and it["status"] == "done" and it["durationS"] == 2551.36
    assert client.get(f"/items/{ITEM}/scenes", headers=AUTH).json()["etag"] == "etag-2"


def test_pas_de_reprise_hors_tolerance_ou_sans_demande(client):
    _done(client)
    r = client.post("/jobs", json=job(etag="etag-2", rebindIfSameDuration=True, durationS=2553.0), headers=AUTH)
    assert r.status_code == 202 and r.json()["status"] == "queued"
    assert client.get(f"/items/{ITEM}/scenes", headers=AUTH).status_code == 404  # oublié, comme avant


def test_pas_de_reprise_sans_demande(client):
    _done(client)
    r = client.post("/jobs", json=job(etag="etag-2", durationS=2551.36), headers=AUTH)
    assert r.status_code == 202


def test_reprise_sur_la_fin_analysee_si_duree_absente(client):
    _done(client)
    client.db.run("UPDATE items SET duration=NULL WHERE item_id=?", (ITEM,))
    r = client.post("/jobs", json=job(etag="etag-2", rebindIfSameDuration=True, durationS=2551.0), headers=AUTH)
    assert r.status_code == 200


def test_reprise_validee():
    for bad in ({"rebindIfSameDuration": True}, {"rebindIfSameDuration": True, "durationS": -3},
                {"rebindIfSameDuration": "oui", "durationS": 10}):
        with pytest.raises(InvalidJob):
            validate_job(job(**bad), MEDIA)
