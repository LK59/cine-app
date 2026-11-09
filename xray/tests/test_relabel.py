"""Renommer sans relire (relabel.py), mémoire des séries par contribution (memory.py), qualité (/quality)."""

import json

import numpy as np

from app import memory, relabel, voicejob
from app.jobs import JobStore
from app.worker import Worker
from conftest import AUTH, ITEM, ITEM2, job, noisy, unit
from test_results import hist
from test_voices import dialogue

SERIES = "c" * 32


class FM:
    name = "buffalo_l"
    ready = True


def seed(db, rng, item=ITEM, series=SERIES):
    """Un épisode fini : deux tronçons, un champ-contrechamp A/B, photos en cache, et la parole des deux."""
    a, b = unit(rng), unit(rng)
    cast = [{"personId": 1, "name": "A", "character": "Alice", "order": 0, "photos": ["https://image.tmdb.org/t/p/w185/a.jpg"]},
            {"personId": 2, "name": "B", "character": "Bob", "order": 1, "photos": ["https://image.tmdb.org/t/p/w185/b.jpg"]}]
    db.run("""INSERT INTO items (item_id, etag, path, priority, start_at, series_id, cast_json, status, seq, version,
              created, updated, duration, model) VALUES (?, 'e1', ?, 1, 0, ?, ?, 'done', 1, 5, 0, 0, 100, 'buffalo_l')""",
           (item, f"/m/{item}.mkv", series, json.dumps(cast)))
    for url, base in ((cast[0]["photos"][0], a), (cast[1]["photos"][0], b)):
        db.run("INSERT OR REPLACE INTO photo_emb (model, url, emb, fetched) VALUES ('buffalo_l', ?, ?, 0)",
               (url, noisy(rng, base, 0.6).tobytes()))
    room = hist(rng)
    turns = ["A", "B"] * 10
    regions, wins, embs = dialogue(rng, turns, {"A": unit(rng), "B": unit(rng)}, turn_len=4.6)
    for idx, (c0, c1) in enumerate(((0, 50), (50, 100))):
        db.run("INSERT INTO chunks (item_id, idx, start, end, done) VALUES (?, ?, ?, ?, 1)", (item, idx, c0, c1))
        sel = [k for k, (s, e) in enumerate(regions) if c0 <= s < c1]
        for k in sel:
            s, e = regions[k]
            db.run("INSERT INTO shots (item_id, chunk_idx, start, end, hist) VALUES (?, ?, ?, ?, ?)",
                   (item, idx, s, e + 0.2, hist(rng, room, 0.02).tobytes()))
            who = a if turns[k] == "A" else b
            db.run("""INSERT INTO tracks (item_id, chunk_idx, shot_start, shot_end, screen_time, quality, faces, emb)
                      VALUES (?, ?, ?, ?, ?, 0.8, 3, ?)""", (item, idx, s, e + 0.2, e - s, noisy(rng, who, 0.6).tobytes()))
        w = [j for j, (s, e) in enumerate(wins) if c0 <= s < c1]
        voicejob.store_chunk(db, item, "e1", idx, [regions[k] for k in sel], wins[w], embs[w])
    db.run("UPDATE items SET voice_model='wespeaker_r34' WHERE item_id=?", (item,))


def fresh(db, item=ITEM):
    """Ce qu'écrit une analyse : l'assemblage incrémental du dernier tronçon, puis les voix finales."""
    from app import cast as castmod

    w = Worker(db, JobStore(db), FM(), None)
    row = db.one("SELECT * FROM items WHERE item_id=?", (item,))
    from app.jobs import CastMember

    cast = [CastMember(c["personId"], c["name"], c["character"], c["order"], c["photos"]) for c in json.loads(row["cast_json"])]
    refs = castmod.build_refs(cast, castmod.cached_photo_embeddings(db, "buffalo_l", cast),
                              castmod.series_embeddings(db, row["series_id"], "buffalo_l"))
    built = w.checkpoint(item, "e1", "buffalo_l", 100.0, 0.0, refs)
    voicejob.assemble(db, item, "e1", "wespeaker_r34", row["series_id"], None, built.presence, built.scenes, final=True)
    return built


def snapshot(db, item=ITEM):
    r = db.one("SELECT scenes_json, analyzed_until, complete, stats_json FROM results WHERE item_id=?", (item,))
    v = db.one("SELECT segments_json, complete FROM voice_results WHERE item_id=?", (item,))
    return (r["scenes_json"], r["analyzed_until"], r["complete"], r["stats_json"], v["segments_json"], v["complete"])


def test_renommer_rend_ce_que_rend_une_analyse_neuve(db):
    rng = np.random.default_rng(3)
    seed(db, rng, series=None)
    fresh(db)
    before = snapshot(db)
    assert json.loads(before[0]) and any(s["personId"] for s in json.loads(before[4]))
    db.run("DELETE FROM results")
    db.run("DELETE FROM voice_results")
    out = relabel.relabel_item(db, ITEM, "wespeaker_r34")
    assert out["scenes"] >= 1 and "voices" in out
    assert snapshot(db) == before
    assert db.one("SELECT relabeled FROM items")["relabeled"] is not None


