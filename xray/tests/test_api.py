"""Le contrat HTTP avec Laterna : formes des réponses, codes, clé d'accès."""

import json
import time

from app.config import RESULT_VERSION
from conftest import AUTH, EPISODE, ITEM, ITEM2, MEDIA, job


def test_toute_requete_exige_la_cle(client):
    for method, url in [("get", "/health"), ("post", "/jobs"), ("get", f"/items/{ITEM}"),
                        ("get", f"/items/{ITEM}/scenes"), ("delete", f"/items/{ITEM}")]:
        assert getattr(client, method)(url).status_code == 401
        assert getattr(client, method)(url, headers={"Authorization": "Bearer mauvaise"}).status_code == 401
        assert getattr(client, method)(url, headers={"Authorization": "cle-de-test"}).status_code == 401


def test_cle_vide_refuse_tout(client, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "api_key", "")
    assert client.get("/health", headers={"Authorization": "Bearer "}).status_code == 401


def test_health(client):
    r = client.get("/health", headers=AUTH)
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["version"] == "1.0.0"
    assert body["model"] == {"name": "buffalo_l", "ready": True, "license": "non-commercial", "error": None}
    assert body["decode"] == {"vaapi": False, "device": None}
    assert body["queue"] == {"pending": 0, "running": None}


def test_depot_puis_lecture(client):
    r = client.post("/jobs", json=job(), headers=AUTH)
    assert r.status_code == 202
    # File vide, rien en cours : l'ordre commence tout de suite, position 0.
    assert r.json() == {"itemId": ITEM, "status": "queued", "position": 0}
    r = client.get(f"/items/{ITEM}", headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"itemId": ITEM, "etag": "etag-1", "status": "queued", "progress": 0.0,
                        "analyzedUntil": 0.0, "error": None, "stats": None}
    assert client.get("/health", headers=AUTH).json()["queue"]["pending"] == 1


def test_identifiant_en_majuscules_normalise(client):
    r = client.post("/jobs", json=job(item="A" * 32), headers=AUTH)
    assert r.json()["itemId"] == "a" * 32
    assert client.get(f"/items/{'A' * 32}", headers=AUTH).status_code == 200


def test_doublon_ne_fait_que_remonter_la_priorite(client):
    client.post("/jobs", json=job(item=ITEM, priority="low"), headers=AUTH)
    client.post("/jobs", json=job(item=ITEM2, priority="normal"), headers=AUTH)
    assert client.post("/jobs", json=job(item=ITEM, priority="low"), headers=AUTH).json()["position"] == 1
    r = client.post("/jobs", json=job(item=ITEM, priority="high"), headers=AUTH)
    assert r.status_code == 202
    assert r.json() == {"itemId": ITEM, "status": "queued", "position": 0}
    # Une priorité plus basse ne la fait pas redescendre.
    r = client.post("/jobs", json=job(item=ITEM, priority="low"), headers=AUTH)
    assert r.json()["position"] == 0
    assert client.get("/health", headers=AUTH).json()["queue"]["pending"] == 2


def _results(db, item, etag="etag-1", complete=True, version=None):
    scenes = [{"start": 0.0, "end": 12.5, "people": [{"personId": 1, "screenTime": 8.25, "confidence": 0.9}]}]
    db.run("INSERT OR REPLACE INTO results (item_id, etag, model, scenes_json, analyzed_until, progress, complete, updated)"
           " VALUES (?, ?, 'buffalo_l', ?, ?, ?, ?, ?)",
           (item, etag, json.dumps(scenes), 12.5, 1.0 if complete else 0.4, 1 if complete else 0, time.time()))
    if version is not None:
        db.run("UPDATE results SET version=? WHERE item_id=?", (version, item))


