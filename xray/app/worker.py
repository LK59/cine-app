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
from . import segments
from .config import RESULT_VERSION, settings
from .db import Database
from .faces import MODEL_DEFAULTS
from .jobs import CastMember, JobStore
from .models import ModelManager
from .results import Assembler, ShotRow, TrackRow, build
from .pipeline import ShotFaces
from .shots import ShotSplitter, frames_to_sample, pick_indices
from .timing import StageClock, job_stats, line
from . import asdjob, relabel, voicejob

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


def _prefetch(gen, depth: int = 48, clock: StageClock | None = None):
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
        t0 = time.perf_counter()
        item = q.get()
        if clock is not None:
            clock.add("decode_wait", time.perf_counter() - t0)
        if item is END:
            break
        yield item
    t.join()
    if err:
        raise err[0]


class Worker:
    def __init__(self, db: Database, store: JobStore, models: ModelManager, guard, voice_models=None, asd_models=None):
        self.db = db
        self.store = store
        self.models = models
        self.guard = guard
        self.engine = None
        self._asm: dict | None = None
        # « Qui parle » (11/2026) : les réseaux de la voix et leur fil, chargés une fois prêts.
        self.voice_models = voice_models
        self.voice_engine = None
        self.voice_stage: voicejob.VoiceStage | None = None
        # Lecture des lèvres (11/2026, `asdjob.py`) : le réseau, chargé à la première voix indécise.
        self.asd_models = asd_models
        self.asd_net = None

    def _voice(self) -> "voicejob.VoiceStage | None":
        vm = self.voice_models
        if vm is None or not vm.enabled or not vm.ready:
            return None
        if self.voice_stage is None:
            try:
                self.voice_engine = vm.load_engine(settings.voice_threads)
                self.voice_stage = voicejob.VoiceStage(self.db, self.voice_engine, vm.name)
            except Exception as e:
                vm.error = f"chargement des réseaux de la voix impossible : {e}"
                vm.ready = False
                log.exception("chargement des réseaux de la voix")
                return None
        return self.voice_stage

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
                    # Avec l'inférence sur l'iGPU : rendue au processeur tant que Jellyfin y transcode
                    # (dernier état connu du garde, rafraîchi toutes les 30 s ; jamais d'appel réseau ici).
                    self.engine = self.models.load_engine(settings.threads, settings.min_face,
                                                          use_gpu=lambda: not self.guard.busy_now())
                except Exception as e:
                    self.models.error = f"chargement du modèle impossible : {e}"
                    self.models.ready = False
                    log.exception("chargement du modèle")
                    continue
            row = self.store.next_job()
            # Les voix d'un ordre fini avant l'étape des voix : le son seul, avant tout ordre `low` (bien
            # moins cher que l'image), jamais devant un ordre `normal` ou `high`.
            if (row is None or row["priority"] >= 2) and (self._relabel() or self._voice_only() or self._asd()):
                continue
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

    def _voice_only(self) -> bool:
        stage = self._voice()
        if stage is None:
            return False
        model = self.voice_models.name
        row = voicejob.next_voice_only(self.db, model)
        if row is None:
            return False
        self.store.running_id = row["item_id"]
        try:
            voicejob.run_voice_only(
                self.db, row, self.voice_engine, model, self._presence_from_db, self._skips,
                lambda: self.store.cancel.is_set() or self.db.one(
                    "SELECT 1 FROM items WHERE status='queued' AND priority < 2 LIMIT 1") is not None)
        finally:
            self.store.running_id = None
            self.store.cancel.clear()
        return True

    def _asd(self) -> bool:
        """La lecture des lèvres d'un élément aux voix complètes (voir `asdjob.py`) : après le son seul et
        les renommages, jamais devant un ordre `normal` ou `high` (rend la main entre deux fenêtres)."""
        am, vm = self.asd_models, self.voice_models
        if am is None or not am.enabled or not am.ready or vm is None or not vm.enabled or self.engine is None:
            return False
        row = asdjob.next_item(self.db, vm.name)
        if row is None:
            return False
        if self.asd_net is None:
            try:
                self.asd_net = am.load(settings.asd_threads)
            except Exception as e:
                am.error = f"chargement de Light-ASD impossible : {e}"
                am.ready = False
                log.exception("chargement de Light-ASD")
                return False
        self.store.running_id = row["item_id"]
        try:
            built = relabel.rebuild_faces(self.db, row, row["model"] or self.models.name)
            asdjob.run_item(self.db, row, self.engine, self.asd_net, vm.name, built,
                            lambda: self.store.cancel.is_set() or self.db.one(
                                "SELECT 1 FROM items WHERE status='queued' AND priority < 2 LIMIT 1") is not None,
                            guard=self.guard, cancel=self.store.cancel)
        except Exception as e:
            # Une panne ne se répète pas en boucle : le passage est noté fait, avec l'erreur.
            log.exception("[xray] %s : lecture des lèvres en échec", row["item_id"])
            asdjob._save_run(self.db, row, vm.name, "done", {}, {"error": f"{type(e).__name__}: {e}"[:300]})
        finally:
            self.store.running_id = None
            self.store.cancel.clear()
        return True

    def _presence_from_db(self, row):
        """Les visages d'un ordre fini, refaits depuis la base (relabel.rebuild_faces) : qui est à l'image
        plan par plan, et les scènes."""
        built = relabel.rebuild_faces(self.db, row, row["model"] or self.models.name)
        return built.presence, built.scenes

    def _relabel(self) -> bool:
        """La file des renommages (relabel.py), par lots bornés en temps ; jamais devant un ordre `normal`
        ou `high`."""
        if relabel.pending(self.db) == 0:
            return False
        vm = self.voice_models
        relabel.run_some(self.db, vm.name if vm is not None and vm.enabled else None,
                         should_stop=lambda: self.db.one(
                             "SELECT 1 FROM items WHERE status='queued' AND priority < 2 LIMIT 1") is not None)
        return True

    def _same(self, item_id: str, etag: str) -> bool:
        cur = self.store.get(item_id)
        return cur is not None and cur["etag"] == etag

    # --- un ordre --------------------------------------------------------------------------

    def run(self, row) -> None:
        item_id, etag, path = row["item_id"], row["etag"], row["path"]
        model = self.models.name
        self.store.running_id = item_id
        self.store.cancel.clear()
        self._asm = None  # assemblage incrémental : repart de la base à chaque passage
        if row["version"] < RESULT_VERSION:
            # Commencé sous d'anciennes règles et pas fini : on repart de zéro plutôt que de
            # mêler, dans un même résultat, des tronçons des deux versions.
            log.info("[xray] %s : tronçons de la version %d oubliés, reprise à zéro", item_id, row["version"])
            with self.db.tx() as c:
                for table in ("chunks", "shots", "tracks", "results", "voice_regions", "voice_windows", "voice_results",
                              "asd_votes", "asd_runs"):
                    c.execute(f"DELETE FROM {table} WHERE item_id=?", (item_id,))
                c.execute("UPDATE items SET stats_json=NULL WHERE item_id=?", (item_id,))
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
        job_clock = StageClock()
        self.engine.clock = job_clock
        with job_clock.stage("photos"):
            photos = castmod.photo_embeddings(self.db, self.engine, model, cast, settings.photos_dir)
        series = castmod.series_embeddings(self.db, row["series_id"], model)
        refs = castmod.build_refs(cast, photos, series)
        # Mémoire de la série, pour la sortie anticipée (`pipeline.memory_match`) : seulement les
        # personnes de la distribution de cet épisode.
        cast_ids = {m.person_id for m in cast}
        mem_ids = [pid for pid in series if pid in cast_ids]
        mem = [series[pid] for pid in mem_ids]
        self.memory_ids = mem_ids
        self.memory = np.stack(mem).astype(np.float32) if mem else None
        self.skips = self._skips(item_id, row)
        log.info("[xray] %s : %d acteurs, %d avec référence, %d en mémoire de série, %.0f s de vidéo (%s %s %dx%d), "
                 "plages sautées : %s", item_id, len(cast), len(refs), len(mem), info.duration, info.codec,
                 info.profile, info.width, info.height,
                 ", ".join(f"{a:.0f}–{b:.0f} s" for a, b in self.skips) or "aucune")
        # « Qui parle » : la piste son, lue dans le même ffmpeg que l'image. Sans réseaux prêts ou sans
        # piste, l'image passe seule ; le son manquant sera lu seul plus tard (`voicejob`).
        stage = self._voice()
        self.voice_track = None
        self.voice_tinfo = None
        if stage is not None:
            try:
                voicejob.reset_if_other_model(self.db, item_id, self.voice_models.name)
                self.db.run("UPDATE items SET voice_model=? WHERE item_id=?", (self.voice_models.name, item_id))
                row = self.store.get(item_id) or row
                self.voice_track, self.voice_tinfo = voicejob.track_for(self.db, row, path)
                t = self.voice_track
                log.info("[xray] %s : voix — piste %s (%s, %s, %d canaux, %s)", item_id,
                         f"0:{t.index}" if t else "aucune", (self.voice_tinfo or {}).get("reason"),
                         t.language if t else "-", t.channels if t else 0, t.title if t else "-")
            except Exception:
                log.exception("[xray] %s : piste son illisible, image seule", item_id)
                self.voice_track = None
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
            self.chunk_audio = [] if self.voice_track is not None else None
            shots, tracks, decoder, clock = self.process_chunk(item_id, path, info, idx, start, end)
            t_write = time.perf_counter()
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
                clock.add("write", time.perf_counter() - t_write)
                c.execute("UPDATE chunks SET done=1, decoder=?, stats=? WHERE item_id=? AND idx=?",
                          (decoder, json.dumps(clock.as_dict()), item_id, idx))
            with job_clock.stage("build"):
                built = self.checkpoint(item_id, etag, model, info.duration, anchor, refs)
            self._save_job_clock(item_id, job_clock)
            job_clock = StageClock()
            if stage is not None and self.chunk_audio is not None:
                stage.note_faces(item_id, built)
                stage.submit(item_id, etag, idx, self.chunk_audio, row["series_id"], self.voice_tinfo)
        with job_clock.stage("build"):
            built = self.checkpoint(item_id, etag, model, info.duration, anchor, refs)
        self._save_job_clock(item_id, job_clock)
        if stage is not None and self.voice_track is not None and built is not None:
            vres = stage.finish(item_id, etag, row["series_id"], self.voice_tinfo, built)
            if vres is not None:
                st = vres.stats
                log.info("[xray] %s : voix — %d voix nommées, %d indécises, %d en désaccord (visages / mémoire), "
                         "%d trop petites ; %d morceaux sur %d nommés", item_id, st.get("voicesNamed", 0),
                         st.get("voicesUndecided", 0), st.get("voicesConflict", 0), st.get("voicesSmall", 0),
                         st.get("named", 0), st.get("pieces", 0))
        elif stage is not None and self.voice_track is None and built is not None and built.complete:
            voicejob.no_audio(self.db, item_id, etag, self.voice_models.name, self.voice_tinfo)
        if built is not None and built.complete:
            _, label_t = thresholds(model)
            castmod.update_series(self.db, row["series_id"], model, built, label_t, item_id)
            self.store.set_status(item_id, "done")
            st = job_stats(self.db, item_id, info.duration)
            log.info("[xray] %s : terminé en %.0f s (%.0f s de calcul, %s× le temps réel), %d scènes — %s",
                     item_id, time.monotonic() - t_job, st["seconds"], st["realtime"], len(built.scenes), line(st))

    def _skips(self, item_id: str, row) -> list[tuple[float, float]]:
        """Plages à ne pas analyser : celles de l'ordre, sinon celles de Jellyfin (gardées avec
        l'ordre : une reprise saute les mêmes)."""
        raw = row["skip_json"] if "skip_json" in row.keys() else None
        if raw is not None:
            return segments.merge([(float(a), float(b)) for a, b in json.loads(raw)])
        got = segments.fetch_jellyfin(item_id)
        if got is None:
            return []
        self.db.run("UPDATE items SET skip_json=? WHERE item_id=? AND skip_json IS NULL",
                    (json.dumps([[a, b] for a, b in got]), item_id))
        return got

    def _save_job_clock(self, item_id: str, clock: StageClock) -> None:
        """Ce qui ne dépend d'aucun tronçon (photos, assemblage) s'ajoute à l'ordre, reprises comprises."""
        with self.db.tx() as c:
            row = c.execute("SELECT stats_json FROM items WHERE item_id=?", (item_id,)).fetchone()
            if row is None:
                return
            acc = StageClock()
            acc.merge(json.loads(row["stats_json"]) if row["stats_json"] else None)
            acc.merge(clock.as_dict())
            c.execute("UPDATE items SET stats_json=? WHERE item_id=?", (json.dumps(acc.as_dict()), item_id))

    def checkpoint(self, item_id: str, etag: str, model: str, duration: float, anchor: float, refs):
        chunks = self.db.q("SELECT idx, start, end, done FROM chunks WHERE item_id=?", (item_id,))
        done = [(r["start"], r["end"]) for r in chunks if r["done"]]
        if not done:
            return None
        cluster_t, label_t = thresholds(model)
        if settings.incremental:
            built = self._incremental(item_id, duration, anchor, refs, chunks, done, label_t, cluster_t)
        else:
            shots = [ShotRow(r["start"], r["end"], np.frombuffer(r["hist"], dtype=np.float32))
                     for r in self.db.q("SELECT start, end, hist FROM shots WHERE item_id=?", (item_id,))]
            tracks = [TrackRow(r["shot_start"], r["shot_end"], r["screen_time"], r["quality"], np.frombuffer(r["emb"], dtype=np.float32))
                      for r in self.db.q("SELECT shot_start, shot_end, screen_time, quality, emb FROM tracks WHERE item_id=? ORDER BY id",
                                         (item_id,))]
            built = build(duration, done, len(chunks), anchor, shots, tracks, refs, label_t, cluster_t)
        with self.db.tx() as c:
            cur = c.execute("SELECT etag FROM items WHERE item_id=?", (item_id,)).fetchone()
            if cur is None or cur["etag"] != etag:
                raise Cancelled()
            relabel.write_result(c, item_id, etag, model, built)
        return built

    def _incremental(self, item_id, duration, anchor, refs, chunks, done, label_t, cluster_t):
        """`results.Assembler` : un par passage de `run` (refs du jour), nourri des seuls plans des
        tronçons nouvellement faits et des pistes écrites depuis — dans l'ordre d'écriture, celui
        que lirait `build`. Au premier tronçon d'un passage (reprise), tout ce qui est en base."""
        st = self._asm
        if st is None or st["item"] != item_id:
            st = self._asm = {"item": item_id, "chunks": set(), "last_track": 0,
                              "asm": Assembler(duration, len(chunks), anchor, refs, label_t, cluster_t)}
        new_chunks = [r["idx"] for r in chunks if r["done"] and r["idx"] not in st["chunks"]]
        shots: list[ShotRow] = []
        for idx in new_chunks:
            shots += [ShotRow(r["start"], r["end"], np.frombuffer(r["hist"], dtype=np.float32))
                      for r in self.db.q("SELECT start, end, hist FROM shots WHERE item_id=? AND chunk_idx=?", (item_id, idx))]
        rows = self.db.q("SELECT id, shot_start, shot_end, screen_time, quality, emb FROM tracks WHERE item_id=? AND id>? ORDER BY id",
                         (item_id, st["last_track"]))
        tracks = [TrackRow(r["shot_start"], r["shot_end"], r["screen_time"], r["quality"], np.frombuffer(r["emb"], dtype=np.float32))
                  for r in rows]
        if rows:
            st["last_track"] = rows[-1]["id"]
        st["chunks"].update(new_chunks)
        st["asm"].add(done, shots, tracks)
        return st["asm"].build()

    # --- un tronçon ------------------------------------------------------------------------

    def process_chunk(self, item_id: str, path: str, info, idx: int, start: float, end: float):
        parts = segments.pieces(start, end, getattr(self, "skips", []))
        if not parts:
            # Tout le tronçon est sauté (générique) : fait, sans plan ni piste.
            clock = StageClock()
            clock.add("skipped", end - start)
            log.info("[xray] %s : tronçon %d (%.0f–%.0f s) sauté", item_id, idx, start, end)
            if getattr(self, "chunk_audio", None) is not None:
                self.chunk_audio = []  # rien à écouter : le tronçon est fait, sans parole
            return [], [], "skip", clock
        want_vaapi = (
            settings.hwaccel and decode.vaapi_suits(info) and decode.vaapi_available() and not self.guard.busy()
        )
        try:
            return self._process(item_id, path, info, idx, start, end, parts, want_vaapi)
        except DecodeFailed as e:
            if not want_vaapi:
                raise RuntimeError(str(e)) from None
            log.warning("[xray] %s : VA-API en échec sur le tronçon %d, reprise sur le processeur (%s)", item_id, idx, e)
            try:
                return self._process(item_id, path, info, idx, start, end, parts, False)
            except DecodeFailed as e2:
                raise RuntimeError(str(e2)) from None

    def _process(self, item_id, path, info, idx, start, end, parts, vaapi: bool):
        if getattr(self, "chunk_audio", None) is not None:
            self.chunk_audio.clear()  # une reprise sur le processeur relit aussi le son
        w, h = info.out_size(settings.frame_width)
        step = 1.0 / settings.sample_fps
        splitter = ShotSplitter(w, h, step)
        engine = self.engine
        clock = StageClock()
        engine.clock = clock
        faces = ShotFaces(engine, clock, settings.faces_per_track, settings.embed_batch, getattr(self, "memory", None))
        shots_out: list[ShotRow] = []
        tracks_out: list[tuple[TrackRow, int]] = []
        t0 = time.monotonic()

        def collect(rows) -> None:
            for s0, s1, _n, summ in rows:
                tracks_out.append((TrackRow(s0, s1, round((s1 - s0) * summ.presence, 3), summ.quality, summ.emb), summ.faces))

        def analyse(shot) -> None:
            dur = shot.end - shot.start
            shots_out.append(ShotRow(shot.start, shot.end, shot.hist))
            if not shot.frames:
                return
            static = shot.static
            want = frames_to_sample(dur, static)
            if static and want < frames_to_sample(dur):
                clock.count("static_shots")
            sel = pick_indices(len(shot.frames), want)
            with clock.stage("convert"):
                images = [cv2.cvtColor(shot.frames[i][1], cv2.COLOR_YUV2BGR_NV12) for i in sel]
            collect(faces.add_images(shot.start, shot.end, images))

        decoders = []
        skipped = (end - start) - sum(b - a for a, b in parts)
        if skipped > 0:
            clock.add("skipped", skipped)
        for p0, p1 in parts:
            stats = decode.DecodeStats("vaapi" if vaapi else "cpu")
            audio_out = getattr(self, "chunk_audio", None)
            track = getattr(self, "voice_track", None) if audio_out is not None else None
            gen = decode.read_frames(path, p0, p1 - p0, info, vaapi, stats, self.store.cancel, audio=track,
                                     audio_out=audio_out)
            for ts, frame in _prefetch(gen, clock=clock):
                with clock.stage("shots"):
                    done = splitter.push(ts, frame)
                if done is not None:
                    analyse(done)
            # Une plage sautée coupe le plan : rien ne relie ce qui l'entoure.
            last = splitter.flush(p1)
            if self.store.cancel.is_set():
                raise Cancelled()
            if stats.failed:
                raise DecodeFailed(f"ffmpeg ({stats.decoder}) code {stats.returncode} : {stats.stderr[-300:]}")
            if last is not None:
                analyse(last)
            clock.add("decode", stats.seconds)
            clock.count("decoded", stats.frames)
            decoders.append(stats.decoder)
        collect(faces.flush())
        wall = time.monotonic() - t0
        clock.add("wall", wall)
        clock.count("shots", len(shots_out))
        clock.count("tracks", len(tracks_out))
        sec, n = clock.seconds, clock.counts
        decoder = decoders[0] if decoders else "skip"
        log.info(
            "[xray] %s : tronçon %d (%.0f–%.0f s) %s · %d images en %.1f s · %d plans · %d pistes · "
            "détection %.0f ms/image (%d) · empreinte %.1f ms/visage (%d) · attente décodage %.1f s%s",
            item_id, idx, start, end, decoder, n.get("decoded", 0), wall, len(shots_out), len(tracks_out),
            1000 * sec.get("detect", 0.0) / max(n.get("images", 0), 1), n.get("images", 0),
            1000 * sec.get("embed", 0.0) / max(n.get("embedded", 0), 1), n.get("embedded", 0),
            sec.get("decode_wait", 0.0), f" · {skipped:.0f} s sautées" if skipped > 0 else "",
        )
        return shots_out, tracks_out, decoder, clock