def test_renommer_suit_la_memoire_du_moment(db):
    rng = np.random.default_rng(4)
    seed(db, rng)
    fresh(db)
    voice_before = json.loads(snapshot(db)[4])
    # La mémoire des voix de la série tient désormais les deux voix pour l'inverse : désaccord, sans nom.
    regions, wins, embs = voicejob.load_voice(db, ITEM)
    prof = {pid: emb for pid, (emb, n) in __import__("app.voices", fromlist=["build"]).build(
        regions, wins, embs, relabel.rebuild_faces(db, db.one("SELECT * FROM items")).presence, []).profiles.items()}
    assert set(prof) == {1, 2}
    memory.reset(db, SERIES)
    memory.contribute(db, SERIES, "voice", "wespeaker_r34", ITEM2, {1: (prof[2], 50, 1), 2: (prof[1], 50, 1)})
    relabel.relabel_item(db, ITEM, "wespeaker_r34")
    after = json.loads(snapshot(db)[4])
    assert any(s["personId"] for s in voice_before)
    assert all(s["personId"] is None for s in after) and any(s.get("conflict") for s in after)


def test_contributions_bornees_remplacees_et_auditables(db, client):
    rng = np.random.default_rng(5)
    entries = {pid: (unit(rng), 1000.0 if pid == 1 else float(pid), 0.5) for pid in range(1, 21)}
    assert memory.contribute(db, SERIES, "face", "buffalo_l", ITEM, entries) == memory.MAX_PEOPLE_PER_EPISODE
    w = {r["person_id"]: r["weight"] for r in db.q("SELECT person_id, weight FROM series_memory")}
    assert w[1] == memory.FACE_EPISODE_MAX and 2 not in w  # les moins présents ne comptent pas
    memory.contribute(db, SERIES, "face", "buffalo_l", ITEM, {1: (unit(rng), 10.0, 0.5)})
    assert db.one("SELECT COUNT(*) FROM series_memory")[0] == 1
    assert set(memory.recall(db, SERIES, "face", "buffalo_l")) == {1}
    assert memory.recall(db, SERIES, "voice", "buffalo_l") == {}
    entries = client.get(f"/series/{SERIES}/memory", headers=AUTH).json()["entries"]
    assert entries[0]["itemId"] == ITEM and entries[0]["personId"] == 1 and entries[0]["kind"] == "face"


def test_reprise_des_anciennes_memoires(tmp_path, rng=np.random.default_rng(6)):
    import sqlite3

    from app.db import Database

    path = tmp_path / "x.db"
    Database(path).close()
    c = sqlite3.connect(path)
    c.execute("INSERT INTO series_faces VALUES (?, 'buffalo_l', 7, ?, 900, 0)", (SERIES, unit(rng).tobytes()))
    c.commit()
    c.close()
    d = Database(path)
    rows = d.q("SELECT item_id, weight FROM series_memory")
    assert [(r["item_id"], r["weight"]) for r in rows] == [(memory.LEGACY, 900.0)]
    d.close()
    assert len(Database(path).q("SELECT * FROM series_memory")) == 1  # une seule fois


def test_garde_de_la_memoire_des_visages(db):
    from app import cast as castmod
    from app.cluster import Assignment
    from app.results import Built

    rng = np.random.default_rng(8)
    cent = np.stack([unit(rng), unit(rng), unit(rng)])
    asg = {0: Assignment(1, 0.5, 0.9, 0.30 + 0.12), 1: Assignment(2, 0.5, 0.9, 0.30 + 0.09), 2: Assignment(3, 0.5, 0.9, 0.30 + 0.2)}
    built = Built([], 0, 1, True, asg, cent, np.array([40.0, 40.0, 2.0]))
    assert castmod.update_series(db, SERIES, "buffalo_l", built, 0.30, ITEM) == 1
    # 2 : photo pas assez nette ; 3 : à peine vu.
    assert set(memory.recall(db, SERIES, "face", "buffalo_l")) == {1}


def test_api_renommer_et_reinitialiser(client):
    db = client.db
    rng = np.random.default_rng(9)
    seed(db, rng)
    seed(db, rng, item=ITEM2)
    assert client.post(f"/items/{'f' * 32}/relabel", headers=AUTH).status_code == 404
    r = client.post(f"/series/{SERIES}/relabel", json={"itemIds": [ITEM2, ITEM]}, headers=AUTH)
    assert r.status_code == 202 and r.json()["queued"] == 2
    assert [x["item_id"] for x in db.q("SELECT item_id FROM relabel_queue ORDER BY seq")] == [ITEM2, ITEM]
    assert relabel.run_some(db, "wespeaker_r34") == 2
    assert client.get("/relabel", headers=AUTH).json() == {"pending": 0}
    assert db.one("SELECT COUNT(*) FROM series_memory WHERE kind='voice'")[0] > 0
    r = client.post(f"/series/{SERIES}/memory/reset", json={"itemIds": [ITEM, ITEM2]}, headers=AUTH)
    assert r.json()["removed"] > 0 and r.json()["queued"] == 2
    assert db.one("SELECT COUNT(*) FROM series_memory")[0] == 0
    assert client.post("/relabel", headers=AUTH).json()["queued"] == 0  # déjà en file
    db.run("UPDATE items SET status='queued' WHERE item_id=?", (ITEM,))
    assert client.post(f"/items/{ITEM}/relabel", headers=AUTH).status_code == 409


def test_qualite(client):
    db = client.db
    rng = np.random.default_rng(11)
    seed(db, rng)
    fresh(db)
    seed(db, rng, item=ITEM2, series=None)
    fresh(db, ITEM2)
    q = client.get("/quality", headers=AUTH).json()
    assert q["overall"]["items"] == 2 and q["overall"]["withVoices"] == 2
    assert q["movies"]["items"] == 1
    (s,) = q["series"]
    assert s["seriesId"] == SERIES and 0 < s["speechNamed"] <= 1 and 0 < s["facesNamed"] <= 1
    item = client.get(f"/items/{ITEM}", headers=AUTH).json()
    assert 0 < item["faces"]["facesNamed"] <= 1 and "speechNamed" in item["voices"]
