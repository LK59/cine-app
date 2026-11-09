"""Scènes avant / après la séparation des fils (shots.THREAD_SPLIT), sur une base de banc.
usage : python scene_eval.py SNAP.db ITEM series(0|1) [fenêtres a-b,c-d]"""
import sys, json, sqlite3
import numpy as np
sys.path.insert(0, "/srv")
from app import cast as castmod, shots as shotsmod
from app.jobs import CastMember
from app.results import ShotRow, TrackRow, build
from app.worker import thresholds

db, item, ser = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
wins = [tuple(float(x) for x in w.split("-")) for w in sys.argv[4].split(",")] if len(sys.argv) > 4 else []
con = sqlite3.connect(f"file:{db}?mode=ro&immutable=1", uri=True); con.row_factory = sqlite3.Row
it = con.execute("SELECT * FROM items WHERE item_id=?", (item,)).fetchone()
cast = [CastMember(c["personId"], c.get("name", ""), c.get("character", ""), c.get("order", 0), c.get("photos", []))
        for c in json.loads(it["cast_json"])]
nm = {c.person_id: (c.character.split("/")[0].strip() or c.name)[:14] for c in cast}


class RO:
    def q(self, s, a=()): return con.execute(s, a).fetchall()
    def one(self, s, a=()): return con.execute(s, a).fetchone()


series = castmod.series_embeddings(RO(), it["series_id"], it["model"]) if ser else {}
refs = castmod.build_refs(cast, castmod.cached_photo_embeddings(RO(), it["model"], cast), series)
chunks = con.execute("SELECT start, end FROM chunks WHERE item_id=?", (item,)).fetchall()
shots = [ShotRow(r["start"], r["end"], np.frombuffer(r["hist"], dtype=np.float32)) for r in con.execute("SELECT start,end,hist FROM shots WHERE item_id=?", (item,))]
tracks = [TrackRow(r["shot_start"], r["shot_end"], r["screen_time"], r["quality"], np.frombuffer(r["emb"], dtype=np.float32))
          for r in con.execute("SELECT shot_start,shot_end,screen_time,quality,emb FROM tracks WHERE item_id=? ORDER BY id", (item,))]
ct, lt = thresholds(it["model"])
res = {}
for flag in (False, True):
    shotsmod.THREAD_SPLIT = flag
    res[flag] = build(it["duration"], [(r["start"], r["end"]) for r in chunks], len(chunks), 0.0, shots, tracks, refs, lt, ct).scenes
fmt = lambda s: f"{int(s['start']) // 60:3d}:{s['start'] % 60:04.1f}–{int(s['end']) // 60}:{s['end'] % 60:04.1f} ({s['end'] - s['start']:5.1f} s) " + \
    ", ".join(f"{nm.get(p['personId'], p['personId'])} {p['screenTime']:.0f}" for p in s["people"])
a, b = res[False], res[True]
ba, bb = {s["start"] for s in a}, {s["start"] for s in b}
print(f"{it['path'].split('/')[-1]} : {len(a)} scènes → {len(b)} ; frontières ajoutées {len(bb - ba)}, retirées {len(ba - bb)}")
for w0, w1 in wins:
    print(f"--- {w0:.0f}–{w1:.0f} s, avant")
    for s in a:
        if s["end"] > w0 and s["start"] < w1: print("   ", fmt(s))
    print("    après")
    for s in b:
        if s["end"] > w0 and s["start"] < w1: print("   ", fmt(s))
if not wins:
    for t in sorted(bb - ba):
        prev = max((s for s in b if s["start"] < t), key=lambda s: s["start"], default=None)
        cur = next(s for s in b if s["start"] == t)
        print("  nouvelle frontière :", fmt(prev) if prev else "-", " | ", fmt(cur))
