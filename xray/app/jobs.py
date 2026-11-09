"""Ordres d'analyse : validation, file d'attente, états.

La file est une table SQLite (`items`) : elle survit aux redémarrages, et l'ordre de passage
se lit d'une requête — priorité d'abord (quelqu'un regarde maintenant), arrivée ensuite.
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from .db import Database

PRIORITIES = {"high": 0, "normal": 1, "low": 2}
HEX32 = re.compile(r"^[0-9a-fA-F]{32}$")
VIDEO_EXT = {
    ".mkv", ".mp4", ".m4v", ".avi", ".mov", ".ts", ".m2ts", ".mts", ".webm", ".wmv",
    ".mpg", ".mpeg", ".vob", ".flv", ".ogv", ".3gp",
}
MAX_CAST = 300
MAX_PHOTOS = 12


class InvalidJob(ValueError):
    """Ordre refusé : le message dit quel champ, il part tel quel dans la réponse 400."""


@dataclass
class CastMember:
    person_id: int
    name: str
    character: str
    order: int
    photos: list[str]

    def as_dict(self) -> dict:
        return {"personId": self.person_id, "name": self.name, "character": self.character,
                "order": self.order, "photos": self.photos}


@dataclass
class JobSpec:
    item_id: str
    path: str
    etag: str
    priority: int
    start_at: float
    series_id: str | None
    cast: list[CastMember] = field(default_factory=list)


def check_photo_url(url: object) -> str:
    """Seules les images de TMDB sont téléchargées : le service ne doit pas devenir un relais
    capable d'aller chercher n'importe quelle adresse (réseau interne compris) pour qui tient la clé.
    On décompose l'adresse plutôt que de comparer un préfixe : `https://image.tmdb.org.evil/`,
    `https://image.tmdb.org@evil/` ou un port explicite ne passent pas."""
    if not isinstance(url, str) or len(url) > 500:
        raise InvalidJob("cast.photos : URL invalide")
    parts = urlsplit(url)
    if (
        parts.scheme != "https"
        or parts.hostname != "image.tmdb.org"
        or parts.netloc != "image.tmdb.org"
        or not parts.path.startswith("/")
        or not url.startswith("https://image.tmdb.org/")
        or any(c in url for c in "\\\r\n\t ")
    ):
        raise InvalidJob("cast.photos : seules les URL https://image.tmdb.org/ sont acceptées")
    return url


def check_media_path(raw: object, media_root: Path) -> str:
    """Le chemin doit désigner un fichier vidéo existant *dans* la médiathèque montée.
    `realpath` résout les `..` et les liens symboliques avant la comparaison : un lien posé
    dans la médiathèque et pointant hors d'elle est refusé comme un `../../etc/passwd`."""
    if not isinstance(raw, str) or not raw or len(raw) > 4096 or "\x00" in raw:
        raise InvalidJob("path : chemin invalide")
    if not raw.startswith("/"):
        raise InvalidJob("path : chemin absolu attendu")
    root = os.path.realpath(str(media_root))
    real = os.path.realpath(raw)
    if real != root and not real.startswith(root.rstrip("/") + "/"):
        raise InvalidJob("path : hors de la médiathèque montée")
    if Path(real).suffix.lower() not in VIDEO_EXT:
        raise InvalidJob("path : pas un fichier vidéo")
    if not os.path.isfile(real):
        raise InvalidJob("path : fichier introuvable dans la médiathèque montée")
    return real


def validate_job(body: object, media_root: Path) -> JobSpec:
    if not isinstance(body, dict):
        raise InvalidJob("corps JSON attendu")
    item_id = body.get("itemId")
    if not isinstance(item_id, str) or not HEX32.match(item_id):
        raise InvalidJob("itemId : 32 caractères hexadécimaux attendus")
    etag = body.get("etag")
    if not isinstance(etag, str) or not etag.strip() or len(etag) > 256:
        raise InvalidJob("etag : chaîne non vide attendue")
    priority = body.get("priority", "normal")
    if priority not in PRIORITIES:
        raise InvalidJob("priority : high, normal ou low")
    start_at = body.get("startAt", 0)
    if start_at is None:
        start_at = 0
    if isinstance(start_at, bool) or not isinstance(start_at, (int, float)) or not math.isfinite(start_at) or start_at < 0:
        raise InvalidJob("startAt : nombre positif attendu")
    series_id = body.get("seriesId")
    if series_id is not None and (not isinstance(series_id, str) or not HEX32.match(series_id)):
        raise InvalidJob("seriesId : 32 caractères hexadécimaux ou null")
    cast_raw = body.get("cast", [])
    if not isinstance(cast_raw, list) or len(cast_raw) > MAX_CAST:
        raise InvalidJob("cast : liste attendue")
    cast: list[CastMember] = []
    seen: set[int] = set()
    for i, c in enumerate(cast_raw):
        if not isinstance(c, dict):
            raise InvalidJob("cast : objets attendus")
        pid = c.get("personId")
        if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
            raise InvalidJob("cast.personId : entier positif attendu")
        name = c.get("name") or ""
        character = c.get("character") or ""
        if not isinstance(name, str) or not isinstance(character, str) or len(name) > 300 or len(character) > 300:
            raise InvalidJob("cast.name / cast.character : chaînes attendues")
        order = c.get("order", i)
        if isinstance(order, bool) or not isinstance(order, int):
            raise InvalidJob("cast.order : entier attendu")
        photos = c.get("photos", [])
        if not isinstance(photos, list) or len(photos) > MAX_PHOTOS:
            raise InvalidJob(f"cast.photos : liste de {MAX_PHOTOS} URL au plus")
        photos = [check_photo_url(u) for u in photos]
        if pid in seen:
            # Un même acteur listé deux fois (deux rôles) : on fusionne ses photos.
            prev = next(m for m in cast if m.person_id == pid)
            prev.photos = list(dict.fromkeys(prev.photos + photos))[:MAX_PHOTOS]
            continue
        seen.add(pid)
        cast.append(CastMember(pid, name, character, order, list(dict.fromkeys(photos))))
    path = check_media_path(body.get("path"), media_root)
    return JobSpec(
        item_id=item_id.lower(),
        path=path,
        etag=etag,
        priority=PRIORITIES[priority],
        start_at=float(start_at),
        series_id=series_id.lower() if series_id else None,
        cast=cast,
    )


