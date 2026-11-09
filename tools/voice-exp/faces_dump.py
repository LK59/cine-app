"""Refait, hors ligne, le nom de chaque piste de visage d'un épisode (même code que le service :
results.build), à partir d'une COPIE de la base. Sortie JSON : par plan, les personnes et la part du
plan où elles sont visibles. Usage : python faces_dump.py <db> <item_id> <out.json>"""
import json, sys
import numpy as np
sys.path.insert(0, "/xray")
from app.db import Database  # noqa
from app import cast as castmod  # noqa
from app.jobs import CastMember  # noqa
from app.results import TrackRow, ShotRow, build  # noqa
from app.cluster import cluster_embeddings  # noqa
from app.worker import thresholds  # noqa

db_path, item, out = sys.argv[1:4]
db = Database(db_path) if not hasattr(Database, "open") else Database.open(db_path)
row = db.one("SELECT * FROM items WHERE item_id=?", (item,))
model = row["model"]
cast = [CastMember(c["personId"], c.get("name", ""), c.get("character", ""), c.get("order", 0), c.get("photos", []))
        for c in json.loads(row["cast_json"])]
photos = castmod.cached_photo_embeddings(db, model, cast)
series = castmod.series_embeddings(db, row["series_id"], model)
refs = castmod.build_refs(cast, photos, series)
shots = [ShotRow(r["start"], r["end"], np.frombuffer(r["hist"], dtype=np.float32))
         for r in db.q("SELECT start, end, hist FROM shots WHERE item_id=?", (item,))]
trs = db.q("SELECT shot_start, shot_end, screen_time, quality, emb FROM tracks WHERE item_id=?", (item,))
tracks = [TrackRow(r["shot_start"], r["shot_end"], r["screen_time"], r["quality"], np.frombuffer(r["emb"], dtype=np.float32)) for r in trs]
cluster_t, label_t = thresholds(model)
chunks = db.q("SELECT start, end, done FROM chunks WHERE item_id=?", (item,))
done = [(r["start"], r["end"]) for r in chunks if r["done"]]
built = build(row["duration"], done, len(chunks), 0.0, shots, tracks, refs, label_t, cluster_t)
labels = cluster_embeddings(np.stack([t.emb for t in tracks]), cluster_t)
names = {m.person_id: {"name": m.name, "character": m.character} for m in cast}
per_shot = {}
for t, l in zip(tracks, labels):
    a = built.assignments.get(int(l))
    key = round(t.shot_start, 3)
    d = per_shot.setdefault(key, {"start": t.shot_start, "end": t.shot_end, "people": {}})
    pid = a.person_id if a else f"anon{int(l)}"
    frac = t.screen_time / max(t.shot_end - t.shot_start, 1e-3)
    d["people"][str(pid)] = max(d["people"].get(str(pid), 0), min(1.0, frac))
cents = {}
for l, a in built.assignments.items():
    cents.setdefault(str(a.person_id), []).append(built.centroids[int(l)].tolist())
all_shots = [{"start": s.start, "end": s.end} for s in shots]
json.dump({"item": item, "duration": row["duration"], "cast": names, "shots": sorted(all_shots, key=lambda s: s["start"]),
           "faces": sorted(per_shot.values(), key=lambda s: s["start"]), "scenes": built.scenes, "centroids": cents}, open(out, "w"))
print(item, len(shots), "plans", len(tracks), "pistes", len(built.assignments), "groupes nommés", len(built.scenes), "scènes")
