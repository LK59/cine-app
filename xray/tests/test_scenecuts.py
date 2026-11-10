"""« Revenir au début de la scène » : chapitres, mesures des frontières, point d'entrée, règles des coupes,
et `/scenes` qui reste ce qu'il était (scenecuts.py)."""

import json
import time

import numpy as np

from app import scenecuts as sc
from app.results import ShotRow, TrackRow, build
from app.shots import _PLAIN, ShotInfo
from conftest import AUTH, ITEM, job, noisy, unit


# ---- chapitres ------------------------------------------------------------------------------------

def _ch(*starts, titles=None, end=3000.0):
    out = []
    for i, s in enumerate(starts):
        e = starts[i + 1] if i + 1 < len(starts) else end
        out.append({"start": float(s), "end": float(e), "title": (titles[i] if titles else f"Chapter {i + 1:02d}")})
    return out


def test_chapitres_lus_dans_ffprobe():
    raw = {"chapters": [
        {"id": 1, "start_time": "312.400000", "end_time": "845.100000", "tags": {"title": "La fuite"}},
        {"id": 0, "start_time": "0.000000", "end_time": "312.400000", "tags": {"title": "Ouverture"}},
        {"id": 2, "start_time": "pas un nombre", "end_time": "1"},
    ]}
    assert sc.parse_chapters(raw) == [{"start": 0.0, "end": 312.4, "title": "Ouverture"},
                                      {"start": 312.4, "end": 845.1, "title": "La fuite"}]
    assert sc.parse_chapters({}) == []


def test_chapitres_classes():
    # Toutes les cinq minutes : un outil (mkvmerge, HandBrake), pas un auteur.
    assert sc.classify_chapters(_ch(0, 300, 600, 900, 1200)) == "automatique"
    assert sc.classify_chapters(_ch(0, 300.4, 599.8, 900.2, titles=["", "", "", ""])) == "automatique"
    # « Chapter N » à des minutes rondes mais inégales : automatiques aussi.
    assert sc.classify_chapters(_ch(0, 300, 600, 1200)) == "automatique"
    # « Chapter 01 » à des instants quelconques : les chapitres du disque (MakeMKV garde leurs instants).
    assert sc.classify_chapters(_ch(0, 312.4, 845.1, 1290.7)) == "auteur"
    assert sc.classify_chapters(_ch(0, 95.2, 1200.0, titles=["Le bal", "La fuite", "Le retour"])) == "auteur"
    # Des repères de segments, pas des scènes.
    assert sc.classify_chapters(_ch(0, 62.4, 1750.0, titles=["Intro", "Episode", "Credits"])) == "marqueurs"
    assert sc.classify_chapters(_ch(0, 1800, titles=["Générique", "Film"])) == "marqueurs"
    # Episode seul ne fait pas des marqueurs : rien d'un générique.
    assert sc.classify_chapters(_ch(0, 1000, titles=["Episode", "Film"])) == "auteur"
    assert sc.classify_chapters(_ch(0)) == "aucun"
    assert sc.classify_chapters([]) == "aucun"


def test_chapitres_d_un_document():
    assert sc.chapters_of(None) == ("inconnu", [])
    assert sc.chapters_of({"error": "ffprobe : x"}) == ("illisible", [])
    assert sc.chapters_of({"chapters": _ch(0, 300, 600, 900)}) == ("automatique", [])
    # Le premier chapitre (au début du fichier) n'est pas une coupe.
    assert sc.chapters_of({"chapters": _ch(0, 312.4, 845.1)}) == ("auteur", [312.4, 845.1])


def test_chapitres_d_un_fichier_illisible_ne_levent_pas(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "ffprobe", "/nulle/part/ffprobe")
    doc = sc.probe_chapters("/nulle/part.mkv")
    assert "error" in doc and "chapters" not in doc


# ---- parole ---------------------------------------------------------------------------------------

