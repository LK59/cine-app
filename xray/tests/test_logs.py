"""Le journal du service (logs.py) : une ligne JSON par événement, rotation, et jamais un secret."""

import json
import logging

import pytest

from app import logs, segments
from app.config import settings

FAKE_KEY = "fausse-cle-0123456789abcdef-NE-DOIT-PAS-SORTIR"
FAKE_JF = "jeton-jellyfin-fedcba9876543210"
FAKE_ENV = "secret-env-5f4e3d2c1b0a"


def _logger(tmp_path, max_bytes=logs.MAX_BYTES, backups=logs.BACKUPS):
    lg = logging.getLogger(f"xray.test.{tmp_path.name}")
    lg.handlers.clear()
    lg.propagate = False
    lg.setLevel(logging.DEBUG)
    h = logs.file_handler(tmp_path, max_bytes, backups)
    lg.addHandler(h)
    return lg, h


def _lines(path):
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]


def test_une_ligne_json_par_evenement(tmp_path):
    lg, h = _logger(tmp_path)
    item = "a" * 32
    logs.event(lg, "[xray] %s : tronçon %d fait", item, 3, item=item, chunk=3, decoder="vaapi", device="gpu")
    lg.info("[xray] %s : ligne d'avant, sans champs", "b" * 32)
    try:
        raise RuntimeError("panne de test")
    except RuntimeError:
        logs.event(lg, "échec", level=logging.ERROR, item=item, exc_info=True, action="job_failed")
    h.flush()
    a, b, c = _lines(tmp_path / logs.LOG_NAME)
    assert {"ts", "level", "scope", "msg", "thread"} <= set(a)
    assert a["level"] == "info" and a["scope"] == f"test.{tmp_path.name}"
    assert a["itemId"] == item and a["chunk"] == 3 and a["decoder"] == "vaapi" and a["device"] == "gpu"
    assert a["msg"] == f"[xray] {item} : tronçon 3 fait"
    # L'élément d'une ligne de l'ouvrier est repris de son message.
    assert b["itemId"] == "b" * 32
    assert c["level"] == "error" and c["error"] == "RuntimeError: panne de test"
    assert "Traceback" in c["stack"] and "panne de test" in c["stack"]


def test_rotation_bornee(tmp_path):
    lg, h = _logger(tmp_path, max_bytes=2000, backups=2)
    for i in range(300):
        logs.event(lg, "ligne %d", i, n=i, pad="x" * 40)
    h.flush()
    names = sorted(p.name for p in tmp_path.iterdir())
    assert names == ["xray.log", "xray.log.1", "xray.log.2"]
    for p in tmp_path.iterdir():
        assert p.stat().st_size <= 2000 + 400
        for d in _lines(p):  # chaque ligne reste un objet entier après rotation
            assert d["msg"].startswith("ligne ")
    # La plus récente dans xray.log, puis .1, puis .2.
    last = _lines(tmp_path / "xray.log")[-1]["n"]
    assert last == 299
    assert _lines(tmp_path / "xray.log.1")[-1]["n"] < _lines(tmp_path / "xray.log")[0]["n"]


def test_aucun_secret_ne_sort(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(settings, "api_key", FAKE_KEY)
    monkeypatch.setattr(settings, "jellyfin_api_key", FAKE_JF)
    monkeypatch.setenv("XRAY_TEST_SECRET_TOKEN", FAKE_ENV)
    lg, h = _logger(tmp_path)
    text = logging.StreamHandler()
    text.setFormatter(logs.TextFormatter())
    lg.addHandler(text)
    logs.event(lg, "clé reçue %s", FAKE_KEY, key=FAKE_KEY, nested={"jf": FAKE_JF, "list": [FAKE_ENV]})
    lg.info("en-tête Authorization: Bearer %s", "autre-jeton-inconnu-123")
    lg.info('Jellyfin : MediaBrowser Token="%s"', "jeton-inconnu-456")
    lg.warning("adresse http://jf/Items?api_key=%s&x=1", "cle-dans-l-url-789")
    try:
        raise ValueError(f"échec avec {FAKE_JF} et \"{FAKE_KEY}\"")
    except ValueError:
        lg.exception("échec")
    h.flush()
    raw = (tmp_path / logs.LOG_NAME).read_text(encoding="utf-8")
    err = capsys.readouterr().err
    for out in (raw, err):
        for secret in (FAKE_KEY, FAKE_JF, FAKE_ENV, "autre-jeton-inconnu-123", "jeton-inconnu-456", "cle-dans-l-url-789"):
            assert secret not in out
        assert logs.MASK in out
    for d in _lines(tmp_path / logs.LOG_NAME):  # toujours du JSON valide après nettoyage
        assert "msg" in d


def test_le_journal_du_service_ne_porte_aucune_cle(client, monkeypatch):
    """Le fichier installé par le service (XRAY_DATA_DIR/logs/xray.log) : une vraie requête Jellyfin en
    échec, un ordre reçu et une erreur ne laissent aucune clé derrière eux."""
    from app.main import log_path

    assert log_path is not None and log_path.name == "xray.log"
    monkeypatch.setattr(settings, "jellyfin_url", "http://127.0.0.1:9")
    monkeypatch.setattr(settings, "jellyfin_api_key", FAKE_JF)
    monkeypatch.setenv("XRAY_FAKE_API_KEY", FAKE_ENV)
    assert segments.fetch_jellyfin("a" * 32) is None  # connexion refusée : une ligne d'avertissement
    from conftest import AUTH, job

    assert client.post("/jobs", json=job(), headers=AUTH).status_code == 202
    logging.getLogger("xray.worker").error("boum %s %s", FAKE_JF, FAKE_ENV)
    for h in logging.getLogger().handlers:
        h.flush()
    raw = log_path.read_text(encoding="utf-8")
    assert "ordre reçu" in raw and "Jellyfin /MediaSegments" in raw
    for secret in (FAKE_JF, FAKE_ENV, settings.api_key):
        assert secret not in raw
    received = [d for d in _lines(log_path) if d.get("action") == "job_received"][-1]
    assert received["priority"] == "normal" and received["itemId"] == "a" * 32 and received["startAt"] == 0


@pytest.mark.parametrize("bad", ["", "abc"])
def test_valeurs_courtes_ignorees(bad, monkeypatch):
    # Une clé vide ou très courte ne transforme pas chaque « abc » du journal en «secret».
    monkeypatch.setattr(settings, "api_key", bad)
    assert logs.redact("abc def") == "abc def"
