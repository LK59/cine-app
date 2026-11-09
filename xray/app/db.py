"""Stockage SQLite : ordres, tronçons faits, plans, pistes de visages, résultats.

Tout ce qui coûte du calcul est écrit au fil de l'eau, tronçon par tronçon : un redémarrage
(déploiement, coupure) reprend l'analyse au premier tronçon non fait au lieu de tout refaire,
et un résultat partiel reste lisible pendant ce temps.

Une seule connexion, protégée par un verrou : l'API et l'unique ouvrier écrivent peu et
brièvement, et un seul écrivain évite tout « database is locked ».
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
    item_id     TEXT PRIMARY KEY,
    etag        TEXT NOT NULL,
    path        TEXT NOT NULL,
    priority    INTEGER NOT NULL,      -- 0 high, 1 normal, 2 low
    start_at    REAL NOT NULL DEFAULT 0,
    series_id   TEXT,
    cast_json   TEXT NOT NULL,
    status      TEXT NOT NULL,         -- queued | running | done | failed
    error       TEXT,
    duration    REAL,
    model       TEXT,
    seq         INTEGER NOT NULL,      -- ordre d'arrivée, départage les priorités égales
    attempts    INTEGER NOT NULL DEFAULT 0,
    version     INTEGER NOT NULL DEFAULT 1,  -- RESULT_VERSION sous laquelle les tronçons ont été faits
    created     REAL NOT NULL,
    updated     REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
    item_id TEXT NOT NULL,
    idx     INTEGER NOT NULL,
    start   REAL NOT NULL,
    end     REAL NOT NULL,
    done    INTEGER NOT NULL DEFAULT 0,
    decoder TEXT,
    PRIMARY KEY (item_id, idx)
);
CREATE TABLE IF NOT EXISTS shots (
    item_id   TEXT NOT NULL,
    chunk_idx INTEGER NOT NULL,
    start     REAL NOT NULL,
    end       REAL NOT NULL,
    hist      BLOB NOT NULL,
    PRIMARY KEY (item_id, start)
);
CREATE TABLE IF NOT EXISTS tracks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     TEXT NOT NULL,
    chunk_idx   INTEGER NOT NULL,
    shot_start  REAL NOT NULL,
    shot_end    REAL NOT NULL,
    screen_time REAL NOT NULL,
    quality     REAL NOT NULL,
    faces       INTEGER NOT NULL,
    emb         BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS tracks_item ON tracks(item_id);
CREATE TABLE IF NOT EXISTS results (
    item_id        TEXT PRIMARY KEY,
    etag           TEXT NOT NULL,
    model          TEXT NOT NULL,
    scenes_json    TEXT NOT NULL,
    analyzed_until REAL NOT NULL,
    progress       REAL NOT NULL,
    complete       INTEGER NOT NULL,
    updated        REAL NOT NULL,
    version        INTEGER NOT NULL DEFAULT 1   -- RESULT_VERSION de l'algorithme qui l'a produit
);
CREATE TABLE IF NOT EXISTS photo_emb (
    model   TEXT NOT NULL,
    url     TEXT NOT NULL,
    emb     BLOB,                       -- NULL : photo sans visage exploitable (on ne réessaie pas)
    fetched REAL NOT NULL,
    PRIMARY KEY (model, url)
);
CREATE TABLE IF NOT EXISTS series_faces (
    series_id TEXT NOT NULL,
    model     TEXT NOT NULL,
    person_id INTEGER NOT NULL,
    emb       BLOB NOT NULL,
    weight    REAL NOT NULL,
    updated   REAL NOT NULL,
    PRIMARY KEY (series_id, model, person_id)
);
"""


class Database:
    def __init__(self, path: Path | str):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.executescript(SCHEMA)
            self._migrate()

    def _migrate(self) -> None:
        """Colonnes ajoutées après coup. Une base d'avant la version 2 des résultats n'a pas de
        colonne `version` : ses lignes valent 1 — ce qui les a produites."""
        for table in ("items", "results"):
            cols = {r[1] for r in self._conn.execute(f"PRAGMA table_info({table})")}
            if "version" not in cols:
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN version INTEGER NOT NULL DEFAULT 1")

    @contextmanager
    def tx(self) -> Iterator[sqlite3.Connection]:
        """Transaction explicite : tout ou rien (un tronçon s'écrit d'un bloc)."""
        with self._lock:
            self._conn.execute("BEGIN IMMEDIATE")
            try:
                yield self._conn
            except BaseException:
                self._conn.execute("ROLLBACK")
                raise
            else:
                self._conn.execute("COMMIT")

    def q(self, sql: str, args: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, args).fetchall()

    def one(self, sql: str, args: tuple = ()) -> sqlite3.Row | None:
        with self._lock:
            return self._conn.execute(sql, args).fetchone()

    def run(self, sql: str, args: tuple = ()) -> None:
        with self._lock:
            self._conn.execute(sql, args)

    def close(self) -> None:
        with self._lock:
            self._conn.close()