def test_parole_fusionnee_et_traversante():
    runs = sc.speech_runs([(10.0, 12.0), (12.3, 15.0), (20.0, 21.0), (5.0, 6.0)])
    assert runs == [(5.0, 6.0), (10.0, 15.0), (20.0, 21.0)]
    assert sc.speech_across(runs, 13.0) == (10.0, 15.0)
    # Une parole qui finit juste à la coupe ne la traverse pas.
    assert sc.speech_across(runs, 14.9) is None
    assert sc.speech_across(runs, 17.0) is None
    assert sc.speech_share(runs, [(0.0, 20.0)]) == round((1.0 + 5.0) / 20.0, 4)
    assert sc.speech_share(runs, []) is None


# ---- mesures, à l'assemblage ----------------------------------------------------------------------

def _hist(seed):
    rng = np.random.default_rng(seed)
    h = np.full(64, 0.002, np.float32)
    for a, b in ((0, 32), (32, 48), (48, 64)):
        h[a + int(rng.integers(0, b - a))] += 1.0
    for a, b in ((0, 32), (32, 48), (48, 64)):
        h[a:b] /= h[a:b].sum()
    return h


def test_mesures_des_frontieres():
    room1, room2 = _hist(1), _hist(2)
    a = [ShotInfo(0, 30, room1, {0, 1}), ShotInfo(30, 70, room1, {0})]
    b = [ShotInfo(70, 100, room2, {2, 3}), ShotInfo(100, 200, room2, {4})]
    out = sc.boundary_features([a, b], _PLAIN, first_interval=True)
    assert out[0] == {"t": 0.0, "first": True}
    f = out[1]
    assert f["t"] == 70.0 and f["fb"] == 2 and f["fa"] == 3 and f["fj"] == 0.0  # 2, 3 et 4 (< 70 + 60 s)
    assert f["sim"] == round(_PLAIN.scenes(a, b), 3) and f["sim"] < 0.5
    # Une plage qui ne commence pas le fichier : sa première scène suit un trou (générique sauté).
    assert sc.boundary_features([b], _PLAIN, first_interval=False) == [{"t": 70.0, "gap": True}]
    # La minute de part et d'autre seulement : le groupe 4 vu à 100 s compte (< 70 + 60), pas au-delà.
    c = [ShotInfo(200, 300, room1, {9})]
    out = sc.boundary_features([b, c], _PLAIN, first_interval=True)
    assert out[1]["fb"] == 1  # seul le plan 100–200 finit dans la minute d'avant 200 s
    # Sans aucun visage : pas d'indice.
    out = sc.boundary_features([[ShotInfo(0, 10, room1)], [ShotInfo(10, 20, room2)]], _PLAIN, True)
    assert out[1]["fj"] is None and out[1]["fb"] == 0


def test_build_garde_les_mesures_sans_toucher_aux_scenes():
    rng = np.random.default_rng(3)
    a, b, x, y = unit(rng), unit(rng), unit(rng), unit(rng)
    room1, room2 = _hist(4), _hist(5)
    shots, tracks = [], []
    t = 0.0
    for i in range(8):
        shots.append(ShotRow(t, t + 5, room1))
        tracks.append(TrackRow(t, t + 5, 5.0, 0.8, noisy(rng, a if i % 2 == 0 else b, 0.3)))
        t += 5
    for i in range(8):
        shots.append(ShotRow(t, t + 5, room2))
        tracks.append(TrackRow(t, t + 5, 5.0, 0.8, noisy(rng, x if i % 2 == 0 else y, 0.3)))
        t += 5
    built = build(80.0, [(0, 80)], 1, 0.0, shots, tracks, [], 0.30, 0.42)
    assert [(s["start"], s["end"]) for s in built.scenes] == [(0.0, 40.0), (40.0, 80.0)]
    assert built.bounds[0] == {"t": 0.0, "first": True}
    assert built.bounds[1]["t"] == 40.0 and built.bounds[1]["fj"] == 0.0
    assert built.bounds[1]["fb"] == 2 and built.bounds[1]["fa"] == 2


# ---- les règles -----------------------------------------------------------------------------------

