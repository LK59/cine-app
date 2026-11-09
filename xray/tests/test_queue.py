"""La file : ordre de passage, cession à un ordre plus pressé, reprise après redémarrage."""

from app.jobs import JobStore, validate_job
from app.config import settings
from app.worker import chunk_order
from conftest import ITEM, ITEM2, job

ITEM3 = "d" * 32


def submit(store, item, priority):
    return store.submit(validate_job(job(item=item, priority=priority), settings.media_root))


def test_ordre_priorite_puis_arrivee(db):
    s = JobStore(db)
    submit(s, ITEM, "low")
    submit(s, ITEM2, "normal")
    submit(s, ITEM3, "normal")
    assert s.next_job()["item_id"] == ITEM2
    assert [s.position(i) for i in (ITEM2, ITEM3, ITEM)] == [1, 2, 3]
    submit(s, ITEM, "high")
    assert s.next_job()["item_id"] == ITEM


def test_cede_la_place(db):
    s = JobStore(db)
    submit(s, ITEM, "normal")
    s.set_status(ITEM, "running")
    assert not s.should_yield(ITEM)
    submit(s, ITEM2, "low")
    assert not s.should_yield(ITEM)
    submit(s, ITEM3, "high")
    assert s.should_yield(ITEM)
    # Un ordre en cours a la position 0.
    assert s.position(ITEM) == 0


def test_reprise_apres_redemarrage(db):
    s = JobStore(db)
    submit(s, ITEM, "normal")
    s.set_status(ITEM, "running")
    db.run("INSERT INTO chunks (item_id, idx, start, end, done) VALUES (?, 0, 0, 120, 1)", (ITEM,))
    s2 = JobStore(db)  # nouveau processus
    assert s2.get(ITEM)["status"] == "queued"
    assert db.one("SELECT done FROM chunks WHERE item_id=?", (ITEM,))[0] == 1


def test_suppression_pendant_l_analyse_annule(db):
    s = JobStore(db)
    submit(s, ITEM, "normal")
    s.running_id = ITEM
    s.delete(ITEM)
    assert s.cancel.is_set()


def test_changement_de_fichier_pendant_l_analyse_annule(db):
    s = JobStore(db)
    submit(s, ITEM, "normal")
    s.set_status(ITEM, "running")
    s.running_id = ITEM
    s.submit(validate_job(job(item=ITEM, etag="autre"), settings.media_root))
    assert s.cancel.is_set()
    assert s.get(ITEM)["status"] == "queued"


def test_ordre_des_troncons():
    chunks = [(i, i * 120.0, (i + 1) * 120.0) for i in range(5)]
    assert [c[0] for c in chunk_order(chunks, 0)] == [0, 1, 2, 3, 4]
    assert [c[0] for c in chunk_order(chunks, 250)] == [2, 3, 4, 0, 1]
    assert [c[0] for c in chunk_order(chunks, 240)] == [2, 3, 4, 0, 1]
    assert [c[0] for c in chunk_order(chunks, 10_000)] == [0, 1, 2, 3, 4]
