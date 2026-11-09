"""Inférence sur l'iGPU (en option) : paliers de lot, formes bornées, retour au processeur
pendant une transcodification de Jellyfin, photos toujours sur le processeur.

Sans iGPU dans la construction, `OvGpuSession` est exercée sur le plugin CPU d'OpenVINO
(`device="CPU"`) : la logique des paliers et des formes est la même."""

import numpy as np
import pytest

from test_speed import _tiny_ir


def _gpu(path, **kw):
    from app.inference import OvGpuSession

    return OvGpuSession(path, device="CPU", precision="f32", **kw)


def test_paliers_de_lot_completes(tmp_path):
    from app.inference import OvSession

    path = _tiny_ir(tmp_path)
    ref = OvSession(path, 2)
    g = _gpu(path, buckets=(1, 8, 32), pad=True)
    rng = np.random.default_rng(1)
    for n in (1, 5, 8, 13, 32):
        x = rng.standard_normal((n, 3, 112, 112)).astype(np.float32)
        got = g.run(g.output_names, {g.input_name: x})[0]
        assert got.shape == (n, 512)
        assert np.allclose(got, ref.run(ref.output_names, {ref.input_name: x})[0], rtol=1e-4, atol=1e-4)
    # Trois formes seulement, une par palier (5 → 8, 13 → 32).
    assert sorted(s[0] for s in g.compiled_shapes) == [1, 8, 32]
    assert not g.accepts_batch(33)


def test_formes_bornees_les_plus_anciennes_liberees(tmp_path):
    g = _gpu(_tiny_ir(tmp_path), buckets=(1, 8, 32), pad=True, max_shapes=2)
    x = lambda n: {g.input_name: np.zeros((n, 3, 112, 112), np.float32)}  # noqa: E731
    g.run(g.output_names, x(8))
    g.run(g.output_names, x(32))
    g.run(g.output_names, x(8))   # 8 redevient la plus récente
    g.run(g.output_names, x(1))   # 32 part
    assert [s[0] for s in g.compiled_shapes] == [8, 1]


def test_detecteur_sans_complement(tmp_path):
    g = _gpu(_tiny_ir(tmp_path), buckets=(1, 8), pad=False)
    assert g.accepts_batch(1) and g.accepts_batch(8) and not g.accepts_batch(5)
    with pytest.raises(ValueError):
        g.run(g.output_names, {g.input_name: np.zeros((5, 3, 112, 112), np.float32)})


class _Fake:
    def __init__(self, names, tag):
        self.input_name, self.input_shape, self.output_names = "x", [None, 3, 4, 4], names
        self.tag, self.calls = tag, []

    def accepts_batch(self, n):
        return n in (1, 8)

    def run(self, names, feed):
        self.calls.append((tuple(names), len(next(iter(feed.values())))))
        return [f"{self.tag}:{n}" for n in names]


def test_bascule_sur_le_processeur_pendant_une_transcodification():
    from app.inference import RoutedSession, cpu_only

    busy = {"v": False}
    gpu = _Fake(["score", "bbox"], "gpu")
    cpu = _Fake(["score_q", "bbox_q"], "cpu")  # l'IR INT8 : autres noms, même ordre
    made = []
    r = RoutedSession(gpu, lambda: made.append(1) or cpu, lambda: not busy["v"], "détecteur")
    x = {"x": np.zeros((8, 3, 4, 4), np.float32)}
    assert r.run(["score", "bbox"], x) == ["gpu:score", "gpu:bbox"]
    assert made == []  # le réseau du processeur n'est créé qu'au besoin
    busy["v"] = True  # Jellyfin transcode
    assert r.accepts_batch(5)  # sur le processeur, tout lot passe
    assert r.run(["bbox"], x) == ["cpu:bbox_q"]
    busy["v"] = False
    assert r.run(["score"], x) == ["gpu:score"]
    # Un lot hors palier passe par le processeur, même iGPU libre.
    assert r.run(["score"], {"x": np.zeros((5, 3, 4, 4), np.float32)}) == ["cpu:score_q"]
    with cpu_only():
        assert r.run(["score"], x) == ["cpu:score_q"]
    assert made == [1]
    # Un garde en échec ne bloque rien : processeur.
    r.use_gpu = lambda: 1 / 0
    assert r.run(["score"], x) == ["cpu:score_q"]


def test_igpu_absent_retour_au_processeur(tmp_path, caplog):
    from app.inference import OvSession, make_session

    path = _tiny_ir(tmp_path)
    s = make_session(path, 2, "auto", gpu={"device": "PERIPHERIQUE_ABSENT", "buckets": (1, 8)})
    assert isinstance(s, OvSession) and s.gpu_error


def test_ir_int8_illisible_retour_au_reseau_d_origine(tmp_path):
    from app.inference import OvSession, make_session

    path = _tiny_ir(tmp_path)
    bad = tmp_path / "abime.xml"
    bad.write_text("<net>")
    s = make_session(path, 2, "auto", cpu_path=bad)
    assert isinstance(s, OvSession) and s.path == path
    s = make_session(path, 2, "auto", cpu_path=path)
    assert s.path == path


def test_detection_image_par_image_hors_palier():
    from app.faces import Scrfd

    class S:
        batchable = True

        def accepts_batch(self, n):
            return n in (1, 8)

    det = Scrfd.__new__(Scrfd)
    det.session = S()
    det.anchors = 2
    calls = []
    det.detect = lambda im: calls.append(im.shape) or []
    assert det.detect_batch([np.zeros((36, 64, 3), np.uint8)] * 5) == [[]] * 5
    assert len(calls) == 5


def test_photos_toujours_sur_le_processeur():
    from app.faces import FaceEngine
    from app.inference import _forced_cpu

    seen = []

    class Det:
        def detect(self, img):
            seen.append(_forced_cpu())
            return []

    eng = FaceEngine("buffalo_l", Det(), embedder=None)
    assert eng.best_face_embedding(np.zeros((300, 200, 3), np.uint8)) is None
    assert seen == [True] and not _forced_cpu()


def test_garde_sans_requete():
    from app.gpu_guard import GpuGuard

    g = GpuGuard()
    assert g.busy_now() is False  # sans Jellyfin configuré : iGPU libre
    g._busy = True
    assert g.busy_now() is False  # toujours : le garde n'est pas actif


def test_reglage_du_peripherique(monkeypatch):
    from app.config import Settings

    assert Settings().ov_device == "CPU"
    monkeypatch.setenv("XRAY_OV_DEVICE", " gpu ")
    assert Settings().ov_device == "GPU"
