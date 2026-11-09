"""Détecteur INT8 produit sur place : choix des titres, vérification, inventaire, reprise,
repli en float32 — et une vraie quantification NNCF sur un petit réseau."""

import json
from pathlib import Path

import numpy as np
import pytest

from app import quantize as q
from app.faces import Face


def _tree(root: Path):
    for d in ("movies/Film A (2001)", "movies/Film B (2002)", "movies/Vide", "tv/Série/Saison 1", "tv/Autre"):
        (root / d).mkdir(parents=True, exist_ok=True)
    (root / "movies/Film A (2001)/Film A.mkv").write_bytes(b"x")
    (root / "movies/Film A (2001)/Film A.srt").write_text("x")
    (root / "movies/Film B (2002)/Film B.mp4").write_bytes(b"x")
    (root / "tv/Série/Saison 1/E02.mkv").write_bytes(b"x")
    (root / "tv/Série/Saison 1/E01.mkv").write_bytes(b"x")
    (root / "tv/Autre/.cache.mkv").write_bytes(b"x")
    (root / "court.mkv").write_bytes(b"x")


def test_titres_un_par_dossier_tirage_fixe(tmp_path):
    _tree(tmp_path)
    got = q.pick_titles(tmp_path, n=10)
    names = sorted(p.name for p in got)
    assert names == ["E01.mkv", "Film A.mkv", "Film B.mp4", "court.mkv"]
    assert q.pick_titles(tmp_path, n=10) == got  # même graine, même choix
    assert len(q.pick_titles(tmp_path, n=2)) == 2
    assert q.pick_titles(tmp_path / "absent") == []


def test_canevas_du_detecteur():
    img = np.full((268, 640, 3), 7, np.uint8)  # 2,39:1
    c = q.canvas(img)
    assert c.shape == (384, 640, 3) and c[:268].min() == 7 and c[268:].max() == 0
    tall = np.full((480, 640, 3), 9, np.uint8)
    assert q.canvas(tall).shape == (384, 640, 3)


def _face(x, y, s, score=0.9):
    return Face(box=np.array([x, y, x + s, y + s], np.float32), score=score, kps=np.zeros((5, 2), np.float32))


def test_verification_et_refus():
    ref = [[_face(0, 0, 50), _face(100, 0, 50), _face(300, 0, 20)]] * 10  # le 3e : trop petit
    same = [[_face(2, 1, 50), _face(101, 0, 49)]] * 10
    c = q.compare(ref, same)
    assert c == {"faces": 20, "found": 20, "extra": 0, "candFaces": 20, "recall": 1.0}
    assert q.accept(c) is None
    lost = [[_face(2, 1, 50)]] * 10
    assert "10 visages sur 20" in q.accept(q.compare(ref, lost))
    extra = [[_face(2, 1, 50), _face(101, 0, 49), _face(400, 200, 60)]] * 10
    assert "de trop" in q.accept(q.compare(ref, extra))
    assert "impossible" in q.accept(q.compare(ref[:3], same[:3]))


def _fake_ir(out: Path, sha="s" * 64):
    out.mkdir(parents=True)
    (out / q.IR_NAME).write_text("<xml/>")
    (out / "det_10g_int8.bin").write_bytes(b"\x00" * 10)
    m = {"recipe": q.RECIPE, "sourceSha256": sha, "files": {p.name: q.sha256_of(p) for p in out.iterdir()},
         "frames": 224, "titles": [], "check": {"found": 1, "faces": 1, "fp32MsPerImage": 1, "int8MsPerImage": 1}}
    (out / "manifest.json").write_text(json.dumps(m))
    return m


def test_inventaire_verifie(tmp_path):
    out = tmp_path / "int8"
    _fake_ir(out)
    assert q.load_manifest(out, "s" * 64) is not None
    assert q.load_manifest(out, "t" * 64) is None  # autre réseau d'origine
    (out / "det_10g_int8.bin").write_bytes(b"\x01" * 10)  # fichier abîmé
    assert q.load_manifest(out, "s" * 64) is None


def test_repris_sans_rien_refaire(tmp_path, monkeypatch):
    out = tmp_path / "int8"
    _fake_ir(out)
    monkeypatch.setattr(q.subprocess, "run", lambda *a, **k: pytest.fail("rien à refaire"))
    path, err = q.ensure(tmp_path / "det_10g.onnx", "s" * 64, out, tmp_path, 2)
    assert path == out / q.IR_NAME and err is None


def test_echec_note_pas_retente(tmp_path, monkeypatch):
    out = tmp_path / "int8"
    q.failed_marker(out).write_text(json.dumps({"recipe": q.RECIPE, "sourceSha256": "s" * 64, "error": "rappel 0,80"}))
    monkeypatch.setattr(q.subprocess, "run", lambda *a, **k: pytest.fail("pas de nouvel essai"))
    path, err = q.ensure(tmp_path / "det_10g.onnx", "s" * 64, out, tmp_path, 2)
    assert path is None and "rappel 0,80" in err and "supprimer" in err
    # Autre recette ou autre réseau : on réessaie.
    calls = []

    class R:
        returncode, stdout, stderr = 3, "12 images de calibrage seulement\n", ""

    monkeypatch.setattr(q.subprocess, "run", lambda *a, **k: calls.append(a) or R())
    path, err = q.ensure(tmp_path / "det_10g.onnx", "u" * 64, out, tmp_path, 2)
    assert path is None and "12 images" in err and len(calls) == 1


