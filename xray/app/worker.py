"""L'ouvrier : un seul ordre à la fois, tronçon par tronçon.

Un ordre est découpé en tronçons de deux minutes. Chaque tronçon est décodé, découpé en plans,
analysé, puis écrit d'un bloc en base, et le résultat de tout l'ordre est recalculé : un
spectateur voit les scènes arriver au fil de l'analyse, et un redémarrage ne reprend que le
tronçon en cours.

Ordre de passage des tronçons : celui qui contient `startAt` d'abord, puis la suite jusqu'à
la fin, puis le début — ce qu'on va regarder est prêt en premier.

Entre deux tronçons, l'ouvrier rend la main si un ordre plus pressé attend (il reprendra
celui-ci plus tard, sans rien perdre), et s'arrête si l'ordre a été supprimé.
"""

from __future__ import annotations

import json
import logging
import math
import queue
import threading
import time

import cv2
import numpy as np

from . import cast as castmod
from . import decode
from .config import RESULT_VERSION, settings
from .db import Database
from .faces import MODEL_DEFAULTS
from .jobs import CastMember, JobStore
from .models import ModelManager
from .results import ShotRow, TrackRow, build
from .shots import ShotSplitter, frames_to_sample, pick_indices
from .tracks import link, summarize

log = logging.getLogger("xray.worker")


class Cancelled(Exception):
    pass


class DecodeFailed(Exception):
    pass


def thresholds(model: str) -> tuple[float, float]:
    d = MODEL_DEFAULTS.get(model, MODEL_DEFAULTS["buffalo_l"])
    c = settings.cluster_threshold if settings.cluster_threshold is not None else d["cluster"]
    lab = settings.label_threshold if settings.label_threshold is not None else d["label"]
    return c, lab


def chunk_order(chunks: list[tuple[int, float, float]], start_at: float) -> list[tuple[int, float, float]]:
    first = [c for c in chunks if c[2] > start_at]
    first_idx = first[0][0] if first else 0
    return [c for c in chunks if c[0] >= first_idx] + [c for c in chunks if c[0] < first_idx]


def _prefetch(gen, depth: int = 48):
    """Le décodage (ffmpeg) avance pendant que l'inférence travaille : sans cette file, le tuyau
    de ffmpeg se remplit et il attend que Python lise."""
    q: queue.Queue = queue.Queue(maxsize=depth)
    END = object()
    err: list[BaseException] = []

    def run() -> None:
        try:
            for item in gen:
                q.put(item)
        except BaseException as e:  # remonté dans le fil de l'ouvrier
            err.append(e)
        finally:
            q.put(END)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    while True:
        item = q.get()
        if item is END:
            break
        yield item
    t.join()
    if err:
        raise err[0]