def test_deja_fait_au_meme_etag(client):
    client.post("/jobs", json=job(), headers=AUTH)
    client.db.run("UPDATE items SET status='done' WHERE item_id=?", (ITEM,))
    _results(client.db, ITEM)
    r = client.post("/jobs", json=job(priority="high"), headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {"itemId": ITEM, "status": "done", "position": 0}
    r = client.get(f"/items/{ITEM}", headers=AUTH).json()
    assert r["status"] == "done" and r["progress"] == 1.0 and r["analyzedUntil"] == 12.5


def test_autre_etag_oublie_l_ancien_resultat(client):
    client.post("/jobs", json=job(), headers=AUTH)
    client.db.run("UPDATE items SET status='done' WHERE item_id=?", (ITEM,))
    _results(client.db, ITEM)
    client.db.run("INSERT INTO chunks (item_id, idx, start, end, done) VALUES (?, 0, 0, 120, 1)", (ITEM,))
    r = client.post("/jobs", json=job(etag="etag-2"), headers=AUTH)
    assert r.status_code == 202 and r.json()["status"] == "queued"
    assert client.get(f"/items/{ITEM}/scenes", headers=AUTH).status_code == 404
    assert client.db.one("SELECT COUNT(*) FROM chunks WHERE item_id=?", (ITEM,))[0] == 0
    assert client.get(f"/items/{ITEM}", headers=AUTH).json()["etag"] == "etag-2"


def test_echec_relance_au_meme_etag(client):
    client.post("/jobs", json=job(), headers=AUTH)
    client.db.run("UPDATE items SET status='failed', error='x' WHERE item_id=?", (ITEM,))
    r = client.post("/jobs", json=job(), headers=AUTH)
    assert r.status_code == 202 and r.json()["status"] == "queued"
    assert client.get(f"/items/{ITEM}", headers=AUTH).json()["error"] is None


def test_scenes(client):
    assert client.get(f"/items/{ITEM}/scenes", headers=AUTH).status_code == 404
    client.post("/jobs", json=job(), headers=AUTH)
    assert client.get(f"/items/{ITEM}/scenes", headers=AUTH).status_code == 404
    _results(client.db, ITEM, complete=False)
    r = client.get(f"/items/{ITEM}/scenes", headers=AUTH)
    assert r.status_code == 200
    assert r.json() == {
        "itemId": ITEM, "etag": "etag-1", "model": "buffalo_l", "version": 1, "complete": False,
        "analyzedUntil": 12.5,
        "scenes": [{"start": 0.0, "end": 12.5, "people": [{"personId": 1, "screenTime": 8.25, "confidence": 0.9}]}],
    }


def test_version_du_resultat_servie_telle_quelle(client):
    # Un résultat des anciennes règles reste servi, avec sa version : rien n'est réanalysé de
    # soi-même, et un nouvel ordre au même etag ne relance rien.
    client.post("/jobs", json=job(), headers=AUTH)
    _results(client.db, ITEM, complete=True)
    client.db.run("UPDATE items SET status='done', version=1 WHERE item_id=?", (ITEM,))
    assert client.get(f"/items/{ITEM}/scenes", headers=AUTH).json()["version"] == 1
    assert client.post("/jobs", json=job(), headers=AUTH).status_code == 200
    _results(client.db, ITEM, complete=True, version=RESULT_VERSION)
    assert client.get(f"/items/{ITEM}/scenes", headers=AUTH).json()["version"] == RESULT_VERSION == 3


def test_ancienne_base_migree():
    # Une base d'avant la colonne `version` : ses lignes valent 1.
    import sqlite3
    import tempfile
    from pathlib import Path
    from app.db import Database

    path = Path(tempfile.mkdtemp()) / "old.db"
    c = sqlite3.connect(path)
    c.execute("CREATE TABLE results (item_id TEXT PRIMARY KEY, etag TEXT NOT NULL, model TEXT NOT NULL,"
              " scenes_json TEXT NOT NULL, analyzed_until REAL NOT NULL, progress REAL NOT NULL,"
              " complete INTEGER NOT NULL, updated REAL NOT NULL)")
    c.execute("INSERT INTO results VALUES ('x', 'e', 'buffalo_l', '[]', 1, 1, 1, 0)")
    c.commit()
    c.close()
    db = Database(path)
    assert db.one("SELECT version FROM results WHERE item_id='x'")[0] == 1
    assert "version" in {r[1] for r in db.q("PRAGMA table_info(items)")}
    db.close()


def test_suppression(client):
    client.post("/jobs", json=job(), headers=AUTH)
    _results(client.db, ITEM)
    assert client.delete(f"/items/{ITEM}", headers=AUTH).status_code == 204
    assert client.get(f"/items/{ITEM}", headers=AUTH).status_code == 404
    assert client.get(f"/items/{ITEM}/scenes", headers=AUTH).status_code == 404
    # Inconnu ou mal formé : 204 quand même (l'oubli est idempotent).
    assert client.delete(f"/items/{ITEM}", headers=AUTH).status_code == 204
    assert client.delete("/items/pas-un-id", headers=AUTH).status_code == 204


def test_inconnu(client):
    assert client.get(f"/items/{ITEM}", headers=AUTH).status_code == 404
    assert client.get("/items/xyz", headers=AUTH).status_code == 404


def bad(client, body):
    r = client.post("/jobs", json=body, headers=AUTH)
    assert r.status_code == 400, body
    assert "error" in r.json()
    return r.json()["error"]


def test_champs_invalides(client):
    bad(client, job(item="123"))
    bad(client, job(etag=""))
    bad(client, job(priority="urgent"))
    bad(client, job(startAt=-1))
    bad(client, job(startAt="10"))
    bad(client, job(seriesId="abc"))
    bad(client, job(cast="x"))
    bad(client, job(cast=[{"personId": "1", "photos": []}]))
    bad(client, job(cast=[{"personId": 1, "photos": ["https://image.tmdb.org/a.jpg"] * 13}]))
    r = client.post("/jobs", content=b"{pas du json", headers={**AUTH, "content-type": "application/json"})
    assert r.status_code == 400


def test_chemins_hors_mediatheque(client):
    assert "hors" in bad(client, job(path="/etc/passwd"))
    assert "hors" in bad(client, job(path=str(MEDIA / "tv" / ".." / ".." / "outside" / "secret.mkv")))
    # Un lien symbolique posé dans la médiathèque mais qui en sort.
    assert "hors" in bad(client, job(path=str(MEDIA / "tv" / "Show" / "lien.mkv")))
    assert "absolu" in bad(client, job(path="tv/Show/S01E01.mkv"))
    assert "vidéo" in bad(client, job(path=str(MEDIA / "tv" / "Show" / "notes.txt")))
    assert "introuvable" in bad(client, job(path=str(MEDIA / "tv" / "Show" / "absent.mkv")))
    bad(client, job(path=str(MEDIA) + "-voisin/x.mkv"))
    # Le bon chemin, écrit avec un détour, passe et est normalisé.
    r = client.post("/jobs", json=job(path=str(MEDIA / "tv" / "Show" / ".." / "Show" / "S01E01.mkv")), headers=AUTH)
    assert r.status_code == 202
    assert client.db.one("SELECT path FROM items")[0] == EPISODE


def test_photos_tmdb_seulement(client):
    for url in [
        "http://image.tmdb.org/t/p/w185/a.jpg",
        "https://image.tmdb.org.example.com/a.jpg",
        "https://image.tmdb.org@example.com/a.jpg",
        "https://user@image.tmdb.org/a.jpg",
        "https://image.tmdb.org:8443/a.jpg",
        "https://example.com/https://image.tmdb.org/a.jpg",
        "https://IMAGE.tmdb.org/a.jpg",
        "file:///etc/passwd",
        "https://image.tmdb.org\\@example.com/a.jpg",
        42,
    ]:
        err = bad(client, job(cast=[{"personId": 1, "name": "A", "photos": [url]}]))
        assert "photos" in err


def test_acteur_en_double_fusionne(client):
    cast = [
        {"personId": 7, "name": "A", "photos": ["https://image.tmdb.org/t/p/w185/1.jpg"]},
        {"personId": 7, "name": "A", "character": "Autre rôle", "photos": ["https://image.tmdb.org/t/p/w185/2.jpg"]},
    ]
    assert client.post("/jobs", json=job(cast=cast), headers=AUTH).status_code == 202
    stored = json.loads(client.db.one("SELECT cast_json FROM items")[0])
    assert len(stored) == 1 and len(stored[0]["photos"]) == 2
