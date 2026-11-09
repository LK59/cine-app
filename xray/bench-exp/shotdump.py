"""Plans d'un titre avec les personnes identifiées (même assemblage que le résultat final), en JSON,
pour étudier le découpage en scènes hors ligne.
usage : python shotdump.py SNAP.db ITEM SORTIE.json [series:0|1]"""
import sys, json, sqlite3
import numpy as np
sys.path.insert(0, "/srv")
from app import cast as castmod
from app.jobs import CastMember
from app.results import ShotRow, TrackRow, build
from app.worker import thresholds

db, item, outp = sys.argv[1:4]
con = sqlite3.connect(f"file:{db}?mode=ro&immutable=1", uri=True); con.row_factory = sqlite3.Row
it = con.execute("SELECT * FROM items WHERE item_id=?", (item,)).fetchone()
cast = [CastMember(c["personId"], c.get("name", ""), c.get("character", ""), c.get("order", 0), c.get("photos", []))
        for c in json.loads(it["cast_json"])]


class RO:
    def q(self, s, a=()): return con.execute(s, a).fetchall()
    def one(self, s, a=()): return con.execute(s, a).fetchone()


series = castmod.series_embeddings(RO(), it["series_id"], it["model"]) if len(sys.argv) > 4 and sys.argv[4] == "1" else {}
refs = castmod.build_refs(cast, castmod.cached_photo_embeddings(RO(), it["model"], cast), series)
chunks = con.execute("SELECT start, end FROM chunks WHERE item_id=?", (item,)).fetchall()
shots = [ShotRow(r["start"], r["end"], np.frombuffer(r["hist"], dtype=np.float32)) for r in con.execute("SELECT start,end,hist FROM shots WHERE item_id=? ORDER BY start", (item,))]
tracks = [TrackRow(r["shot_start"], r["shot_end"], r["screen_time"], r["quality"], np.frombuffer(r["emb"], dtype=np.float32))
          for r in con.execute("SELECT shot_start,shot_end,screen_time,quality,emb FROM tracks WHERE item_id=? ORDER BY id", (item,))]
ct, lt = thresholds(it["model"])
b = build(it["duration"], [(r["start"], r["end"]) for r in chunks], len(chunks), 0.0, shots, tracks, refs, lt, ct)
from app.cluster import cluster_embeddings
labels = cluster_embeddings(np.stack([t.emb for t in tracks]), ct)
by = {}
for t, l in zip(tracks, labels):
    a = b.assignments.get(int(l))
    by.setdefault(round(t.shot_start, 3), []).append((a.person_id if a else -1 - int(l), t.screen_time))
json.dump({"duration": it["duration"], "cast": {c.person_id: c.name for c in cast}, "scenes": b.scenes,
           "intervals": [[r["start"], r["end"]] for r in chunks],
           "shots": [{"s": s.start, "e": s.end, "h": [round(float(x), 5) for x in s.hist], "p": by.get(round(s.start, 3), [])} for s in shots]},
          open(outp, "w"))
print("ok", len(shots), len(b.scenes))
