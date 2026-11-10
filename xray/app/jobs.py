"""Ordres d'analyse : validation, file d'attente, états.

La file est une table SQLite (`items`) : elle survit aux redémarrages, et l'ordre de passage
se lit d'une requête — priorité d'abord (quelqu'un regarde maintenant), arrivée ensuite.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from .config import RESULT_VERSION
from .db import Database
from .logs import event

log = logging.getLogger("xray.jobs")

PRIORITIES = {"high": 0, "normal": 1, "low": 2}
HEX32 = re.compile(r"^[0-9a-fA-F]{32}$")
VIDEO_EXT = {
    ".mkv", ".mp4", ".m4v", ".avi", ".mov", ".ts", ".m2ts", ".mts", ".webm", ".wmv",
    ".mpg", ".mpeg", ".vob", ".flv", ".ogv", ".3gp",
}
MAX_CAST = 300
MAX_PHOTOS = 12
MAX_SKIP = 32
REBIND_TOLERANCE = 1.0  # secondes


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
    # Plages à ne pas analyser ; None = non précisé (le service demande alors à Jellyfin).
    skip: list[tuple[float, float]] | None = None
    # Fichier remplacé (autre etag) de même durée : reprendre le résultat complet au lieu de tout
    # refaire (`rebindIfSameDuration` + `durationS`).
    rebind_duration: float | None = None
    # Langue d'origine du titre (ISO 639-1 de TMDB, « en ») : la piste son de « qui parle » (audio.py).
    original_language: str | None = None


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
    skip = check_skip(body.get("skip"))
    rebind = body.get("rebindIfSameDuration", False)
    if not isinstance(rebind, bool):
        raise InvalidJob("rebindIfSameDuration : booléen attendu")
    rebind_duration = None
    if rebind:
        d = body.get("durationS")
        if isinstance(d, bool) or not isinstance(d, (int, float)) or not math.isfinite(d) or d <= 0:
            raise InvalidJob("durationS : nombre positif attendu avec rebindIfSameDuration")
        rebind_duration = float(d)
    lang = body.get("originalLanguage")
    if lang is not None and (not isinstance(lang, str) or not re.fullmatch(r"[A-Za-z]{2,3}(-[A-Za-z]{2})?", lang.strip())):
        raise InvalidJob("originalLanguage : code de langue (ISO 639) ou null")
    path = check_media_path(body.get("path"), media_root)
    return JobSpec(
        item_id=item_id.lower(),
        path=path,
        etag=etag,
        priority=PRIORITIES[priority],
        start_at=float(start_at),
        series_id=series_id.lower() if series_id else None,
        cast=cast,
        skip=skip,
        rebind_duration=rebind_duration,
        original_language=lang.strip().lower() if isinstance(lang, str) else None,
    )


def check_skip(raw: object) -> list[tuple[float, float]] | None:
    """`skip` : facultatif, liste de `{start, end}` en secondes (génériques, rappel…)."""
    if raw is None:
        return None
    if not isinstance(raw, list) or len(raw) > MAX_SKIP:
        raise InvalidJob(f"skip : liste de {MAX_SKIP} plages au plus")
    out = []
    for r in raw:
        if not isinstance(r, dict):
            raise InvalidJob("skip : objets {start, end} attendus")
        s, e = r.get("start"), r.get("end")
        for v in (s, e):
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v < 0:
                raise InvalidJob("skip : start et end, nombres positifs")
        if e <= s:
            raise InvalidJob("skip : end doit dépasser start")
        out.append((float(s), float(e)))
    return out


class JobStore:
    """La file et ses états. L'ouvrier en tire un ordre à la fois ; l'API y dépose et lit."""

    def __init__(self, db: Database):
        self.db = db
        self._wake = threading.Event()
        # Par voie d'analyse (`lanes.py`) : l'élément qu'elle traite (analyse, ou travail d'appoint de la
        # voie A : voix seules, lèvres) et son drapeau d'annulation (DELETE, ou fichier remplacé).
        self.lanes: dict[str, str | None] = {}
        self._cancels: dict[str, threading.Event] = {}
        # Voies qui *analysent* un élément pris par `claim` (pas le travail d'appoint).
        self.analysing: dict[str, str] = {}
        self._claim = threading.Lock()
        # Au démarrage, un ordre resté « running » a été interrompu : il repart en file,
        # ses tronçons faits restent faits.
        db.run("UPDATE items SET status='queued' WHERE status='running'")

    # --- voies ------------------------------------------------------------------------------

    def cancel_event(self, lane: str = "A") -> threading.Event:
        ev = self._cancels.get(lane)
        if ev is None:
            ev = self._cancels.setdefault(lane, threading.Event())
        return ev

    @property
    def cancel(self) -> threading.Event:
        """Le drapeau de la voie A (l'ouvrier d'avant les voies)."""
        return self.cancel_event("A")

    @property
    def running_id(self) -> str | None:
        return self.lanes.get("A")

    @running_id.setter
    def running_id(self, value: str | None) -> None:
        self.lanes["A"] = value

    def running_ids(self) -> dict[str, str]:
        return {lane: iid for lane, iid in self.lanes.items() if iid}

    def _cancel_item(self, item_id: str) -> None:
        for lane, iid in list(self.lanes.items()):
            if iid == item_id:
                self.cancel_event(lane).set()

    def claim(self, lane: str, cpu_lane: bool = False, accept=None):
        """L'ordre suivant pour cette voie, marqué pris d'un bloc (jamais deux voies sur un élément).
        La voie A : la tête de la file, comme l'unique ouvrier d'avant. La voie B (`cpu_lane`) : seulement
        pendant que la voie A analyse un élément — il y a alors un second ordre —, le premier ordre
        `normal` ou `low` dans l'ordre de la file ; jamais un `high`, qui revient à la voie A. `accept(row)` :
        ce que la voie sait faire (la voie B : pas de 4K, `Worker._cpu_suits`) ; un ordre refusé reste en file,
        à sa place, pour la voie A."""
        with self._claim:
            taken = {iid for ln, iid in self.lanes.items() if ln != lane and iid}
            if cpu_lane and not any(ln != lane for ln in self.analysing):
                return None
            rows = self.db.q("SELECT * FROM items WHERE status='queued' ORDER BY priority, seq LIMIT ?",
                             (len(taken) + 8,))
            for r in rows:
                if r["item_id"] in taken:
                    continue
                if cpu_lane and r["priority"] < PRIORITIES["normal"]:
                    continue
                if accept is not None and not accept(r):
                    continue
                self.lanes[lane] = r["item_id"]
                self.analysing[lane] = r["item_id"]
                return r
            return None

    def release(self, lane: str) -> None:
        with self._claim:
            self.lanes[lane] = None
            self.analysing.pop(lane, None)
            self.cancel_event(lane).clear()
        self._wake.set()

    # --- dépôt -----------------------------------------------------------------------------

    def submit(self, spec: JobSpec) -> tuple[int, dict]:
        now = time.time()
        with self.db.tx() as c:
            row = c.execute("SELECT * FROM items WHERE item_id=?", (spec.item_id,)).fetchone()
            if row is not None and row["etag"] != spec.etag and self._rebind(c, row, spec):
                return 200, {"itemId": spec.item_id, "status": "done", "position": 0}
            if row is not None and row["etag"] == spec.etag and row["status"] == "done":
                # Fait au même fichier : rien n'est relancé. La langue d'origine, si elle arrive seulement
                # maintenant (un ordre d'avant « qui parle »), est retenue pour la lecture du son seul.
                if spec.original_language and not row["original_language"]:
                    c.execute("UPDATE items SET original_language=? WHERE item_id=?", (spec.original_language, spec.item_id))
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
                    self._cancel_item(spec.item_id)
                elif row is not None:
                    # Même fichier, ordre en échec : on réessaie en gardant les tronçons faits.
                    pass
                seq = c.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM items").fetchone()[0]
                cast_json = json.dumps([m.as_dict() for m in spec.cast], ensure_ascii=False)
                skip_json = None if spec.skip is None else json.dumps([[a, b] for a, b in spec.skip])
                c.execute(
                    """INSERT INTO items (item_id, etag, path, priority, start_at, series_id, cast_json, skip_json,
                                          original_language, status, error, seq, version, created, updated)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, ?, ?)
                       ON CONFLICT(item_id) DO UPDATE SET
                         etag=excluded.etag, path=excluded.path, priority=excluded.priority,
                         start_at=excluded.start_at, series_id=excluded.series_id,
                         cast_json=excluded.cast_json, skip_json=excluded.skip_json,
                         original_language=excluded.original_language, status='queued', error=NULL,
                         seq=excluded.seq, version=excluded.version, updated=excluded.updated""",
                    (spec.item_id, spec.etag, spec.path, spec.priority, spec.start_at, spec.series_id,
                     cast_json, skip_json, spec.original_language, seq,
                     RESULT_VERSION if row is None or row["etag"] != spec.etag else row["version"], now, now),
                )
                status = "queued"
        self._wake.set()
        return 202, {"itemId": spec.item_id, "status": status, "position": self.position(spec.item_id)}

    def _rebind(self, c, row, spec: JobSpec) -> bool:
        """Même élément, fichier remplacé (réencodage, autre conteneur) mais de même durée, à une
        seconde près : le résultat complet reste valable, il passe au nouvel etag sans rien
        analyser. La durée comparée est celle que ffprobe a lue sur l'ancien fichier (`items.duration`) ;
        à défaut, la fin de la plage analysée d'un résultat complet, qui vaut cette même durée.
        Sans l'une ni l'autre, pas de reprise : l'ancien fichier n'est plus là pour être mesuré."""
        if spec.rebind_duration is None or row["status"] != "done":
            return False
        res = c.execute("SELECT complete, analyzed_until FROM results WHERE item_id=?", (spec.item_id,)).fetchone()
        if res is None or not res["complete"]:
            return False
        known = row["duration"] if row["duration"] else (res["analyzed_until"] or None)
        if not known or abs(float(known) - spec.rebind_duration) > REBIND_TOLERANCE:
            event(log, "[xray] %s : fichier remplacé, durée différente (%.1f s au lieu de %.1f s) : analyse refaite",
                  spec.item_id, float(known or 0.0), spec.rebind_duration, item=spec.item_id, action="rebind_refused",
                  knownDuration=known, durationS=spec.rebind_duration, oldEtag=row["etag"], etag=spec.etag)
            return False
        now = time.time()
        # Les chapitres sont relus sur le nouveau fichier (scenecuts.backfill_some) : un réencodage peut les perdre.
        c.execute("UPDATE items SET etag=?, path=?, updated=?, chapters_json=NULL WHERE item_id=?",
                  (spec.etag, spec.path, now, spec.item_id))
        c.execute("UPDATE results SET etag=?, updated=? WHERE item_id=?", (spec.etag, now, spec.item_id))
        # Les voix suivent : mêmes temps, même durée.
        c.execute("UPDATE voice_results SET etag=?, updated=? WHERE item_id=?", (spec.etag, now, spec.item_id))
        c.execute("UPDATE asd_runs SET etag=?, updated=? WHERE item_id=?", (spec.etag, now, spec.item_id))
        # Le rapport est refait à la demande, sous le nouvel etag (rien de ce qu'il dit ne change).
        c.execute("DELETE FROM reports WHERE item_id=?", (spec.item_id,))
        event(log, "[xray] %s : fichier remplacé de même durée, résultat repris sans analyse", spec.item_id,
              item=spec.item_id, action="rebind", oldEtag=row["etag"], etag=spec.etag, path=spec.path,
              durationS=spec.rebind_duration, knownDuration=float(known))
        return True

    def _forget(self, c, item_id: str) -> None:
        for table in ("chunks", "shots", "tracks", "results", "voice_regions", "voice_windows", "voice_results",
                      "asd_votes", "asd_runs", "reports"):
            c.execute(f"DELETE FROM {table} WHERE item_id=?", (item_id,))
        c.execute("UPDATE items SET stats_json=NULL, voice_track_json=NULL, voice_model=NULL, voice_error=NULL, "
                  "voice_tried=NULL, run_json=NULL, chapters_json=NULL WHERE item_id=?", (item_id,))

    def delete(self, item_id: str) -> None:
        item_id = item_id.lower()
        with self.db.tx() as c:
            self._forget(c, item_id)
            c.execute("DELETE FROM items WHERE item_id=?", (item_id,))
        self._cancel_item(item_id)

    # --- lecture ---------------------------------------------------------------------------

    def get(self, item_id: str):
        return self.db.one("SELECT * FROM items WHERE item_id=?", (item_id.lower(),))

    def position(self, item_id: str) -> int:
        """Rang dans la file : 0 pour l'ordre en cours — ou qui commence tout de suite, la file
        étant vide —, 1 pour le prochain, etc. Un premier ordre sur une file vide rendait 1 :
        l'ouvrier ne l'avait simplement pas encore pris."""
        row = self.get(item_id)
        if row is None or row["status"] != "queued":
            return 0
        ahead = self.db.one(
            "SELECT COUNT(*) FROM items WHERE status='queued' AND (priority < ? OR (priority = ? AND seq < ?))",
            (row["priority"], row["priority"], row["seq"]),
        )[0]
        busy = any(iid != row["item_id"] for iid in self.running_ids().values())
        return int(ahead) + (1 if busy else 0)

    def pending_count(self) -> int:
        return int(self.db.one("SELECT COUNT(*) FROM items WHERE status='queued'")[0])

    # --- côté ouvrier ----------------------------------------------------------------------

    def next_job(self):
        return self.db.one("SELECT * FROM items WHERE status='queued' ORDER BY priority, seq LIMIT 1")

    def should_yield(self, item_id: str, cpu_lane: bool = False) -> bool:
        """Un ordre plus pressé attend : l'ouvrier rend la main entre deux tronçons, sans rien perdre.
        La voie B ne cède qu'à un ordre qu'elle prendrait (`normal` devant un `low`), et rend un élément
        passé `high` pendant son analyse (la voie A le prendra)."""
        row = self.get(item_id)
        if row is None:
            return True
        if cpu_lane:
            if row["priority"] < PRIORITIES["normal"]:
                return True
            better = self.db.one(
                "SELECT 1 FROM items WHERE status='queued' AND priority < ? AND priority >= ? LIMIT 1",
                (row["priority"], PRIORITIES["normal"]))
            return better is not None
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