def _scene(start, end):
    return {"start": float(start), "end": float(end), "people": []}


CHANGE = {"sim": 0.5, "fb": 3, "fa": 3, "fj": 0.0}


def test_regles_des_coupes():
    scenes = [_scene(0, 100), _scene(100, 160), _scene(160, 200), _scene(200, 215), _scene(215, 230),
              _scene(230, 400), _scene(400, 500), _scene(500, 600)]
    bounds = [
        {"t": 0.0, "first": True},
        {"t": 100.0, **CHANGE},                                  # deux signaux, parole 2 s avant : entrée reculée
        {"t": 160.0, "sim": 0.9, "fb": 3, "fa": 3, "fj": 0.5},   # même décor, mêmes personnes
        {"t": 200.0, **CHANGE},                                  # au milieu d'une phrase commencée 10 s avant
        {"t": 215.0, "sim": 0.5, "fb": 0, "fa": 0, "fj": None},  # deux scènes courtes sans visage ni parole
        {"t": 230.0, "sim": 0.81, "fb": 2, "fa": 2, "fj": 0.15}, # deux signaux, juste au seuil
        {"t": 400.0, "sim": 0.5, "fb": 3, "fa": 1, "fj": 0.0},   # couleurs seules : un seul signal
        {"t": 500.0, "sim": 0.95, "fb": 3, "fa": 3, "fj": 1.0},  # même lieu, mais un chapitre d'auteur
    ]
    runs = sc.speech_runs([(98.0, 103.0), (190.0, 205.0)])
    out = sc.decide(scenes, bounds, runs, [499.0])
    got = [(x["entry"], x["cut"]["ok"], x["cut"]["why"]) for x in out]
    assert got == [
        (0.0, True, "début"),
        (98.0, True, "deux-signaux"),
        (160.0, False, "même-lieu"),
        (200.0, False, "parole"),
        (215.0, False, "montage"),
        (230.0, True, "deux-signaux"),
        (400.0, False, "même-lieu"),
        (500.0, True, "chapitre"),
    ]


def test_un_seul_signal_ne_suffit_pas():
    scenes = [_scene(0, 100), _scene(100, 300)]
    for bound in ({"sim": 0.83, "fb": 3, "fa": 3, "fj": 0.0},   # personnes seules
                  {"sim": 0.5, "fb": 3, "fa": 3, "fj": 0.2},    # couleurs seules
                  {"sim": 0.5, "fb": 1, "fa": 3, "fj": 0.0}):   # trop peu de visages d'un côté
        out = sc.decide(scenes, [{"t": 0.0, "first": True}, {"t": 100.0, **bound}], [], [])
        assert out[1]["cut"] == {"ok": False, "why": "même-lieu"}


def test_chapitre_l_emporte_sur_la_parole_et_garde_l_entree():
    scenes = [_scene(0, 100), _scene(100, 300)]
    bounds = [{"t": 0.0, "first": True}, {"t": 100.0, "sim": 0.95, "fb": 0, "fa": 0, "fj": None}]
    out = sc.decide(scenes, bounds, sc.speech_runs([(98.5, 110.0)]), [101.5])
    assert out[1] == {"entry": 98.5, "cut": {"ok": True, "why": "chapitre"}}
    # Un chapitre à plus de 2 s ne dit rien.
    out = sc.decide(scenes, bounds, [], [102.5])
    assert out[1]["cut"]["ok"] is False


def test_ilot():
    # Une scène courte acceptée entre deux frontières refusées : refusée elle aussi.
    scenes = [_scene(0, 100), _scene(100, 200), _scene(200, 240), _scene(240, 400)]
    same = {"sim": 0.9, "fb": 3, "fa": 3, "fj": 0.6}
    bounds = [{"t": 0.0, "first": True}, {"t": 100.0, **same}, {"t": 200.0, **CHANGE}, {"t": 240.0, **same}]
    out = sc.decide(scenes, bounds, [], [])
    assert out[2]["cut"] == {"ok": False, "why": "îlot"}
    # Longue d'une minute ou plus : gardée.
    scenes[2] = _scene(200, 260)
    scenes[3] = _scene(260, 400)
    bounds[3] = {"t": 260.0, **same}
    assert sc.decide(scenes, bounds, [], [])[2]["cut"] == {"ok": True, "why": "deux-signaux"}