class JobStore:
    """La file et ses états. L'ouvrier en tire un ordre à la fois ; l'API y dépose et lit."""

    def __init__(self, db: Database):
        self.db = db
        self._wake = threading.Event()
        # Ordre que l'ouvrier traite et drapeau d'annulation (DELETE, ou fichier remplacé).
        self.running_id: str | None = None
        self.cancel = threading.Event()
        # Au démarrage, un ordre resté « running » a été interrompu : il repart en file,
        # ses tronçons faits restent faits.
        db.run("UPDATE items SET status='queued' WHERE status='running'")

    # --- dépôt -----------------------------------------------------------------------------

    def submit(self, spec: JobSpec) -> tuple[int, dict]:
        now = time.time()
        with self.db.tx() as c:
            row = c.execute("SELECT * FROM items WHERE item_id=?", (spec.item_id,)).fetchone()
            if row is not None and row["etag"] == spec.etag and row["status"] == "done":
                return 200, {"itemId": spec.item_id, "status": "done", "position": 0}
            if row is not None and row["etag"] == spec.etag and row["status"] in ("queued", "running"):
                # Un ordre en double ne relance rien : il peut seulement remonter la priorité.
                if spec.priority < row["priority"]:
                    c.execute("UPDATE items SET priority=?, updated=? WHERE item_id=?",
                              (spec.priority, now, spec.item_id))
                status = row["status"]
            else:
                if row is not None and row["etag"] != spec.etag:
                    # Le fichier a changé : tout ce qui avait été mesuré sur l'ancien est faux.
                    self._forget(c, spec.item_id)
                    if self.running_id == spec.item_id:
                        self.cancel.set()
                elif row is not None:
                    # Même fichier, ordre en échec : on réessaie en gardant les tronçons faits.
                    pass
                seq = c.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM items").fetchone()[0]
                cast_json = json.dumps([m.as_dict() for m in spec.cast], ensure_ascii=False)
                c.execute(
                    """INSERT INTO items (item_id, etag, path, priority, start_at, series_id, cast_json,
                                          status, error, seq, created, updated)
                       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, ?)
                       ON CONFLICT(item_id) DO UPDATE SET
                         etag=excluded.etag, path=excluded.path, priority=excluded.priority,
                         start_at=excluded.start_at, series_id=excluded.series_id,
                         cast_json=excluded.cast_json, status='queued', error=NULL,
                         seq=excluded.seq, updated=excluded.updated""",
                    (spec.item_id, spec.etag, spec.path, spec.priority, spec.start_at, spec.series_id,
                     cast_json, seq, now, now),
                )
                status = "queued"
        self._wake.set()
        return 202, {"itemId": spec.item_id, "status": status, "position": self.position(spec.item_id)}

    def _forget(self, c, item_id: str) -> None:
        for table in ("chunks", "shots", "tracks", "results"):
            c.execute(f"DELETE FROM {table} WHERE item_id=?", (item_id,))

    def delete(self, item_id: str) -> None:
        item_id = item_id.lower()
        with self.db.tx() as c:
            self._forget(c, item_id)
            c.execute("DELETE FROM items WHERE item_id=?", (item_id,))
        if self.running_id == item_id:
            self.cancel.set()

    # --- lecture ---------------------------------------------------------------------------

    def get(self, item_id: str):
        return self.db.one("SELECT * FROM items WHERE item_id=?", (item_id.lower(),))

    def position(self, item_id: str) -> int:
        row = self.get(item_id)
        if row is None or row["status"] != "queued":
            return 0
        ahead = self.db.one(
            "SELECT COUNT(*) FROM items WHERE status='queued' AND (priority < ? OR (priority = ? AND seq < ?))",
            (row["priority"], row["priority"], row["seq"]),
        )[0]
        return int(ahead) + 1

    def pending_count(self) -> int:
        return int(self.db.one("SELECT COUNT(*) FROM items WHERE status='queued'")[0])

    # --- côté ouvrier ----------------------------------------------------------------------

    def next_job(self):
        return self.db.one("SELECT * FROM items WHERE status='queued' ORDER BY priority, seq LIMIT 1")

    def should_yield(self, item_id: str) -> bool:
        """Un ordre plus pressé attend : l'ouvrier rend la main entre deux tronçons, sans rien perdre."""
        row = self.get(item_id)
        if row is None:
            return True
        better = self.db.one(
            "SELECT 1 FROM items WHERE status='queued' AND priority < ? LIMIT 1", (row["priority"],)
        )
        return better is not None

    def set_status(self, item_id: str, status: str, error: str | None = None, **extra) -> None:
        sets = ["status=?", "error=?", "updated=?"]
        args: list = [status, error, time.time()]
        for k, v in extra.items():
            sets.append(f"{k}=?")
            args.append(v)
        args.append(item_id)
        self.db.run(f"UPDATE items SET {', '.join(sets)} WHERE item_id=?", tuple(args))

    def wait_for_work(self, timeout: float) -> None:
        self._wake.wait(timeout)
        self._wake.clear()

    def wake(self) -> None:
        self._wake.set()
