"""Renommer sans relire le fichier : regroupement et noms refaits sur ce qui est gardé en base.

Tout ce qui coûte est gardé, tronçon par tronçon : les plans et leurs histogrammes, l'empreinte de
chaque piste de visage (`tracks`), et pour les voix les zones de parole et l'empreinte de chaque fenêtre
(`voice_regions`, `voice_windows`). Le regroupement, les noms et les scènes se refont donc en quelques
secondes par élément, **avec les seuils du code et la mémoire de la série d'aujourd'hui** — sans décoder
ni réécouter quoi que ce soit (`relabel_item`). C'est ce que fait l'ouvrier pour chaque élément de la file
`relabel_queue`, remplie par `POST /items/{id}/relabel`, `POST /series/{id}/relabel` (dans l'ordre des
épisodes que Laterna donne, sinon dans l'ordre des chemins) et `POST /relabel` (toute la bibliothèque),
par lots bornés en temps entre deux tronçons d'analyse (`RELABEL_BUDGET_S`).

Le résultat est le même que celui d'une analyse neuve sur les mêmes données (`build` est la référence
de l'assemblage incrémental, `test_relabel.py` le vérifie), écrit sous la version courante. Un élément
renommé redépose sa contribution à la mémoire de la série (remplacée, jamais ajoutée : memory.py) — dans
l'ordre des épisodes, les premiers profitent ainsi de toute la série au passage suivant.
"""

from __future__ import annotations

import json
import logging
import time

import numpy as np

from . import cast as castmod
from . import scenecuts
from . import voicejob
from .config import RESULT_VERSION
from .db import Database
from .faces import MODEL_DEFAULTS
from .jobs import CastMember
from .logs import event
from .results import Built, ShotRow, TrackRow, build

log = logging.getLogger("xray.relabel")

RELABEL_BUDGET_S = 20.0


def face_thresholds(model: str) -> tuple[float, float]:
    from .config import settings

    d = MODEL_DEFAULTS.get(model, MODEL_DEFAULTS["buffalo_l"])
    c = settings.cluster_threshold if settings.cluster_threshold is not None else d["cluster"]
    lab = settings.label_threshold if settings.label_threshold is not None else d["label"]
    return c, lab


def face_stats(built: Built) -> dict:
    """Part du temps de visage à l'écran qui porte un nom (les visages anonymes comptent contre)."""
    if built.cluster_time is None or not len(built.cluster_time):
        return {"facesNamed": None, "faceSeconds": 0.0}
    total = float(np.sum(built.cluster_time))
    named = float(sum(built.cluster_time[ci] for ci in built.assignments))
    return {"facesNamed": round(named / total, 4) if total > 0 else None, "faceSeconds": round(total, 1)}


def write_result(c, item_id: str, etag: str, model: str, built: Built) -> None:
    """Le résultat des scènes, tel que `/scenes` le sert (même écriture pour l'analyse et le renommage).
    Complet, il garde aussi le détail des groupes de visages pour le rapport de décision (`report.py`)."""
    diag = None
    if built.complete:
        from . import report

        try:
            diag = json.dumps(report.face_diag(built), separators=(",", ":"))
        except Exception:  # le rapport ne fait jamais échouer un résultat
            log.exception("[xray] %s : détail des visages pour le rapport impossible", item_id)
    # Les mesures des frontières de scène (« Revenir au début de la scène », scenecuts.py), à part des scènes :
    # gardées seulement pour un résultat complet, le seul que Laterna en lit.
    bounds = scenecuts.bounds_doc(built.bounds) if built.complete else None
    c.execute(
        """INSERT OR REPLACE INTO results (item_id, etag, model, scenes_json, analyzed_until, progress, complete,
                                          updated, version, stats_json, diag_json, bounds_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (item_id, etag, model, json.dumps(built.scenes, separators=(",", ":")), built.analyzed_until,
         built.progress, 1 if built.complete else 0, time.time(), RESULT_VERSION, json.dumps(face_stats(built)), diag,
         bounds),
    )


def rebuild_faces(db: Database, row, model: str | None = None) -> Built:
    """Les visages d'un élément, refaits depuis la base sans réseau ni modèle (photos en cache,
    mémoire de la série du moment)."""
    model = model or row["model"] or "buffalo_l"
    cast = [CastMember(c["personId"], c.get("name", ""), c.get("character", ""), c.get("order", 0), c.get("photos", []))
            for c in json.loads(row["cast_json"])]
    refs = castmod.build_refs(cast, castmod.cached_photo_embeddings(db, model, cast),
                              castmod.series_embeddings(db, row["series_id"], model, exclude_item=row["item_id"]))
    item_id = row["item_id"]
    chunks = db.q("SELECT start, end, done FROM chunks WHERE item_id=?", (item_id,))
    done = [(r["start"], r["end"]) for r in chunks if r["done"]]
    shots = [ShotRow(r["start"], r["end"], np.frombuffer(r["hist"], dtype=np.float32))
             for r in db.q("SELECT start, end, hist FROM shots WHERE item_id=?", (item_id,))]
    tracks = [TrackRow(r["shot_start"], r["shot_end"], r["screen_time"], r["quality"], np.frombuffer(r["emb"], dtype=np.float32))
              for r in db.q("SELECT shot_start, shot_end, screen_time, quality, emb FROM tracks WHERE item_id=? ORDER BY id",
                            (item_id,))]
    cluster_t, label_t = face_thresholds(model)
    anchor = 0.0
    return build(float(row["duration"] or 0.0), done, len(chunks), anchor, shots, tracks, refs, label_t, cluster_t)


def rebuild_bounds(db: Database, row) -> list[dict]:
    """Les mesures des frontières de scène d'un élément (scenecuts.py), refaites depuis la base : le
    regroupement des pistes et des plans seul — sans photos ni noms, qui n'y entrent pas."""
    item_id = row["item_id"]
    model = row["model"] or "buffalo_l"
    chunks = db.q("SELECT start, end, done FROM chunks WHERE item_id=?", (item_id,))
    done = [(r["start"], r["end"]) for r in chunks if r["done"]]
    shots = [ShotRow(r["start"], r["end"], np.frombuffer(r["hist"], dtype=np.float32))
             for r in db.q("SELECT start, end, hist FROM shots WHERE item_id=?", (item_id,))]
    tracks = [TrackRow(r["shot_start"], r["shot_end"], r["screen_time"], r["quality"], np.frombuffer(r["emb"], dtype=np.float32))
              for r in db.q("SELECT shot_start, shot_end, screen_time, quality, emb FROM tracks WHERE item_id=? ORDER BY id",
                            (item_id,))]
    cluster_t, label_t = face_thresholds(model)
    return build(float(row["duration"] or 0.0), done, len(chunks), 0.0, shots, tracks, [], label_t, cluster_t).bounds


