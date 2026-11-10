"""Taille des pages de la base : 16 Kio pour une base neuve, une base ancienne réécrite une fois."""
import sqlite3

from app.db import PAGE_SIZE, Database


def _pragma(path, name):
    c = sqlite3.connect(str(path))
    try:
        return c.execute(f"PRAGMA {name}").fetchone()[0]
    finally:
        c.close()


def test_base_neuve_en_pages_de_16_kio(tmp_path):
    path = tmp_path / "x.db"
    Database(path)
    assert _pragma(path, "page_size") == PAGE_SIZE
    assert _pragma(path, "journal_mode") == "wal"


def test_base_ancienne_reecrite_sans_perte(tmp_path):
    path = tmp_path / "x.db"
    old = sqlite3.connect(str(path))
    old.execute("PRAGMA page_size=4096")
    old.execute("PRAGMA journal_mode=WAL")
    old.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, emb BLOB)")
    rows = [(i, bytes([i % 256]) * 2048) for i in range(200)]
    old.executemany("INSERT INTO t VALUES (?, ?)", rows)
    old.commit()
    old.close()
    assert _pragma(path, "page_size") == 4096

    Database(path)
    assert _pragma(path, "page_size") == PAGE_SIZE
    assert _pragma(path, "journal_mode") == "wal"
    c = sqlite3.connect(str(path))
    assert c.execute("SELECT id, emb FROM t ORDER BY id").fetchall() == rows
    assert c.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    c.close()
    # Rouverte : rien à refaire.
    Database(path)
    assert _pragma(path, "page_size") == PAGE_SIZE
