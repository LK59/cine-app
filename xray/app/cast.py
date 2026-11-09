"""Photos de référence de la distribution, et mémoire des visages d'une série.

Les photos viennent de TMDB (image.tmdb.org, et rien d'autre — l'adresse est revérifiée
ici, et les redirections ne sont pas suivies). Chaque photo est gardée sur disque et son
empreinte en base, par modèle : un acteur récurrent n'est téléchargé et analysé qu'une fois.
Une photo sans visage exploitable est notée comme telle, pour ne pas la reprendre à chaque épisode.
"""

from __future__ import annotations

import hashlib
import logging
import time
from pathlib import Path

import cv2
import httpx
import numpy as np

from .cluster import PersonRefs
from .db import Database
from .faces import normalize
from .jobs import CastMember, check_photo_url

log = logging.getLogger("xray.cast")
MAX_PHOTO_BYTES = 5 * 1024 * 1024


def _fetch(client: httpx.Client, url: str, dest: Path) -> bytes | None:
    if dest.exists():
        return dest.read_bytes()
    check_photo_url(url)
    try:
        with client.stream("GET", url) as r:
            if r.status_code != 200 or not r.headers.get("content-type", "").startswith("image/"):
                return None
            data = bytearray()
            for chunk in r.iter_bytes(65536):
                data += chunk
                if len(data) > MAX_PHOTO_BYTES:
                    return None
    except httpx.HTTPError as e:
        log.warning("photo %s : %s", url, e)
        raise
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".part")
    tmp.write_bytes(bytes(data))
    tmp.replace(dest)
    return bytes(data)


def photo_embeddings(db: Database, engine, model: str, cast: list[CastMember], photos_dir: Path) -> dict[int, np.ndarray]:
    """{personId: (m, d)} — m peut être 0 (aucune photo exploitable)."""
    out: dict[int, np.ndarray] = {}
    with httpx.Client(follow_redirects=False, timeout=15.0, headers={"User-Agent": "laterna-xray"}) as client:
        for member in cast:
            embs = []
            for url in member.photos:
                row = db.one("SELECT emb FROM photo_emb WHERE model=? AND url=?", (model, url))
                if row is not None:
                    if row["emb"] is not None:
                        embs.append(np.frombuffer(row["emb"], dtype=np.float32))
                    continue
                dest = photos_dir / (hashlib.sha256(url.encode()).hexdigest()[:32] + ".img")
                try:
                    data = _fetch(client, url, dest)
                except httpx.HTTPError:
                    continue  # réseau : on réessaiera au prochain ordre, rien n'est noté
                emb = None
                if data:
                    img = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
                    if img is not None:
                        emb = engine.best_face_embedding(img)
                db.run(
                    "INSERT OR REPLACE INTO photo_emb (model, url, emb, fetched) VALUES (?, ?, ?, ?)",
                    (model, url, emb.astype(np.float32).tobytes() if emb is not None else None, time.time()),
                )
                if emb is not None:
                    embs.append(emb.astype(np.float32))
            out[member.person_id] = np.stack(embs) if embs else np.zeros((0, 512), dtype=np.float32)
    return out


def cached_photo_embeddings(db: Database, model: str, cast: list[CastMember]) -> dict[int, np.ndarray]:
    """Les mêmes, sans réseau ni modèle : ce qui est déjà en base (pour les recalculs)."""
    out: dict[int, np.ndarray] = {}
    for member in cast:
        embs = []
        for url in member.photos:
            row = db.one("SELECT emb FROM photo_emb WHERE model=? AND url=?", (model, url))
            if row is not None and row["emb"] is not None:
                embs.append(np.frombuffer(row["emb"], dtype=np.float32))
        out[member.person_id] = np.stack(embs) if embs else np.zeros((0, 512), dtype=np.float32)
    return out


def series_embeddings(db: Database, series_id: str | None, model: str) -> dict[int, np.ndarray]:
    """La mémoire des visages de la série : la moyenne pondérée des contributions de ses épisodes (memory.py)."""
    from . import memory

    return memory.recall(db, series_id, "face", model)


def build_refs(cast: list[CastMember], photos: dict[int, np.ndarray], series: dict[int, np.ndarray]) -> list[PersonRefs]:
    refs = []
    for m in cast:
        ph = photos.get(m.person_id)
        se = series.get(m.person_id)
        if (ph is None or len(ph) == 0) and se is None:
            continue  # ni photo ni mémoire : impossible à reconnaître
        refs.append(PersonRefs(m.person_id, ph if ph is not None else np.zeros((0, 512), np.float32), se))
    return refs


# Ce que la série retient d'un épisode : seulement des groupes que les *photos* nomment avec
# assurance — une mémoire nourrie de ses propres conclusions finirait par confirmer ses erreurs. Depuis le
# 10/11/2026 (garde de la mémoire) : marge de 0,10 au-dessus du seuil de nom (0,08 avant), cinq secondes
# de présence au moins, et une contribution par épisode, bornée (memory.py).
SERIES_MIN_PHOTO_MARGIN = 0.10
SERIES_MIN_TIME = 5.0


def update_series(db: Database, series_id: str | None, model: str, built, label_threshold: float, item_id: str = "") -> int:
    """Dépose la contribution de cet épisode à la mémoire des visages (remplace la précédente)."""
    from . import memory

    if not series_id or built.centroids is None:
        return 0
    per_person: dict[int, tuple[np.ndarray, float, float]] = {}
    for ci, asg in built.assignments.items():
        if asg.photo_score < label_threshold + SERIES_MIN_PHOTO_MARGIN:
            continue
        w = float(built.cluster_time[ci])
        if w <= 0:
            continue
        acc, tw, best = per_person.get(asg.person_id, (np.zeros_like(built.centroids[ci]), 0.0, 0.0))
        per_person[asg.person_id] = (acc + built.centroids[ci] * w, tw + w, max(best, float(asg.photo_score)))
    entries = {pid: (normalize(acc), tw, sc) for pid, (acc, tw, sc) in per_person.items() if tw >= SERIES_MIN_TIME}
    return memory.contribute(db, series_id, "face", model, item_id or "?", entries)
