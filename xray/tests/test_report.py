"""Le rapport de décision (report.py, `GET /items/{id}/report`) et les raisons d'une voix sans nom (voices.py)."""

import collections
import json

import numpy as np
import pytest

from app import relabel, report
from app.voices import REASONS, VoiceParams, build
from conftest import AUTH, ITEM, ITEM2, unit
from test_relabel import SERIES, fresh, seed
from test_voices import dialogue, rng, scenes_of, shots_for  # noqa: F401  (rng : fixture)

HEX64 = set("0123456789abcdef")


# ---- raisons, sur des cas synthétiques ------------------------------------------------------------------

def voice_rows(r, regions, turns, label):
    """Les lignes du rapport des voix qui parlent pendant les tours `label`."""
    ids = collections.Counter()
    for s in r.segments:
        mid = (s["start"] + s["end"]) / 2
        k = next((i for i, (a, b) in enumerate(regions) if a <= mid < b), None)
        if k is not None and turns[k] == label:
            ids[s["voiceId"]] += 1
    by = {v["voiceId"]: v for v in r.voices}
    return [by[v] for v, _ in ids.most_common()]


def main_row(r, regions, turns, label):
    return voice_rows(r, regions, turns, label)[0]


def test_voix_nommees_par_les_visages(rng):
    A, B = unit(rng), unit(rng)
    turns = ["A", "B"] * 12
    regions, wins, embs = dialogue(rng, turns, {"A": A, "B": B})
    shown = {"A": [(1, 0.9), (2, 0.2)], "B": [(2, 0.9), (1, 0.2)]}
    r = build(regions, wins, embs, shots_for(regions, turns, shown), scenes_of(regions))
    a, b = main_row(r, regions, turns, "A"), main_row(r, regions, turns, "B")
    assert (a["personId"], a["via"]) == (1, "faces") and (b["personId"], b["via"]) == (2, "faces")
    assert "reason" not in a and a["candidate"]["personId"] == 1 and a["candidate"]["margin"] > 0
    assert 0 < a["confidence"] <= 1 and a["pieces"] >= 3
    # Les voix du rapport sont celles de /voices.
    assert {v["voiceId"] for v in r.voices} == {s["voiceId"] for s in r.segments}


def test_desaccord_avec_la_memoire(rng):
    A, B = unit(rng), unit(rng)
    turns = ["A", "B"] * 12
    regions, wins, embs = dialogue(rng, turns, {"A": A, "B": B})
    shown = {"A": [(1, 0.9), (2, 0.2)], "B": [(2, 0.9), (1, 0.2)]}
    r = build(regions, wins, embs, shots_for(regions, turns, shown), scenes_of(regions), memory={2: A, 1: B})
    a = main_row(r, regions, turns, "A")
    assert a["personId"] is None and a["reason"] == "conflict_memory"


def test_nommee_par_la_memoire_et_contraste_faible(rng):
    A, B = unit(rng), unit(rng)
    turns = ["A", "B"] * 12
    regions, wins, embs = dialogue(rng, turns, {"A": A, "B": B})
    # Toujours ensemble, à parts égales : les visages ne départagent pas.
    shown = {"A": [(1, 0.8), (2, 0.8)], "B": [(1, 0.8), (2, 0.8)]}
    pres = shots_for(regions, turns, shown)
    bare = build(regions, wins, embs, pres, scenes_of(regions))
    a = main_row(bare, regions, turns, "A")
    assert a["personId"] is None and a["reason"] == "low_contrast"
    mem = build(regions, wins, embs, pres, scenes_of(regions), memory={1: A, 2: B})
    a = main_row(mem, regions, turns, "A")
    assert (a["personId"], a["via"]) == (1, "memory")


