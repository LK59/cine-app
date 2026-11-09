"""Seuils d'un modèle d'empreinte : rejoue l'assemblage final d'un titre (sans mémoire de série) pour une
grille de seuils, et donne par seuil : personnes nommées et temps de présence, groupes anonymes ≥ 10 s,
notes des groupes nommés proches des seuils.
usage : python thresh_scan.py SNAP.db ITEM CLUSTER1,CLUSTER2 LABEL1,LABEL2 [noms.json]"""
import sys, json, sqlite3
import numpy as np
sys.path.insert(0, "/srv")
from app import cast as castmod
from app.jobs import CastMember
from app.results import ShotRow, TrackRow, build

db, item = sys.argv[1], sys.argv[2]
cts = [float(x) for x in sys.argv[3].split(",")]
lts = [float(x) for x in sys.argv[4].split(",")]
con = sqlite3.connect(f"file:{db}?mode=ro&immutable=1", uri=True); con.row_factory = sqlite3.Row
it = con.execute("SELECT * FROM items WHERE item_id=?", (item,)).fetchone()
cast = [CastMember(c["personId"], c.get("name", ""), c.get("character", ""), c.get("order", 0), c.get("photos", []))
        for c in json.loads(it["cast_json"])]
names = {c.person_id: c.name for c in cast}


class RO:
    def q(self, s, a=()): return con.execute(s, a).fetchall()
    def one(self, s, a=()): return con.execute(s, a).fetchone()


refs = castmod.build_refs(cast, castmod.cached_photo_embeddings(RO(), it["model"], cast), {})
chunks = con.execute("SELECT start, end FROM chunks WHERE item_id=?", (item,)).fetchall()
shots = [ShotRow(r["start"], r["end"], np.frombuffer(r["hist"], dtype=np.float32)) for r in con.execute("SELECT start,end,hist FROM shots WHERE item_id=?", (item,))]
tracks = [TrackRow(r["shot_start"], r["shot_end"], r["screen_time"], r["quality"], np.frombuffer(r["emb"], dtype=np.float32))
          for r in con.execute("SELECT shot_start,shot_end,screen_time,quality,emb FROM tracks WHERE item_id=? ORDER BY id", (item,))]
out = {}
for ct in cts:
    for lt in lts:
        b = build(it["duration"], [(r["start"], r["end"]) for r in chunks], len(chunks), 0.0, shots, tracks, refs, lt, ct)
        tot = {}
        for s in b.scenes:
            for p in s["people"]:
                tot[names.get(p["personId"], p["personId"])] = tot.get(names.get(p["personId"], p["personId"]), 0) + p["screenTime"]
        anon = [round(float(t), 1) for i, t in enumerate(b.cluster_time) if i not in b.assignments and t >= 10]
        near = sorted(round(a.score, 3) for a in b.assignments.values() if a.score < lt + 0.15)
        out[f"{ct}/{lt}"] = {"named": {k: round(v, 1) for k, v in sorted(tot.items(), key=lambda x: -x[1])},
                             "anon_ge10s": sorted(anon, reverse=True), "scores_near": near,
                             "all_scores": sorted(round(a.score, 3) for a in b.assignments.values())}
        print(f"seuils regroupement {ct} / nom {lt} : {len(tot)} nommés, {len(anon)} anonymes ≥ 10 s ({sum(anon):.0f} s), notes proches {near}")
json.dump(out, open(f"/out/scan-{item[:6]}-{it['model']}.json", "w"), ensure_ascii=False, indent=1)
