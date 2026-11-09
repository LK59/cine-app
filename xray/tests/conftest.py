"""Environnement de test : une médiathèque factice, une clé, aucun modèle ni réseau.

Les variables sont posées avant le premier import de `app` : `settings` les lit à l'import.
"""

import os
import tempfile
from pathlib import Path

import numpy as np
import pytest

_ROOT = Path(tempfile.mkdtemp(prefix="xray-test-"))
MEDIA = _ROOT / "media"
OUTSIDE = _ROOT / "outside"
(MEDIA / "tv" / "Show").mkdir(parents=True)
OUTSIDE.mkdir()
(MEDIA / "tv" / "Show" / "S01E01.mkv").write_bytes(b"\x1aE\xdf\xa3")
(MEDIA / "tv" / "Show" / "notes.txt").write_text("x")
(OUTSIDE / "secret.mkv").write_bytes(b"x")
os.symlink(OUTSIDE / "secret.mkv", MEDIA / "tv" / "Show" / "lien.mkv")

os.environ["XRAY_API_KEY"] = "cle-de-test"
os.environ["XRAY_MEDIA_ROOT"] = str(MEDIA)
os.environ["XRAY_DATA_DIR"] = str(_ROOT / "data")
os.environ["XRAY_HWACCEL"] = "0"
os.environ.pop("JELLYFIN_URL", None)

from app.db import Database  # noqa: E402
from app.main import create_app  # noqa: E402

EPISODE = str(MEDIA / "tv" / "Show" / "S01E01.mkv")
ITEM = "a" * 32
ITEM2 = "b" * 32
AUTH = {"Authorization": "Bearer cle-de-test"}


class FakeModels:
    name = "buffalo_l"
    ready = True
    license = "non-commercial"
    error = None

    def start(self):
        pass


def job(item=ITEM, **over):
    body = {
        "itemId": item,
        "path": EPISODE,
        "etag": "etag-1",
        "priority": "normal",
        "startAt": 0,
        "seriesId": "c" * 32,
        "cast": [
            {"personId": 1, "name": "Actrice", "character": "Rôle", "order": 0,
             "photos": ["https://image.tmdb.org/t/p/w185/a.jpg"]},
        ],
    }
    body.update(over)
    return body


@pytest.fixture
def db():
    d = Database(":memory:")
    yield d
    d.close()


@pytest.fixture
def client(db):
    from fastapi.testclient import TestClient

    app = create_app(start_background=False, db=db, models=FakeModels())
    with TestClient(app) as c:
        c.db = db
        yield c


def unit(rng, d=512):
    v = rng.standard_normal(d).astype(np.float32)
    return v / np.linalg.norm(v)


def noisy(rng, base, amount):
    v = base + amount * unit(rng, base.shape[0])
    return (v / np.linalg.norm(v)).astype(np.float32)