def test_hors_champ_sans_candidat(rng):
    A, B, N = unit(rng), unit(rng), unit(rng)
    turns = ["A", "B"] * 10 + ["N"] * 8
    regions, wins, embs = dialogue(rng, turns, {"A": A, "B": B, "N": N})
    # La narration : personne à l'image.
    shown = {"A": [(1, 0.9), (2, 0.2)], "B": [(2, 0.9), (1, 0.2)], "N": []}
    r = build(regions, wins, embs, shots_for(regions, turns, shown), scenes_of(regions))
    n = main_row(r, regions, turns, "N")
    assert n["personId"] is None and n["reason"] == "off_screen_no_candidate"
    # Personne à l'image : pas de faux candidat (note, marge et présence à 0).
    assert n["candidate"] is None


def test_ligne_du_rapport_sans_chiffres_manquants():
    msg, _ = report.summary({"itemId": ITEM, "trigger": "lèvres", "counts": {"scenes": 12, "voicesNamed": 3,
                                                                             "voicesUndecided": 1}})
    assert "None" not in msg and "groupes de visages" not in msg and "lèvres 0" not in msg
    assert "12 scènes" in msg and "voix 3 nommées / 1 indécises" in msg
    msg, _ = report.summary({"itemId": ITEM, "trigger": "analyse",
                             "counts": {"scenes": 2, "facesNamed": 4, "faceClusters": 9, "asdTried": 2, "asdResolved": 1}})
    assert "4/9 groupes de visages nommés" in msg and "lèvres 1/2" in msg


def test_seconde_grosse_voix(rng):
    A, B, P = unit(rng), unit(rng), unit(rng)
    turns = ["A", "B"] * 12 + ["A", "P"] * 22
    regions, wins, embs = dialogue(rng, turns, {"A": A, "B": B, "P": P})
    shown = {"A": [(1, 0.9), (2, 0.2)], "B": [(2, 0.9), (1, 0.2)], "P": [(1, 0.9)]}
    r = build(regions, wins, embs, shots_for(regions, turns, shown), scenes_of(regions))
    p = main_row(r, regions, turns, "P")
    assert p["personId"] is None and p["reason"] == "second_big_voice"
    assert p["candidate"]["personId"] == 1  # le seul visage à l'image, écarté


def test_trop_peu_de_repliques_et_petite_voix(rng):
    A, B, C = unit(rng), unit(rng), unit(rng)
    turns = ["A", "B"] * 10 + ["C"] * 2
    regions, wins, embs = dialogue(rng, turns, {"A": A, "B": B, "C": C}, turn_len=3.0)
    shown = {"A": [(1, 0.9), (2, 0.2)], "B": [(2, 0.9), (1, 0.2)], "C": [(3, 0.9)]}
    pres = shots_for(regions, turns, shown)
    strict = build(regions, wins, embs, pres, scenes_of(regions),
                   params=VoiceParams(small_voice=6, small_conf=1.01, min_lines=2))
    c = main_row(strict, regions, turns, "C")
    assert c["personId"] is None and c["reason"] == "small_voice_low_conf" and c["pieces"] < 6
    default = build(regions, wins, embs, pres, scenes_of(regions), params=VoiceParams(min_lines=5))
    c = main_row(default, regions, turns, "C")
    assert c["personId"] is None and c["reason"] == "too_few_lines"