def relabel_item(db: Database, item_id: str, voice_model: str | None) -> dict:
    """Refait visages puis voix d'un élément fini. Rend un résumé ; `skipped` si rien n'est à refaire."""
    row = db.one("SELECT * FROM items WHERE item_id=?", (item_id,))
    if row is None or row["status"] != "done":
        return {"itemId": item_id, "skipped": "pas fini"}
    model = row["model"] or "buffalo_l"
    etag = row["etag"]
    built = rebuild_faces(db, row, model)
    with db.tx() as c:
        cur = c.execute("SELECT etag FROM items WHERE item_id=?", (item_id,)).fetchone()
        if cur is None or cur["etag"] != etag:
            return {"itemId": item_id, "skipped": "fichier changé"}
        write_result(c, item_id, etag, model, built)
        c.execute("UPDATE items SET relabeled=? WHERE item_id=?", (time.time(), item_id))
    out = {"itemId": item_id, "scenes": len(built.scenes), **face_stats(built)}
    if built.complete:
        _, label_t = face_thresholds(model)
        out["faceMemory"] = castmod.update_series(db, row["series_id"], model, built, label_t, item_id)
    # Les voix : dès que le son d'un tronçon au moins est en base, sous ce modèle de voix.
    has_voice = db.one("SELECT 1 FROM chunks WHERE item_id=? AND voice=1 LIMIT 1", (item_id,)) is not None
    if voice_model and has_voice and row["voice_model"] == voice_model:
        track = json.loads(row["voice_track_json"]) if row["voice_track_json"] else None
        res = voicejob.assemble(db, item_id, etag, voice_model, row["series_id"], track, built.presence, built.scenes,
                                final=True)
        if res is not None:
            out["voices"] = {k: res.stats.get(k) for k in ("voicesNamed", "voicesUndecided", "voicesConflict", "speechNamed")}
    from . import report

    report.save(db, item_id, "renommage")
    return out


# ---- la file --------------------------------------------------------------------------------------

def enqueue(db: Database, item_ids: list[str]) -> int:
    """Ajoute des éléments à la file, dans l'ordre donné ; un élément déjà en file garde sa place."""
    n = 0
    with db.tx() as c:
        seq = c.execute("SELECT COALESCE(MAX(seq), 0) FROM relabel_queue").fetchone()[0]
        for item_id in item_ids:
            seq += 1
            cur = c.execute("INSERT OR IGNORE INTO relabel_queue (item_id, seq, requested) VALUES (?, ?, ?)",
                            (item_id.lower(), seq, time.time()))
            n += cur.rowcount
    return n


def series_items(db: Database, series_id: str, order: list[str] | None = None) -> list[str]:
    """Les épisodes finis d'une série : dans l'ordre que Laterna donne (saison, épisode), sinon par chemin
    (« … S01E02 … » se trie bien), ceux qu'il ne nomme pas ensuite."""
    rows = [r["item_id"] for r in db.q("SELECT item_id FROM items WHERE series_id=? AND status='done' ORDER BY path",
                                       (series_id.lower(),))]
    if not order:
        return rows
    known = set(rows)
    first = [i.lower() for i in order if i.lower() in known]
    return first + [i for i in rows if i not in set(first)]


def pending(db: Database) -> int:
    return int(db.one("SELECT COUNT(*) FROM relabel_queue")[0])


def run_some(db: Database, voice_model: str | None, budget_s: float = RELABEL_BUDGET_S, should_stop=lambda: False) -> int:
    """Sert la file pendant `budget_s` au plus (au moins un élément). Rend le nombre fait."""
    t0 = time.monotonic()
    n = 0
    while True:
        row = db.one("SELECT item_id FROM relabel_queue ORDER BY seq LIMIT 1")
        if row is None:
            break
        t1 = time.monotonic()
        try:
            out = relabel_item(db, row["item_id"], voice_model)
            event(log, "[xray] %s : renommé sans relecture — %s", row["item_id"], out, item=row["item_id"],
                  action="relabel", seconds=round(time.monotonic() - t1, 2), result=out)
        except Exception:
            event(log, "[xray] %s : renommage en échec", row["item_id"], level=logging.ERROR, item=row["item_id"],
                  action="relabel_failed", exc_info=True)
        db.run("DELETE FROM relabel_queue WHERE item_id=?", (row["item_id"],))
        n += 1
        if time.monotonic() - t0 >= budget_s or should_stop():
            break
    return n
