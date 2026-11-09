"""Rejoue les assemblages d'un ordre tronçon par tronçon (comme Worker.checkpoint), depuis une base de banc.
usage : python replay_build.py SNAP.db ITEM_ID [profile|time] [module de build]"""
import sys, json, time, sqlite3, importlib
import numpy as np
sys.path.insert(0, "/srv")
from app import cast as castmod
from app.db import Database
from app.jobs import CastMember
from app.results import ShotRow, TrackRow
from app.worker import thresholds

db_path, item = sys.argv[1], sys.argv[2]
mode = sys.argv[3] if len(sys.argv) > 3 else "time"
mod = importlib.import_module(sys.argv[4] if len(sys.argv) > 4 else "app.results")
con = sqlite3.connect(f"file:{db_path}?mode=ro&immutable=1", uri=True)
con.row_factory = sqlite3.Row
it = con.execute("SELECT * FROM items WHERE item_id=?", (item,)).fetchone()
model = it["model"]
cast = [CastMember(c["personId"], c.get("name", ""), c.get("character", ""), c.get("order", 0), c.get("photos", []))
        for c in json.loads(it["cast_json"])]


class RO:
    def q(self, sql, args=()):
        return con.execute(sql, args).fetchall()

    def one(self, sql, args=()):
        return con.execute(sql, args).fetchone()


photos = castmod.cached_photo_embeddings(RO(), model, cast)
refs = castmod.build_refs(cast, photos, {})  # sans mémoire de série (un film)
chunks = [dict(r) for r in con.execute("SELECT idx, start, end FROM chunks WHERE item_id=? ORDER BY idx", (item,))]
shots_by = {}
for r in con.execute("SELECT chunk_idx, start, end, hist FROM shots WHERE item_id=?", (item,)):
    shots_by.setdefault(r["chunk_idx"], []).append(ShotRow(r["start"], r["end"], np.frombuffer(r["hist"], dtype=np.float32)))
tracks_by = {}
for r in con.execute("SELECT chunk_idx, shot_start, shot_end, screen_time, quality, emb FROM tracks WHERE item_id=? ORDER BY id", (item,)):
    tracks_by.setdefault(r["chunk_idx"], []).append(TrackRow(r["shot_start"], r["shot_end"], r["screen_time"], r["quality"], np.frombuffer(r["emb"], dtype=np.float32)))
cluster_t, label_t = thresholds(model)
duration = it["duration"]


def replay():
    done, shots, tracks = [], [], []
    state = getattr(mod, "IncrementalBuilder", None)
    inc = state(duration, len(chunks), 0.0, refs, label_t, cluster_t) if state else None
    per = []
    out = None
    for c in chunks:
        done.append((c["start"], c["end"]))
        s_new, t_new = shots_by.get(c["idx"], []), tracks_by.get(c["idx"], [])
        shots += s_new
        tracks += t_new
        t0 = time.perf_counter()
        if inc:
            out = inc.add_chunk((c["start"], c["end"]), s_new, t_new)
        else:
            out = mod.build(duration, list(done), len(chunks), 0.0, list(shots), list(tracks), refs, label_t, cluster_t)
        per.append(time.perf_counter() - t0)
    return out, per


if mode == "profile":
    import cProfile, pstats
    cProfile.run("res = replay()", "/tmp/prof")
    pstats.Stats("/tmp/prof").sort_stats("cumulative").print_stats(25)
else:
    out, per = replay()
    print(f"{len(chunks)} tronçons, {sum(len(v) for v in tracks_by.values())} pistes, {sum(len(v) for v in shots_by.values())} plans : "
          f"assemblage total {sum(per):.2f} s, dernier {per[-1]:.2f} s")
    json.dump(out.scenes, open(f"/tmp/scenes-{mod.__name__}.json", "w"))
    import hashlib; print("scènes", len(out.scenes), "sha", hashlib.sha256(json.dumps(out.scenes).encode()).hexdigest()[:16])
    ref = con.execute("SELECT scenes_json FROM results WHERE item_id=?", (item,)).fetchone()[0]
    print("identique au résultat en base :", json.loads(ref) == out.scenes)