def test_apres_un_trou_et_frontiere_sans_mesure():
    scenes = [_scene(62.4, 200), _scene(200, 300), _scene(300, 400)]
    bounds = [{"t": 62.4, "gap": True}, {"t": 300.0, **CHANGE}]
    out = sc.decide(scenes, bounds, [], [])
    assert out[0]["cut"] == {"ok": True, "why": "après-saut"}
    assert out[1] is None  # regroupée autrement que la mesure : rien n'est dit
    assert out[2]["cut"]["ok"] is True


# ---- /scenes : un ajout compatible ----------------------------------------------------------------

SCENES = [{"start": 0.0, "end": 100.0, "people": [{"personId": 1, "screenTime": 40.0, "confidence": 0.9}]},
          {"start": 100.0, "end": 300.0, "people": []}]


def _done(db, bounds=True, complete=True, voice=True, chapters=None):
    db.run("UPDATE items SET status='done', chapters_json=? WHERE item_id=?",
           (json.dumps(chapters) if chapters is not None else None, ITEM))
    db.run("INSERT OR REPLACE INTO results (item_id, etag, model, scenes_json, analyzed_until, progress, complete,"
           " updated, version, bounds_json) VALUES (?, 'etag-1', 'buffalo_l', ?, 300, 1, ?, ?, 5, ?)",
           (ITEM, json.dumps(SCENES), 1 if complete else 0, time.time(),
            sc.bounds_doc([{"t": 0.0, "first": True}, {"t": 100.0, **CHANGE}]) if bounds else None))
    if voice:
        db.run("INSERT OR REPLACE INTO voice_results (item_id, etag, model, segments_json, analyzed_until, complete,"
               " version, updated) VALUES (?, 'etag-1', 'wespeaker_r34', '[]', 300, 1, 2, ?)", (ITEM, time.time()))
        db.run("INSERT INTO voice_regions (item_id, chunk_idx, start, end) VALUES (?, 0, 98.0, 102.0)", (ITEM,))
        db.run("INSERT INTO voice_regions (item_id, chunk_idx, start, end) VALUES (?, 1, 150.0, 210.0)", (ITEM,))


def test_scenes_sans_mesure_inchangees(client):
    client.post("/jobs", json=job(), headers=AUTH)
    _done(client.db, bounds=False)
    body = client.get(f"/items/{ITEM}/scenes", headers=AUTH).json()
    assert body == {"itemId": ITEM, "etag": "etag-1", "model": "buffalo_l", "version": 5, "complete": True,
                    "analyzedUntil": 300.0, "scenes": SCENES}


def test_scenes_partielles_sans_ajout(client):
    client.post("/jobs", json=job(), headers=AUTH)
    _done(client.db, complete=False)
    body = client.get(f"/items/{ITEM}/scenes", headers=AUTH).json()
    assert "speechShare" not in body and body["scenes"] == SCENES


def test_scenes_mesurees(client):
    client.post("/jobs", json=job(), headers=AUTH)
    _done(client.db, chapters={"chapters": [{"start": 0.0, "end": 100.0, "title": "Un"},
                                            {"start": 99.0, "end": 300.0, "title": "Deux"}]})
    body = client.get(f"/items/{ITEM}/scenes", headers=AUTH).json()
    # Les scènes et leurs personnes, exactement ; rien que des champs en plus.
    assert [{k: s[k] for k in ("start", "end", "people")} for s in body["scenes"]] == SCENES
    assert body["scenes"][0]["entry"] == 0.0 and body["scenes"][0]["cut"] == {"ok": True, "why": "début"}
    assert body["scenes"][1]["entry"] == 98.0 and body["scenes"][1]["cut"] == {"ok": True, "why": "chapitre"}
    assert body["speechShare"] == round((4.0 + 60.0) / 300.0, 4)
    assert body["chapters"] == {"kind": "auteur", "count": 2, "aligned": 1}
    assert body["cutsVersion"] == sc.CUTS_VERSION
    assert body["version"] == 5