def test_levres_nomment_ou_votes_partages(rng):
    A, B = unit(rng), unit(rng)
    turns = ["A", "B"] * 12
    regions, wins, embs = dialogue(rng, turns, {"A": A, "B": B})
    shown = {"A": [(1, 0.8), (2, 0.8)], "B": [(1, 0.8), (2, 0.8)]}
    pres = shots_for(regions, turns, shown)
    votes = [(s + 0.2, s + 1.8, 1 if v == "A" else 2, 1.5, -1.0) for (s, e), v in zip(regions, turns)]
    r = build(regions, wins, embs, pres, scenes_of(regions), asd=votes)
    a = main_row(r, regions, turns, "A")
    assert (a["personId"], a["via"]) == (1, "asd") and a["asd"]["share"] == 1.0
    split = [(s + 0.2, s + 1.8, 1 + k % 4 // 2, 1.0, -1.0) for k, ((s, e), v) in enumerate(zip(regions, turns))]
    r = build(regions, wins, embs, pres, scenes_of(regions), asd=split)
    a = main_row(r, regions, turns, "A")
    assert a["personId"] is None and a["reason"] == "asd_split_votes"
    assert "low_contrast" in a["reasons"]


def test_raisons_dans_la_liste_stable(rng):
    A, B = unit(rng), unit(rng)
    turns = ["A", "B"] * 12
    regions, wins, embs = dialogue(rng, turns, {"A": A, "B": B})
    shown = {"A": [(1, 0.8), (2, 0.8)], "B": [(1, 0.8), (2, 0.8)]}
    r = build(regions, wins, embs, shots_for(regions, turns, shown), scenes_of(regions))
    for v in r.voices:
        if v["personId"] is None:
            assert v["reason"] in REASONS and all(x in REASONS for x in v.get("reasons", []))
        else:
            assert v["via"] in ("faces", "memory", "asd", "profile")


# ---- le rapport d'un élément --------------------------------------------------------------------------

def _seeded(db, item=ITEM, series=SERIES):
    g = np.random.default_rng(11)
    seed(db, g, item=item, series=series)
    built = fresh(db, item)
    db.run("UPDATE items SET skip_json=?, run_json=?, voice_track_json=? WHERE item_id=?",
           (json.dumps([[0.0, 4.5]]),
            json.dumps({"service": "1.0.0", "commit": "abc1234", "runs": 1, "skipSource": "ordre", "vaapiNoref": True,
                        "inference": {"engine": "openvino", "device": "GPU", "detector": "int8", "gpuError": None,
                                      "int8": {"state": "ready", "error": None}},
                        "int8Files": {"det_10g_int8.bin": "0" * 64}}),
            json.dumps({"track": {"index": 1, "rel": 0, "codec": "eac3", "channels": 6, "layout": "5.1(side)",
                                  "language": "eng", "title": "English", "default": True, "original": False,
                                  "excluded": False}, "reason": "original", "originalLanguage": "en"}),
            item))
    db.run("UPDATE chunks SET decoder='vaapi', stats=? WHERE item_id=? AND idx=0",
           (json.dumps({"seconds": {"detect": 1.0}, "counts": {"images": 10}, "device": "gpu"}), item))
    db.run("UPDATE chunks SET decoder='cpu', stats=? WHERE item_id=? AND idx=1",
           (json.dumps({"seconds": {"detect": 2.0}, "counts": {"images": 10}, "device": "cpu"}), item))
    return built


def test_schema_du_rapport(db):
    _seeded(db)
    rep = report.save(db, ITEM, "analyse")
    assert rep is not None
    assert set(rep) >= {"reportVersion", "itemId", "etag", "status", "service", "results", "models", "devices", "audio",
                        "thresholds", "skipped", "counts", "cpu", "voices", "faceClusters", "voiceReasons", "voiceVia"}
    assert rep["service"]["version"] == "1.0.0" and rep["service"]["analysedWith"]["commit"] == "abc1234"
    m = rep["models"]
    for f in (m["faces"]["detector"], m["faces"]["embedder"], m["voice"]["vad"], m["voice"]["embedder"], m["asd"]):
        assert len(f["sha256"]) == 64 and set(f["sha256"]) <= HEX64 and f["version"]
    assert m["faces"]["detector"]["precision"] == "int8"
    assert m["faces"]["detector"]["int8"]["files"] == {"det_10g_int8.bin": "0" * 64}
    d = rep["devices"]
    assert d["inference"]["chunks"] == {"gpu": 1, "cpu": 1} and d["inference"]["gpuShare"] == 0.5
    assert d["decode"]["chunks"] == {"vaapi": 1, "cpu": 1} and d["decode"]["noref"] == {"cpu": True, "vaapi": True}
    a = rep["audio"]
    assert a["reason"] == "original" and a["originalLanguage"] == "en"
    assert a["track"]["channelUse"] == "centre" and "pan=mono|c0=FC" in a["track"]["filter"]
    t = rep["thresholds"]
    assert t["smallVoice"] == {"pieces": 6, "confidence": 0.75}
    assert t["asd"]["votes"]["asd_votes"] == 3 and t["asd"]["votes"]["asd_share"] == 0.7
    assert t["scenes"]["burst"]["newPeople"] == 0.6 and t["faces"]["label"] == 0.30
    assert rep["skipped"] == {"source": "ordre", "ranges": [[0.0, 4.5]], "seconds": 4.5}
    c = rep["counts"]
    assert c["shots"] > 0 and c["scenes"] >= 1 and c["faceTracks"] > 0 and c["faceClusters"] >= 1
    assert c["voicesNamed"] >= 1 and "voicesUndecided" in c
    assert rep["cpu"]["stages"]["detect"] == 3.0
    for v in rep["voices"]:
        assert {"voiceId", "pieces", "seconds", "personId"} <= set(v)
        assert (v["personId"] is not None and v["via"] in ("faces", "memory", "asd", "profile")) or v["reason"] in REASONS
    fc = rep["faceClusters"]
    assert fc["named"] >= 1 and fc["listed"]
    for f in fc["listed"]:
        assert {"cluster", "seconds", "personId", "score", "margin", "band"} <= set(f)
        assert f["personId"] is not None or f["reason"]
    # Gardé en base, compact.
    row = db.one("SELECT etag, report_json FROM reports WHERE item_id=?", (ITEM,))
    assert row["etag"] == "e1" and len(row["report_json"]) < 60_000
    msg, fields = report.summary(rep)
    assert ITEM in msg and fields["action"] == "report" and fields["voicesNamed"] == c["voicesNamed"]


def test_api_rapport_et_lien_depuis_quality(client):
    db = client.db
    _seeded(db)
    _seeded(db, item=ITEM2, series=None)
    assert client.get(f"/items/{'f' * 32}/report", headers=AUTH).status_code == 404
    assert client.get("/items/xyz/report", headers=AUTH).status_code == 404
    assert client.get(f"/items/{ITEM}/report").status_code == 401
    r = client.get(f"/items/{ITEM}/report", headers=AUTH)
    assert r.status_code == 200 and r.json()["itemId"] == ITEM and r.json()["trigger"] == "lecture"
    # Refait à la demande puis gardé ; le même ensuite.
    assert db.one("SELECT 1 FROM reports WHERE item_id=?", (ITEM,)) is not None
    assert client.get(f"/items/{ITEM}/report", headers=AUTH).json()["generatedAt"] == r.json()["generatedAt"]
    q = client.get("/quality", headers=AUTH).json()
    urls = {i["itemId"]: i["reportUrl"] for i in q["items"]}
    assert urls == {ITEM: f"/items/{ITEM}/report", ITEM2: f"/items/{ITEM2}/report"}
    assert client.get(urls[ITEM2], headers=AUTH).status_code == 200


def test_renommer_refait_le_rapport_et_un_autre_fichier_l_oublie(client):
    db = client.db
    _seeded(db)
    relabel.relabel_item(db, ITEM, "wespeaker_r34")
    assert json.loads(db.one("SELECT report_json FROM reports WHERE item_id=?", (ITEM,))["report_json"])["trigger"] == "renommage"
    # Un autre etag : le rapport gardé ne sert plus, il est refait.
    db.run("UPDATE items SET etag='e2' WHERE item_id=?", (ITEM,))
    rep = client.get(f"/items/{ITEM}/report", headers=AUTH).json()
    assert rep["etag"] == "e2" and rep["trigger"] == "lecture"


def test_le_rapport_ne_fait_jamais_echouer(db, monkeypatch):
    _seeded(db)

    def boom(*a, **k):
        raise RuntimeError("panne du rapport")

    monkeypatch.setattr(report, "build", boom)
    assert report.save(db, ITEM, "analyse") is None
    # Un renommage passe quand même.
    out = relabel.relabel_item(db, ITEM, "wespeaker_r34")
    assert out["scenes"] >= 1


@pytest.mark.parametrize("trigger", ["analyse", "voix", "lèvres", "renommage"])
def test_ligne_de_resume(db, trigger):
    _seeded(db)
    rep = report.build(db, ITEM, trigger)
    msg, fields = report.summary(rep)
    assert f"rapport ({trigger})" in msg and fields["trigger"] == trigger