class Worker:
    def __init__(self, db: Database, store: JobStore, models: ModelManager, guard):
        self.db = db
        self.store = store
        self.models = models
        self.guard = guard
        self.engine = None

    def start(self) -> threading.Thread:
        t = threading.Thread(target=self._loop, name="worker", daemon=True)
        t.start()
        return t

    def _loop(self) -> None:
        cv2.setNumThreads(settings.threads)
        while True:
            if not self.models.ready:
                self.store.wait_for_work(2.0)
                continue
            if self.engine is None:
                try:
                    self.engine = self.models.load_engine(settings.threads, settings.min_face)
                except Exception as e:
                    self.models.error = f"chargement du modèle impossible : {e}"
                    self.models.ready = False
                    log.exception("chargement du modèle")
                    continue
            row = self.store.next_job()
            if row is None:
                self.store.wait_for_work(10.0)
                continue
            item_id = row["item_id"]
            try:
                self.run(row)
            except Cancelled:
                log.info("[xray] %s : arrêté (ordre supprimé ou fichier changé)", item_id)
            except Exception as e:
                log.exception("[xray] %s : échec", item_id)
                msg = f"{type(e).__name__}: {e}"[:500]
                if self._same(item_id, row["etag"]):
                    self.store.set_status(item_id, "failed", error=msg)
            finally:
                self.store.running_id = None
                self.store.cancel.clear()

    def _same(self, item_id: str, etag: str) -> bool:
        cur = self.store.get(item_id)
        return cur is not None and cur["etag"] == etag

    # --- un ordre --------------------------------------------------------------------------

    def run(self, row) -> None:
        item_id, etag, path = row["item_id"], row["etag"], row["path"]
        model = self.models.name
        self.store.running_id = item_id
        self.store.cancel.clear()
        if row["version"] < RESULT_VERSION:
            # Commencé sous d'anciennes règles et pas fini : on repart de zéro plutôt que de
            # mêler, dans un même résultat, des tronçons des deux versions.
            log.info("[xray] %s : tronçons de la version %d oubliés, reprise à zéro", item_id, row["version"])
            with self.db.tx() as c:
                for table in ("chunks", "shots", "tracks", "results"):
                    c.execute(f"DELETE FROM {table} WHERE item_id=?", (item_id,))
        self.store.set_status(item_id, "running", attempts=row["attempts"] + 1, model=model, version=RESULT_VERSION)
        t_job = time.monotonic()
        info = decode.probe(path)
        if info.duration <= 0:
            raise RuntimeError("durée nulle")
        self.store.set_status(item_id, "running", duration=info.duration)
        step = settings.chunk_seconds
        if self.db.one("SELECT COUNT(*) FROM chunks WHERE item_id=?", (item_id,))[0] == 0:
            n = max(1, math.ceil(info.duration / step))
            with self.db.tx() as c:
                for i in range(n):
                    c.execute("INSERT INTO chunks (item_id, idx, start, end) VALUES (?, ?, ?, ?)",
                              (item_id, i, i * step, min(info.duration, (i + 1) * step)))
        cast = [CastMember(c["personId"], c.get("name", ""), c.get("character", ""), c.get("order", 0), c.get("photos", []))
                for c in json.loads(row["cast_json"])]
        self.guard.busy()  # rafraîchit l'état de l'iGPU avant de commencer
        photos = castmod.photo_embeddings(self.db, self.engine, model, cast, settings.photos_dir)
        refs = castmod.build_refs(cast, photos, castmod.series_embeddings(self.db, row["series_id"], model))
        log.info("[xray] %s : %d acteurs, %d avec référence, %.0f s de vidéo (%s %s %dx%d)",
                 item_id, len(cast), len(refs), info.duration, info.codec, info.profile, info.width, info.height)
        chunks = [(r["idx"], r["start"], r["end"]) for r in
                  self.db.q("SELECT idx, start, end FROM chunks WHERE item_id=? AND done=0 ORDER BY idx", (item_id,))]
        all_chunks = [(r["idx"], r["start"], r["end"]) for r in
                      self.db.q("SELECT idx, start, end FROM chunks WHERE item_id=? ORDER BY idx", (item_id,))]
        anchor_chunks = chunk_order(all_chunks, row["start_at"])
        anchor = anchor_chunks[0][1] if anchor_chunks else 0.0
        pending = {c[0] for c in chunks}
        for idx, start, end in [c for c in anchor_chunks if c[0] in pending]:
            if self.store.cancel.is_set() or not self._same(item_id, etag):
                raise Cancelled()
            if self.store.should_yield(item_id):
                log.info("[xray] %s : cède la place à un ordre plus pressé", item_id)
                self.store.set_status(item_id, "queued")
                return
            shots, tracks, decoder = self.process_chunk(item_id, path, info, idx, start, end)
            with self.db.tx() as c:
                cur = c.execute("SELECT etag FROM items WHERE item_id=?", (item_id,)).fetchone()
                if cur is None or cur["etag"] != etag:
                    raise Cancelled()
                for s in shots:
                    c.execute("INSERT OR REPLACE INTO shots (item_id, chunk_idx, start, end, hist) VALUES (?, ?, ?, ?, ?)",
                              (item_id, idx, s.start, s.end, s.hist.astype(np.float32).tobytes()))
                for t in tracks:
                    c.execute(
                        "INSERT INTO tracks (item_id, chunk_idx, shot_start, shot_end, screen_time, quality, faces, emb) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (item_id, idx, t[0].shot_start, t[0].shot_end, t[0].screen_time, t[0].quality, t[1],
                         t[0].emb.astype(np.float32).tobytes()),
                    )
                c.execute("UPDATE chunks SET done=1, decoder=? WHERE item_id=? AND idx=?", (decoder, item_id, idx))
            self.checkpoint(item_id, etag, model, info.duration, anchor, refs)
        built = self.checkpoint(item_id, etag, model, info.duration, anchor, refs)
        if built is not None and built.complete:
            _, label_t = thresholds(model)
            castmod.update_series(self.db, row["series_id"], model, built, label_t)
            self.store.set_status(item_id, "done")
            log.info("[xray] %s : terminé en %.0f s, %d scènes", item_id, time.monotonic() - t_job, len(built.scenes))

    def checkpoint(self, item_id: str, etag: str, model: str, duration: float, anchor: float, refs):
        chunks = self.db.q("SELECT start, end, done FROM chunks WHERE item_id=?", (item_id,))
        done = [(r["start"], r["end"]) for r in chunks if r["done"]]
        if not done:
            return None
        shots = [ShotRow(r["start"], r["end"], np.frombuffer(r["hist"], dtype=np.float32))
                 for r in self.db.q("SELECT start, end, hist FROM shots WHERE item_id=?", (item_id,))]
        tracks = [TrackRow(r["shot_start"], r["shot_end"], r["screen_time"], r["quality"], np.frombuffer(r["emb"], dtype=np.float32))
                  for r in self.db.q("SELECT shot_start, shot_end, screen_time, quality, emb FROM tracks WHERE item_id=?", (item_id,))]
        cluster_t, label_t = thresholds(model)
        built = build(duration, done, len(chunks), anchor, shots, tracks, refs, label_t, cluster_t)
        with self.db.tx() as c:
            cur = c.execute("SELECT etag FROM items WHERE item_id=?", (item_id,)).fetchone()
            if cur is None or cur["etag"] != etag:
                raise Cancelled()
            c.execute(
                """INSERT OR REPLACE INTO results (item_id, etag, model, scenes_json, analyzed_until, progress, complete,
                                                  updated, version)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (item_id, etag, model, json.dumps(built.scenes, separators=(",", ":")), built.analyzed_until,
                 built.progress, 1 if built.complete else 0, time.time(), RESULT_VERSION),
            )
        return built

    # --- un tronçon ------------------------------------------------------------------------

    def process_chunk(self, item_id: str, path: str, info, idx: int, start: float, end: float):
        want_vaapi = (
            settings.hwaccel and decode.vaapi_suits(info) and decode.vaapi_available() and not self.guard.busy()
        )
        try:
            return self._process(item_id, path, info, idx, start, end, want_vaapi)
        except DecodeFailed as e:
            if not want_vaapi:
                raise RuntimeError(str(e)) from None
            log.warning("[xray] %s : VA-API en échec sur le tronçon %d, reprise sur le processeur (%s)", item_id, idx, e)
            try:
                return self._process(item_id, path, info, idx, start, end, False)
            except DecodeFailed as e2:
                raise RuntimeError(str(e2)) from None

    def _process(self, item_id, path, info, idx, start, end, vaapi: bool):
        w, h = info.out_size(settings.frame_width)
        step = 1.0 / settings.sample_fps
        splitter = ShotSplitter(w, h, step)
        stats = decode.DecodeStats("vaapi" if vaapi else "cpu")
        engine = self.engine
        for k in engine.timing:
            engine.timing[k] = 0 if k.endswith("_n") else 0.0
        shots_out: list[ShotRow] = []
        tracks_out: list[tuple[TrackRow, int]] = []
        t0 = time.monotonic()

        def analyse(shot) -> None:
            dur = shot.end - shot.start
            shots_out.append(ShotRow(shot.start, shot.end, shot.hist))
            if not shot.frames:
                return
            sel = pick_indices(len(shot.frames), frames_to_sample(dur))
            per_frame = []
            for i in sel:
                bgr = cv2.cvtColor(shot.frames[i][1], cv2.COLOR_YUV2BGR_NV12)
                per_frame.append(engine.analyse(bgr))
            for tr in link(per_frame):
                summ = summarize(tr, len(sel))
                if summ is None:
                    continue
                tracks_out.append((TrackRow(shot.start, shot.end, round(dur * summ.presence, 3), summ.quality, summ.emb), summ.faces))

        gen = decode.read_frames(path, start, end - start, info, vaapi, stats, self.store.cancel)
        for ts, frame in _prefetch(gen):
            done = splitter.push(ts, frame)
            if done is not None:
                analyse(done)
        last = splitter.flush(end)
        if self.store.cancel.is_set():
            raise Cancelled()
        if stats.returncode not in (0, None) or stats.frames == 0:
            raise DecodeFailed(f"ffmpeg ({stats.decoder}) code {stats.returncode} : {stats.stderr[-300:]}")
        if last is not None:
            analyse(last)
        wall = time.monotonic() - t0
        tm = engine.timing
        log.info(
            "[xray] %s : tronçon %d (%.0f–%.0f s) %s · %d images en %.1f s · %d plans · %d pistes · "
            "détection %.0f ms/image (%d) · empreinte %.1f ms/visage (%d)",
            item_id, idx, start, end, stats.decoder, stats.frames, wall, len(shots_out), len(tracks_out),
            tm["det_ms"] / max(tm["det_n"], 1), tm["det_n"], tm["emb_ms"] / max(tm["emb_n"], 1), tm["emb_n"],
        )
        return shots_out, tracks_out, stats.decoder
