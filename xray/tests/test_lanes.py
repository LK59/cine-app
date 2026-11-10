"""Voies d'analyse (`lanes.py`) : partage de la file entre la voie A et la voie B, jamais deux voies sur un
élément, `high` à la voie A, pause de la voie B pendant une transcodification, décision automatique."""

import json
import types

from app import lanes
from app.config import settings
from app.decode import MediaInfo
from app.jobs import JobStore, validate_job
from conftest import ITEM, ITEM2, job

ITEM3 = "d" * 32
ITEM4 = "e" * 32


def submit(store, item, priority):
    return store.submit(validate_job(job(item=item, priority=priority), settings.media_root))


def test_voie_b_seulement_a_cote_de_la_voie_a(db):
    s = JobStore(db)
    submit(s, ITEM, "normal")
    submit(s, ITEM2, "normal")
    # La voie A n'analyse rien : la voie B ne prend pas la tête de la file.
    assert s.claim("B", cpu_lane=True) is None
    assert s.claim("A")["item_id"] == ITEM
    s.set_status(ITEM, "running")
    assert s.claim("B", cpu_lane=True)["item_id"] == ITEM2
    assert s.running_ids() == {"A": ITEM, "B": ITEM2}


def test_jamais_deux_voies_sur_le_meme_element(db):
    s = JobStore(db)
    submit(s, ITEM, "normal")
    submit(s, ITEM2, "low")
    # Pris mais pas encore « running » : l'autre voie ne le reprend pas.
    assert s.claim("A")["item_id"] == ITEM
    assert s.claim("B", cpu_lane=True)["item_id"] == ITEM2
    s.release("B")
    s.release("A")
    assert s.claim("A")["item_id"] == ITEM
    assert s.claim("B", cpu_lane=True)["item_id"] == ITEM2
    # Plus rien d'autre en file : aucune voie ne prend un élément déjà pris.
    assert s.claim("B", cpu_lane=True) is None or s.lanes["B"] != s.lanes["A"]


def test_ordre_de_la_file_respecte(db):
    s = JobStore(db)
    for it in (ITEM, ITEM2, ITEM3):
        submit(s, it, "normal")
    assert s.claim("A")["item_id"] == ITEM
    assert s.claim("B", cpu_lane=True)["item_id"] == ITEM2  # l'épisode suivant, pas le troisième


def test_high_va_a_la_voie_a(db):
    s = JobStore(db)
    submit(s, ITEM, "normal")
    assert s.claim("A")["item_id"] == ITEM
    s.set_status(ITEM, "running")
    submit(s, ITEM2, "high")
    submit(s, ITEM3, "low")
    # La voie B saute le `high` et prend le suivant ; la voie A cède à son prochain tronçon.
    assert s.claim("B", cpu_lane=True)["item_id"] == ITEM3
    s.set_status(ITEM3, "running")
    assert s.should_yield(ITEM)
    # La voie B ne cède pas à un `high` qu'elle ne prendrait pas…
    assert not s.should_yield(ITEM3, cpu_lane=True)
    # … mais à un `normal` devant son `low`.
    submit(s, ITEM4, "normal")
    assert s.should_yield(ITEM3, cpu_lane=True)


def test_voie_b_laisse_la_4k_a_la_voie_a(db):
    s = JobStore(db)
    for it in (ITEM, ITEM2, ITEM3):
        submit(s, it, "normal")
    s.claim("A")
    # ITEM2 en 4K : la voie B le laisse en file, à sa place, et prend le suivant.
    got = s.claim("B", cpu_lane=True, accept=lambda r: r["item_id"] != ITEM2)
    assert got["item_id"] == ITEM3 and s.get(ITEM2)["status"] == "queued"
    s.release("A")
    assert s.claim("A")["item_id"] == ITEM  # pas encore « running » : rien n'a bougé dans la file


def test_element_de_la_voie_b_passe_high_rendu(db):
    s = JobStore(db)
    submit(s, ITEM, "normal")
    submit(s, ITEM2, "normal")
    s.claim("A")
    s.set_status(ITEM, "running")
    assert s.claim("B", cpu_lane=True)["item_id"] == ITEM2
    s.set_status(ITEM2, "running")
    assert not s.should_yield(ITEM2, cpu_lane=True)
    db.run("UPDATE items SET priority=0 WHERE item_id=?", (ITEM2,))  # quelqu'un le regarde maintenant
    assert s.should_yield(ITEM2, cpu_lane=True)