def test_calibrage_trop_court_non_note(tmp_path, monkeypatch):
    src = tmp_path / "det.onnx"
    src.write_bytes(b"onnx")
    sha = q.sha256_of(src)
    monkeypatch.setattr(q, "collect_frames", lambda files: ([], []))
    rc = q.main(["--source", str(src), "--sha256", sha, "--out", str(tmp_path / "int8"), "--media", str(tmp_path)])
    assert rc == 3 and not q.failed_marker(tmp_path / "int8").exists()
    assert q.main(["--source", str(src), "--sha256", "0" * 64, "--out", str(tmp_path / "int8"),
                   "--media", str(tmp_path)]) == 2


def test_echec_de_quantification_note(tmp_path, monkeypatch):
    src = tmp_path / "det.onnx"
    src.write_bytes(b"onnx")
    sha = q.sha256_of(src)
    monkeypatch.setattr(q, "collect_frames", lambda files: ([np.zeros((384, 640, 3), np.uint8)] * 100, []))
    monkeypatch.setattr(q, "quantize", lambda *a: (_ for _ in ()).throw(RuntimeError("NNCF a refusé")))
    out = tmp_path / "int8"
    assert q.main(["--source", str(src), "--sha256", sha, "--out", str(out), "--media", str(tmp_path)]) == 1
    assert "NNCF a refusé" in q.read_failure(out, sha)
    assert not out.exists() and not out.with_name("int8.tmp").exists()


def test_quantification_nncf_reelle(tmp_path):
    """Le vrai chemin NNCF → IR → OpenVINO, sur un petit réseau convolutif (pas les poids)."""
    pytest.importorskip("nncf")
    ov = pytest.importorskip("openvino")
    from openvino import opset13 as ops

    from app.inference import OvSession

    rng = np.random.default_rng(3)
    x = ops.parameter([1, 3, -1, -1], np.float32, name="input.1")
    c = ops.relu(ops.convolution(x, ops.constant(rng.standard_normal((8, 3, 3, 3)).astype(np.float32)),
                                 [2, 2], [1, 1], [1, 1], [1, 1]))
    y = ops.convolution(c, ops.constant(rng.standard_normal((2, 8, 1, 1)).astype(np.float32)), [1, 1], [0, 0], [0, 0], [1, 1])
    y.get_output_tensor(0).set_names({"score_8"})
    src = tmp_path / "tiny.xml"
    ov.save_model(ov.Model([y], [x], "tiny"), str(src))
    frames = [rng.integers(0, 255, (384, 640, 3), dtype=np.uint8) for _ in range(6)]
    dest = tmp_path / "out" / q.IR_NAME
    dest.parent.mkdir()
    q.quantize(src, frames, dest)
    text = dest.read_text()
    assert "FakeQuantize" in text or "FakeConvert" in text or "u8" in text or "i8" in text
    a, b = OvSession(src, 2), OvSession(dest, 2)
    assert b.output_names == a.output_names and b.input_name == a.input_name
    blob = q.blob(frames[0])
    ra = a.run(a.output_names, {a.input_name: blob})[0]
    rb = b.run(b.output_names, {b.input_name: blob})[0]
    assert ra.shape == rb.shape
    assert np.corrcoef(ra.ravel(), rb.ravel())[0, 1] > 0.98


def test_int8_voulu_ou_pourquoi_pas(monkeypatch, tmp_path):
    from app.config import settings
    from app.models import ModelManager

    mm = ModelManager("buffalo_l", tmp_path)
    monkeypatch.setattr(settings, "detector_int8", False)
    assert mm.int8_wanted() == "XRAY_DETECTOR_INT8=0"
    monkeypatch.setattr(settings, "detector_int8", True)
    monkeypatch.setattr(settings, "inference", "onnxruntime")
    assert "onnxruntime" in mm.int8_wanted()
    monkeypatch.setattr(settings, "inference", "auto")
    assert "auraface" in ModelManager("auraface", tmp_path).int8_wanted()


def test_echec_int8_reste_en_float32(monkeypatch, tmp_path):
    from app.config import settings
    from app.models import ModelManager

    pytest.importorskip("openvino")
    mm = ModelManager("buffalo_l", tmp_path)
    monkeypatch.setattr(settings, "detector_int8", True)
    monkeypatch.setattr(settings, "inference", "auto")
    monkeypatch.setattr(q, "ensure", lambda *a, **k: (None, "12 images de calibrage seulement"))
    mm._prepare_int8()
    assert mm.int8 == {"state": "failed", "error": "12 images de calibrage seulement"} and mm.int8_path is None
    st = mm.inference_status()
    assert st["detector"] == "fp32" and st["int8"]["state"] == "failed"
    monkeypatch.setattr(q, "ensure", lambda *a, **k: (tmp_path / "x.xml", None))
    mm._prepare_int8()
    assert mm.int8["state"] == "ready" and mm.int8_path == tmp_path / "x.xml"
    assert mm.inference_status()["detector"] == "int8"  # prévu, avant même le chargement des réseaux
