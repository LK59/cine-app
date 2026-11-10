"""Stockage SQLite : ordres, tronçons faits, plans, pistes de visages, résultats.

Tout ce qui coûte du calcul est écrit au fil de l'eau, tronçon par tronçon : un redémarrage
(déploiement, coupure) reprend l'analyse au premier tronçon non fait au lieu de tout refaire,
et un résultat partiel reste lisible pendant ce temps.

Une seule connexion, protégée par un verrou : l'API et les ouvriers (une voie d'analyse ou deux,
`lanes.py`) écrivent peu et brièvement, chacun pour son élément, et un seul écrivain évite tout
« database is locked » — deux voies attendent le verrou l'une de l'autre, jamais SQLite (mode WAL).
"""

from __future__ import annotations

import logging
import sqlite3
import threading
import time
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
-- « Qui parle » (11/2026, voir voice.py / voices.py) : par tronçon, les zones de parole et une empreinte
-- de voix par fenêtre (float16) ; le résultat assemblé ; la mémoire des voix d'une série.
CREATE TABLE IF NOT EXISTS voice_regions (
    item_id   TEXT NOT NULL,
    chunk_idx INTEGER NOT NULL,
    start     REAL NOT NULL,
    end       REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS voice_regions_item ON voice_regions(item_id);
CREATE TABLE IF NOT EXISTS voice_windows (
    item_id   TEXT NOT NULL,
    chunk_idx INTEGER NOT NULL,
    start     REAL NOT NULL,
    end       REAL NOT NULL,
    emb       BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS voice_windows_item ON voice_windows(item_id);
CREATE TABLE IF NOT EXISTS voice_results (
    item_id        TEXT PRIMARY KEY,
    etag           TEXT NOT NULL,
    model          TEXT NOT NULL,
    track_json     TEXT,
    segments_json  TEXT NOT NULL,
    analyzed_until REAL NOT NULL,
    complete       INTEGER NOT NULL,
    version        INTEGER NOT NULL,
    stats_json     TEXT,
    updated        REAL NOT NULL
);
-- La mémoire d'une série, visages et voix, par contribution d'épisode (memory.py).
CREATE TABLE IF NOT EXISTS series_memory (
    series_id TEXT NOT NULL,
    kind      TEXT NOT NULL,          -- face | voice
    model     TEXT NOT NULL,
    person_id INTEGER NOT NULL,
    item_id   TEXT NOT NULL,          -- l'épisode qui a contribué ('legacy' : reprise de series_faces)
    emb       BLOB NOT NULL,
    weight    REAL NOT NULL,
    score     REAL NOT NULL,
    updated   REAL NOT NULL,
    PRIMARY KEY (series_id, kind, model, person_id, item_id)
);
-- Renommer sans relire le fichier (relabel.py) : une file d'éléments, servie par l'ouvrier.
CREATE TABLE IF NOT EXISTS relabel_queue (
    item_id   TEXT PRIMARY KEY,
    seq       INTEGER NOT NULL,
    requested REAL NOT NULL
);
-- Lecture des lèvres (asdjob.py) : un vote par morceau lu — qui, parmi les visages à l'image, parlait
-- (personId, NULL pour un visage sans nom), sa note Light-ASD et celle du suivant ; et le passage par
-- élément (fenêtres faites, pour reprendre ; bilan). Gardés à travers les renommages.
CREATE TABLE IF NOT EXISTS asd_votes (
    item_id   TEXT NOT NULL,
    start     REAL NOT NULL,
    end       REAL NOT NULL,
    person_id INTEGER,
    score     REAL,
    second    REAL,
    faces     INTEGER NOT NULL,
    PRIMARY KEY (item_id, start)
);
CREATE TABLE IF NOT EXISTS asd_runs (
    item_id    TEXT PRIMARY KEY,
    etag       TEXT NOT NULL,
    voice_model TEXT,
    version    INTEGER NOT NULL,
    status     TEXT NOT NULL,          -- partial | done
    state_json TEXT,
    stats_json TEXT,
    updated    REAL NOT NULL
);
-- Le rapport de décision d'un élément (report.py) : ce qui a été fait, avec quoi, et pourquoi chaque voix
-- est nommée ou non. Refait à chaque fin d'analyse, de lecture des lèvres ou de renommage.
CREATE TABLE IF NOT EXISTS reports (
    item_id     TEXT PRIMARY KEY,
    etag        TEXT NOT NULL,
    report_json TEXT NOT NULL,
    updated     REAL NOT NULL
);
-- « Synchro des sous-titres » (subsyncjob.py, 11/2026) : ses ordres, à part de ceux de l'analyse ; le résultat
-- par élément (une mesure par piste, `tracks_json`) avec la version de l'algorithme ; la parole écoutée par la
-- passe « parole seule », gardée pour ne pas réécouter un fichier inchangé.
CREATE TABLE IF NOT EXISTS subsync_jobs (
    item_id           TEXT PRIMARY KEY,
    etag              TEXT NOT NULL,
    path              TEXT NOT NULL,
    externals_json    TEXT NOT NULL,
    ext_sig           TEXT,
    original_language TEXT,
    priority          INTEGER NOT NULL,
    status            TEXT NOT NULL,          -- queued | running | done | failed
    error             TEXT,
    seq               INTEGER NOT NULL,
    attempts          INTEGER NOT NULL DEFAULT 0,
    created           REAL NOT NULL,
    updated           REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS subsync_results (
    item_id       TEXT PRIMARY KEY,
    etag          TEXT NOT NULL,
    version       INTEGER NOT NULL,
    speech_source TEXT NOT NULL,              -- voix | parole-seule
    tracks_json   TEXT NOT NULL,
    stats_json    TEXT,
    ext_sig       TEXT,
    updated       REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS subsync_speech (
    item_id      TEXT PRIMARY KEY,
    etag         TEXT NOT NULL,
    source       TEXT NOT NULL,
    regions_json TEXT NOT NULL,
    valid_json   TEXT NOT NULL,
    track_json   TEXT,
    updated      REAL NOT NULL
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


log = logging.getLogger("xray.db")

# Taille des pages de la base (10/11/2026). Une empreinte de visage fait 2 Kio (512 float32) : avec les
# 4 Kio par défaut, une seule ligne de `tracks` tient par page et la moitié de chaque page restait vide —
# 60 Mo pour 10 h analysées. À 16 Kio, sept lignes par page : 44 Mo, sans rien changer à ce qui est
# gardé (mesuré sur la base de production : 8 Kio → 47 Mo, 32 Kio → 43 Mo).
PAGE_SIZE = 16384


class Database:
    def __init__(self, path: Path | str):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self._page_size()
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
            self._conn.executescript(SCHEMA)
            self._migrate()

    def _page_size(self) -> None:
        """`PAGE_SIZE` pour une base neuve ; une base existante aux pages plus petites est réécrite une
        fois (VACUUM, hors WAL : la taille des pages ne change pas en WAL). Il faut alors autant de place
        libre que la base en occupe, et le temps de la réécrire (quelques secondes par Go)."""
        current = self._conn.execute("PRAGMA page_size").fetchone()[0]
        if current >= PAGE_SIZE:
            return
        has_tables = self._conn.execute("SELECT count(*) FROM sqlite_master").fetchone()[0] > 0
        if not has_tables:
            self._conn.execute(f"PRAGMA page_size={PAGE_SIZE}")
            return
        from .logs import event
        started = time.monotonic()
        self._conn.execute("PRAGMA journal_mode=DELETE")
        self._conn.execute(f"PRAGMA page_size={PAGE_SIZE}")
        self._conn.execute("VACUUM")
        event(log, "base réécrite en pages de %d octets (%d avant)", PAGE_SIZE, current,
              action="db_page_size", before=current, after=PAGE_SIZE,
              seconds=round(time.monotonic() - started, 2))

    def _migrate(self) -> None:
        """Colonnes ajoutées après coup. Une base d'avant la version 2 des résultats n'a pas de
        colonne `version` : ses lignes valent 1 — ce qui les a produites."""
        for table in ("items", "results"):
            cols = {r[1] for r in self._conn.execute(f"PRAGMA table_info({table})")}
            if "version" not in cols:
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN version INTEGER NOT NULL DEFAULT 1")
        # Chronomètres (11/2026) : par tronçon, et ce qui revient à l'ordre entier.
        # Plages sautées (11/2026) : données par l'ordre, ou lues chez Jellyfin ; NULL = à demander.
        # « Qui parle » (11/2026) : le son de chaque tronçon fait ou non (`voice`), la langue d'origine
        # donnée par l'ordre, la piste et le modèle de voix retenus, la dernière tentative en échec.
        for table, col in (("chunks", "stats"), ("items", "stats_json"), ("items", "skip_json"),
                           ("chunks", "voice"), ("items", "original_language"), ("items", "voice_track_json"),
                           ("items", "voice_model"), ("items", "voice_error"), ("items", "voice_tried"),
                           ("results", "stats_json"), ("items", "relabeled"),
                           # Rapport de décision (11/2026, report.py) : les faits de l'analyse (versions,
                           # précision du détecteur, plages sautées et leur source), le détail des groupes
                           # de visages et des voix.
                           ("items", "run_json"), ("results", "diag_json"), ("voice_results", "diag_json")):
            cols = {r[1] for r in self._conn.execute(f"PRAGMA table_info({table})")}
            if col not in cols:
                kind = "INTEGER NOT NULL DEFAULT 0" if col == "voice" else ("REAL" if col in ("voice_tried", "relabeled") else "TEXT")
                self._conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {kind}")
        from .memory import migrate_legacy

        migrate_legacy(self._conn)

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
