"""Chronomètres : somme des tronçons et de l'ordre, rendue par GET /items/{id}."""

import json

from app.timing import StageClock, job_stats, line, summary
from conftest import AUTH, ITEM, job


def test_somme_et_part_du_reste():
    c = StageClock()
    c.add("wall", 100.0)
    c.add("detect", 40.0)
    c.add("embed", 30.0)
    c.add("decode_wait", 5.0)
    c.add("write", 1.0)
    c.add("build", 2.0)
    c.add("photos", 7.0)
    c.count("images", 10)
    s = summary(c, 1100.0)
    assert s["seconds"] == 110.0           # analyse + écriture + assemblage + photos
    assert s["realtime"] == 10.0
    assert s["stages"]["other"] == 25.0    # 100 − 40 − 30 − 5
    assert s["counts"] == {"images": 10}
    assert "détection 40.0 s (36 %)" in line(s)


def test_stats_dans_l_api(client):
    client.post("/jobs", json=job(), headers=AUTH)
    c = StageClock()
    c.add("wall", 12.0)
    c.add("detect", 6.0)
    client.db.run("UPDATE items SET duration=120 WHERE item_id=?", (ITEM,))
    client.db.run("INSERT INTO chunks (item_id, idx, start, end, done, stats) VALUES (?, 0, 0, 120, 1, ?)",
                  (ITEM, json.dumps(c.as_dict())))
    job_clock = StageClock()
    job_clock.add("photos", 3.0)
    client.db.run("UPDATE items SET stats_json=? WHERE item_id=?", (json.dumps(job_clock.as_dict()), ITEM))
    st = client.get(f"/items/{ITEM}", headers=AUTH).json()["stats"]
    assert st["seconds"] == 15.0 and st["realtime"] == 8.0
    assert st["stages"]["detect"] == 6.0 and st["stages"]["photos"] == 3.0
    assert job_stats(client.db, ITEM, 120.0) == st
    # Un autre fichier (etag) : tout est oublié, chronomètres compris.
    client.post("/jobs", json=job(etag="etag-2"), headers=AUTH)
    assert client.get(f"/items/{ITEM}", headers=AUTH).json()["stats"] is None
