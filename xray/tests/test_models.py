"""Poids des modèles : jamais retéléchargés s'ils sont là, refusés s'ils ne correspondent pas."""

import hashlib

import pytest

from app import models
from app.models import ModelError, ModelFile, ModelManager


@pytest.fixture
def fake_spec(monkeypatch, tmp_path):
    good = b"poids-factices"
    spec = {
        "license": "apache-2.0",
        "detector": "det.onnx",
        "embedder": "emb.onnx",
        "files": [
            ModelFile("det.onnx", hashlib.sha256(good).hexdigest(), urls=("https://exemple.invalid/det.onnx",)),
            ModelFile("emb.onnx", hashlib.sha256(good).hexdigest(), urls=("https://exemple.invalid/emb.onnx",)),
        ],
    }
    monkeypatch.setitem(models.MODELS, "factice", spec)
    calls = []

    def fake_download(url, dest):
        calls.append(url)
        dest.write_bytes(good)

    monkeypatch.setattr(models, "_download", fake_download)
    return good, calls, tmp_path


def test_telecharge_puis_ne_retelecharge_plus(fake_spec):
    good, calls, root = fake_spec
    m = ModelManager("factice", root)
    m.prepare()
    assert m.ready and m.error is None and len(calls) == 2
    assert (root / "factice" / "det.onnx").read_bytes() == good
    m2 = ModelManager("factice", root)
    m2.prepare()
    assert m2.ready and len(calls) == 2


def test_fichier_present_altere_refuse(fake_spec):
    _, calls, root = fake_spec
    (root / "factice").mkdir()
    (root / "factice" / "det.onnx").write_bytes(b"autre chose")
    m = ModelManager("factice", root)
    with pytest.raises(ModelError):
        m.prepare()
    assert not m.ready and calls == []
    # Il n'est pas écrasé : c'est à l'installateur de le supprimer.
    assert (root / "factice" / "det.onnx").read_bytes() == b"autre chose"


def test_telechargement_altere_refuse(monkeypatch, fake_spec):
    _, _, root = fake_spec
    monkeypatch.setattr(models, "_download", lambda url, dest: dest.write_bytes(b"pirate"))
    m = ModelManager("factice", root)
    with pytest.raises(RuntimeError):
        m.prepare()
    assert not m.ready
    assert not (root / "factice" / "det.onnx").exists()


def test_modele_inconnu(tmp_path):
    with pytest.raises(ModelError):
        ModelManager("autre", tmp_path)


def test_empreintes_figees():
    # Les empreintes sont fixées dans le code, jamais lues ailleurs.
    for name, spec in models.MODELS.items():
        for f in spec["files"]:
            assert len(f.sha256) == 64, (name, f.name)
    assert models.MODELS["buffalo_l"]["license"] == "non-commercial"
    assert models.MODELS["auraface"]["license"] == "apache-2.0"