def test_annulation_par_voie(db):
    s = JobStore(db)
    submit(s, ITEM, "normal")
    submit(s, ITEM2, "normal")
    s.claim("A")
    s.claim("B", cpu_lane=True)
    s.delete(ITEM2)
    assert s.cancel_event("B").is_set() and not s.cancel_event("A").is_set()
    s.release("B")
    assert not s.cancel_event("B").is_set() and s.lanes["B"] is None


class _Guard:
    def __init__(self, busy):
        self._b = busy

    def busy(self):
        return self._b

    def busy_now(self):
        return self._b


def test_voie_b_en_pause_pendant_une_transcodification(db, monkeypatch):
    from app import cast as castmod
    from app import decode
    from app import worker as wmod
    from conftest import FakeModels

    s = JobStore(db)
    submit(s, ITEM, "normal")
    submit(s, ITEM2, "normal")
    s.claim("A")
    s.set_status(ITEM, "running")
    row = s.claim("B", cpu_lane=True)
    monkeypatch.setattr(decode, "probe", lambda p: MediaInfo(600, "h264", "High", 1920, 1080, "yuv420p"))
    monkeypatch.setattr(castmod, "photo_embeddings", lambda *a, **k: {})
    db.run("UPDATE items SET skip_json='[]' WHERE item_id=?", (ITEM2,))
    w = wmod.Worker(db, s, FakeModels(), _Guard(True), lane="B", cpu_only=True, threads=6)
    w.engine = types.SimpleNamespace()
    called = []
    monkeypatch.setattr(w, "process_chunk", lambda *a: called.append(a))
    w.run(db.one("SELECT * FROM items WHERE item_id=?", (row["item_id"],)))
    assert called == []  # aucun tronçon commencé
    assert s.get(ITEM2)["status"] == "queued" and w.paused
    s.release("B")
    # Transcodification finie : la voie B reprend l'élément.
    w.guard = _Guard(False)
    seen = []

    def fake_chunk(item_id, path, info, idx, start, end):
        seen.append(idx)
        raise wmod.Cancelled()

    monkeypatch.setattr(w, "process_chunk", fake_chunk)
    row = s.claim("B", cpu_lane=True)
    assert row["item_id"] == ITEM2
    try:
        w.run(db.one("SELECT * FROM items WHERE item_id=?", (ITEM2,)))
    except wmod.Cancelled:
        pass
    assert seen == [0]


def test_decision_automatique(monkeypatch):
    gib = 1024 ** 3
    assert lanes.decide("auto", cpus=12, memory=8 * gib, gpu=True).count == 2
    assert lanes.decide("auto", cpus=12, memory=None, gpu=True).count == 2
    assert lanes.decide("auto", cpus=12, memory=8 * gib, gpu=False).count == 1
    assert lanes.decide("auto", cpus=4, memory=8 * gib, gpu=True).count == 1
    low = lanes.decide("auto", cpus=12, memory=4 * gib, gpu=True)
    assert low.count == 1 and "mémoire" in low.reason
    assert lanes.decide("1", cpus=12, memory=None, gpu=True).count == 1
    assert lanes.decide("2", cpus=4, memory=None, gpu=False).count == 2
    p = lanes.decide("auto", cpus=12, memory=None, gpu=True)
    # Budget partagé : voie B + ffmpeg de la voie A + voix sans dépasser le quota.
    assert p.b_threads == 4 and p.b_threads + p.a_decode_threads + p.voice_threads <= 12
    monkeypatch.setattr(settings, "lane_b_threads", 7)
    assert lanes.decide("auto", cpus=12, memory=None, gpu=True).b_threads == 7
    d = p.as_dict()
    assert d["count"] == 2 and d["threads"]["B"] == 4 and json.dumps(d)


def test_igpu_absent_au_chargement_arrete_la_voie_b():
    p = lanes.decide("auto", cpus=12, memory=None, gpu=True)
    p.gpu_failed("pas de pilote")
    assert p.count == 1 and not p.gpu
    forced = lanes.decide("2", cpus=12, memory=None, gpu=True)
    forced.gpu_failed("pas de pilote")
    assert forced.count == 2


def test_lignes_du_journal_portent_la_voie():
    import logging

    from app.logs import JsonFormatter, lane_scope

    with lane_scope("B"):
        rec = logging.getLogger("xray.worker").makeRecord("xray.worker", logging.INFO, __file__, 1, "x", (), None)
    assert json.loads(JsonFormatter().format(rec))["lane"] == "B"