def test_parole_inconnue_pas_de_verdict(client):
    client.post("/jobs", json=job(), headers=AUTH)
    _done(client.db, voice=False)
    body = client.get(f"/items/{ITEM}/scenes", headers=AUTH).json()
    assert body["scenes"] == SCENES and body["speechShare"] is None
    assert body["chapters"]["kind"] == "inconnu"


def test_mesure_d_une_autre_version_ignoree(client):
    client.post("/jobs", json=job(), headers=AUTH)
    _done(client.db)
    client.db.run("UPDATE results SET bounds_json=? WHERE item_id=?", ('{"v":0,"bounds":[]}', ITEM))
    body = client.get(f"/items/{ITEM}/scenes", headers=AUTH).json()
    assert "cutsVersion" not in body and body["scenes"] == SCENES


# ---- les résultats d'avant ------------------------------------------------------------------------

def test_mesure_des_resultats_d_avant(client, monkeypatch):
    """Un résultat fini sans mesure : le regroupement est refait depuis la base, seules les mesures sont
    écrites — les scènes ne bougent pas — et les chapitres sont lus une fois (ici, un fichier factice :
    illisible, noté tel)."""
    from app.config import settings

    monkeypatch.setattr(settings, "ffprobe", "/nulle/part/ffprobe")
    db = client.db
    client.post("/jobs", json=job(), headers=AUTH)
    room1, room2 = _hist(7), _hist(8)
    rng = np.random.default_rng(9)
    a, b = unit(rng), unit(rng)
    db.run("UPDATE items SET status='done', duration=80 WHERE item_id=?", (ITEM,))
    db.run("INSERT INTO chunks (item_id, idx, start, end, done) VALUES (?, 0, 0, 80, 1)", (ITEM,))
    for i, t in enumerate(range(0, 80, 5)):
        room = room1 if t < 40 else room2
        db.run("INSERT INTO shots (item_id, chunk_idx, start, end, hist) VALUES (?, 0, ?, ?, ?)",
               (ITEM, float(t), float(t + 5), room.tobytes()))
        emb = noisy(rng, a if t < 40 else b, 0.3)
        db.run("INSERT INTO tracks (item_id, chunk_idx, shot_start, shot_end, screen_time, quality, faces, emb)"
               " VALUES (?, 0, ?, ?, 5, 0.8, 3, ?)", (ITEM, float(t), float(t + 5), emb.tobytes()))
    stored = [{"start": 0.0, "end": 40.0, "people": [{"personId": 1, "screenTime": 20.0, "confidence": 0.8}]},
              {"start": 40.0, "end": 80.0, "people": []}]
    db.run("INSERT INTO results (item_id, etag, model, scenes_json, analyzed_until, progress, complete, updated, version)"
           " VALUES (?, 'etag-1', 'buffalo_l', ?, 80, 1, 1, ?, 5)", (ITEM, json.dumps(stored), time.time()))
    row = sc.next_backfill(db)
    assert row is not None and row["item_id"] == ITEM
    assert sc.backfill_some(db, budget_s=5.0) == 1
    assert sc.next_backfill(db) is None
    res = db.one("SELECT scenes_json, bounds_json FROM results WHERE item_id=?", (ITEM,))
    assert json.loads(res["scenes_json"]) == stored
    doc = json.loads(res["bounds_json"])
    assert doc["v"] == sc.CUTS_VERSION and [x["t"] for x in doc["bounds"]] == [0.0, 40.0]
    chapters = json.loads(db.one("SELECT chapters_json FROM items WHERE item_id=?", (ITEM,))["chapters_json"])
    assert "error" in chapters
