"""L'ouvrier : un ordre à la fois par voie d'analyse, tronçon par tronçon.

Une voie (`lanes.py`) est un ouvrier : la voie A (iGPU, repli sur le processeur, et le travail
d'appoint — renommages, voix seules, lèvres), et, quand la machine le permet, la voie B (processeur
seul, un autre élément). Chaque ouvrier garde son moteur, son fil des voix, son élément et son drapeau
d'annulation ; la base (une connexion sous verrou) est partagée.

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

from . import audio as audiomod
from . import cast as castmod
from . import decode
from . import segments
from .config import RESULT_VERSION, settings
from .db import Database
from .faces import MODEL_DEFAULTS
from .inference import device_calls, device_label
from .jobs import CastMember, JobStore
from .logs import event, set_lane
from . import lanes as lanesmod
from .models import ModelManager
from .results import Assembler, ShotRow, TrackRow, build
from .pipeline import ShotFaces
from .shots import ShotSplitter, frames_to_sample, pick_indices
from .timing import StageClock, job_stats, line
from . import asdjob, relabel, report, scenecuts, subsyncjob, voicejob

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
    def __init__(self, db: Database, store: JobStore, models: ModelManager, guard, voice_models=None, asd_models=None,
                 lane: str = lanesmod.PRIMARY, cpu_only: bool = False, threads: int | None = None,
                 decode_threads: int | None = None):
        self.db = db
        # La voie (`lanes.py`) : A, ou B — processeur seul (`cpu_only`).
        self.lane = lane
        self.cpu_only = cpu_only
        self.threads = threads or settings.threads
        # Fils de ffmpeg quand il décode sur l'iGPU (borné à deux voies) ; sur le processeur, `threads`.
        self.decode_threads = decode_threads or self.threads
        self._voice_lock = threading.Lock()
        self.paused = False
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

    @property
    def cancel(self) -> threading.Event:
        return self.store.cancel_event(self.lane)

    def _voice(self) -> "voicejob.VoiceStage | None":
        # Un fil des voix (et ses réseaux, quelques dizaines de Mo) par voie : partagé, il prenait du retard
        # derrière l'autre voie, et la fin d'un élément de la voie A attendait 58 s le son de la voie B
        # (mesuré le 10/11/2026).
        vm = self.voice_models
        if vm is None or not vm.enabled or not vm.ready:
            return None
        with self._voice_lock:
            return self._voice_locked(vm)

    def _voice_locked(self, vm) -> "voicejob.VoiceStage | None":
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
        t = threading.Thread(target=self._loop, name=f"lane-{self.lane}", daemon=True)
        t.start()
        return t

    def _load_engine(self) -> bool:
        try:
            if self.cpu_only:
                # La voie B : le chemin de repli de la voie A (détecteur INT8, empreinte float32, processeur).
                self.engine = self.models.load_engine(self.threads, settings.min_face, cpu_only=True)
            else:
                # Avec l'inférence sur l'iGPU : rendue au processeur tant que Jellyfin y transcode
                # (dernier état connu du garde, rafraîchi toutes les 30 s ; jamais d'appel réseau ici).
                self.engine = self.models.load_engine(self.threads, settings.min_face,
                                                      use_gpu=lambda: not self.guard.busy_now())
                st = self.models.inference_status()
                if settings.ov_device == "GPU" and not st.get("gpu"):
                    lanesmod.plan().gpu_failed(st.get("gpuError"))
            return True
        except Exception as e:
            self.models.error = f"chargement du modèle impossible : {e}"
            self.models.ready = False
            log.exception("chargement du modèle")
            return False

    def _loop(self) -> None:
        set_lane(self.lane)
        event(log, "voie %s : démarrée (%s, %d fils%s)", self.lane,
              "processeur" if self.cpu_only else settings.ov_device, self.threads,
              "" if self.cpu_only else f", ffmpeg {self.decode_threads} fils sur l'iGPU",
              action="lane_start", cpuOnly=self.cpu_only, threads=self.threads, decodeThreads=self.decode_threads)
        if self.cpu_only:
            self._loop_cpu()
            return
        cv2.setNumThreads(settings.threads)
        while True:
            if not self.models.ready:
                self.store.wait_for_work(2.0)
                continue
            if self.engine is None and not self._load_engine():
                continue
            row = self.store.next_job()
            # Les voix d'un ordre fini avant l'étape des voix : le son seul, avant tout ordre `low` (bien
            # moins cher que l'image), jamais devant un ordre `normal` ou `high`.
            # La synchro des sous-titres (`subsyncjob.py`) d'abord parmi ces travaux d'appoint : un administrateur
            # vient de la demander, et elle est courte — jamais devant un ordre `normal` ou `high` pour autant.
            # Les débuts de scène des résultats d'avant (scenecuts.py) en tout dernier : quelques secondes de
            # regroupement par élément, sans décoder ni écouter.
            if (row is None or row["priority"] >= 2) and (self._subsync() or self._relabel() or self._voice_only() or self._asd()
                                                          or self._scene_cuts()):
                continue
            row = self.store.claim(self.lane) if row is not None else None
            if row is None:
                self.store.wait_for_work(10.0)
                continue
            self._run_claimed(row)

    def _gpu_busy(self) -> bool:
        return self.guard is not None and self.guard.busy()

    def _loop_cpu(self) -> None:
        """La voie B : un ordre `normal`/`low` à côté de la voie A, jamais pendant une transcodification."""
        while True:
            if lanesmod.plan().count < 2:
                event(log, "voie %s : arrêtée (%s)", self.lane, lanesmod.plan().reason, action="lane_stop",
                      reason=lanesmod.plan().reason)
                return
            if not self.models.ready:
                self.store.wait_for_work(2.0)
                continue
            if self._gpu_busy():
                self._pause("jellyfin_transcode")
                self.store.wait_for_work(10.0)
                continue
            self._resume()
            row = self.store.claim(self.lane, cpu_lane=True, accept=self._cpu_suits)
            if row is None:
                self.store.wait_for_work(5.0)
                continue
            if self.engine is None and not self._load_engine():
                self.store.release(self.lane)
                continue
            self._run_claimed(row)

    def _cpu_suits(self, row) -> bool:
        """Le décodage de ce fichier sur le processeur est-il bon marché (`XRAY_LANE_B_MAX_PIXELS`) ? Lu une
        fois par fichier (ffprobe) ; illisible : laissé à la voie A, qui dira pourquoi."""
        key = (row["item_id"], row["etag"])
        cache = self.__dict__.setdefault("_suits", {})
        if key not in cache:
            try:
                info = decode.probe(row["path"])
                ok = info.width * info.height <= settings.lane_b_max_pixels
                why = f"{info.width}×{info.height}"
            except Exception as e:
                ok, why = False, f"{type(e).__name__}"
            if len(cache) > 1000:
                cache.clear()
            cache[key] = ok
            if not ok:
                event(log, "[xray] %s : laissé à la voie A (%s)", row["item_id"], why, item=row["item_id"],
                      action="lane_skip", reason="max_pixels" if why[:1].isdigit() else "probe", size=why)
        return cache[key]

    def _pause(self, reason: str) -> None:
        if not self.paused:
            self.paused = True
            event(log, "voie %s : en pause (%s)", self.lane, reason, action="lane_pause", reason=reason)

    def _resume(self) -> None:
        if self.paused:
            self.paused = False
            event(log, "voie %s : reprise", self.lane, action="lane_resume", reason="jellyfin_idle")

    def _run_claimed(self, row) -> None:
        item_id = row["item_id"]
        t0 = time.monotonic()
        try:
            self.run(row)
        except Cancelled:
            event(log, "[xray] %s : arrêté (ordre supprimé ou fichier changé)", item_id, item=item_id,
                  action="job_cancelled", seconds=round(time.monotonic() - t0, 1))
        except Exception as e:
            msg = f"{type(e).__name__}: {e}"[:500]
            done = self.db.one("SELECT COUNT(*) AS n, SUM(done) AS d FROM chunks WHERE item_id=?", (item_id,))
            event(log, "[xray] %s : échec", item_id, level=logging.ERROR, item=item_id, action="job_failed",
                  exc_info=True, seconds=round(time.monotonic() - t0, 1), attempts=row["attempts"] + 1,
                  chunks=done["n"] if done else None, chunksDone=(done["d"] or 0) if done else None, path=row["path"])
            if self._same(item_id, row["etag"]):
                self.store.set_status(item_id, "failed", error=msg)
        finally:
            self.store.release(self.lane)

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

    def _subsync(self) -> bool:
        """Un ordre de synchro des sous-titres (`subsyncjob.py`) : rend la main entre deux blocs de son dès qu'un
        ordre d'analyse `normal` ou `high` attend, ou si l'élément est supprimé."""
        row = subsyncjob.next_job(self.db)
        if row is None:
            return False
        self.store.running_id = row["item_id"]
        try:
            subsyncjob.run_job(
                self.db, row, self._subsync_vad,
                lambda: self.store.cancel.is_set() or self.db.one(
                    "SELECT 1 FROM items WHERE status='queued' AND priority < 2 LIMIT 1") is not None)
        finally:
            self.store.running_id = None
            self.store.cancel.clear()
        return True

    def _subsync_vad(self):
        """Silero seul, chargé à la première passe « parole seule » — le fichier que « qui parle » télécharge et
        vérifie (`voice.VAD_FILE`) ; sans lui, rien (la passe le dit)."""
        if getattr(self, "_vad", None) is None:
            from .voice import VAD_FILE

            vm = self.voice_models
            path = (vm.dir if vm is not None else settings.models_dir / "voice") / VAD_FILE.name
            if vm is not None and not vm.ready or not path.exists():
                return None
            self._vad = subsyncjob.Vad(path)
        return self._vad

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
            event(log, "[xray] %s : lecture des lèvres en échec", row["item_id"], level=logging.ERROR,
                  item=row["item_id"], action="asd_failed", exc_info=True)
            asdjob._save_run(self.db, row, vm.name, "done", {}, {"error": f"{type(e).__name__}: {e}"[:300]})
            report.save(self.db, row["item_id"], "lèvres")
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

    def _scene_cuts(self) -> bool:
        """La mesure des frontières de scène et la lecture des chapitres des éléments finis qui n'en ont pas
        (scenecuts.backfill_some), par lots bornés en temps ; jamais devant un ordre `normal` ou `high`."""
        if scenecuts.next_backfill(self.db) is None:
            return False
        n = scenecuts.backfill_some(self.db, should_stop=lambda: self.db.one(
            "SELECT 1 FROM items WHERE status='queued' AND priority < 2 LIMIT 1") is not None)
        return n > 0

    def _same(self, item_id: str, etag: str) -> bool:
        cur = self.store.get(item_id)
        return cur is not None and cur["etag"] == etag

    # --- un ordre --------------------------------------------------------------------------

    def run(self, row) -> None:
        item_id, etag, path = row["item_id"], row["etag"], row["path"]
        model = self.models.name
        self._asm = None  # assemblage incrémental : repart de la base à chaque passage
        if row["version"] < RESULT_VERSION:
            # Commencé sous d'anciennes règles et pas fini : on repart de zéro plutôt que de
            # mêler, dans un même résultat, des tronçons des deux versions.
            event(log, "[xray] %s : tronçons de la version %d oubliés, reprise à zéro", item_id, row["version"],
                  item=item_id, action="version_reset", previous=row["version"], version=RESULT_VERSION)
            with self.db.tx() as c:
                for table in ("chunks", "shots", "tracks", "results", "voice_regions", "voice_windows", "voice_results",
                              "asd_votes", "asd_runs", "reports"):
                    c.execute(f"DELETE FROM {table} WHERE item_id=?", (item_id,))
                c.execute("UPDATE items SET stats_json=NULL WHERE item_id=?", (item_id,))
        self.store.set_status(item_id, "running", attempts=row["attempts"] + 1, model=model, version=RESULT_VERSION)
        t_job = time.monotonic()
        raw_skip = row["skip_json"] if "skip_json" in row.keys() else None
        event(log, "[xray] %s : analyse commencée (voie %s)", item_id, self.lane, item=item_id, action="job_start",
              path=path, etag=etag, cpuOnly=self.cpu_only,
              priority={0: "high", 1: "normal", 2: "low"}.get(row["priority"], row["priority"]),
              startAt=row["start_at"], attempt=row["attempts"] + 1, seriesId=row["series_id"],
              originalLanguage=row["original_language"] if "original_language" in row.keys() else None,
              skip=json.loads(raw_skip) if raw_skip else None, faceModel=model,
              voiceModel=self.voice_models.name if self.voice_models is not None and self.voice_models.enabled else None)
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
        series = castmod.series_embeddings(self.db, row["series_id"], model, exclude_item=item_id)
        refs = castmod.build_refs(cast, photos, series)
        # Mémoire de la série, pour la sortie anticipée (`pipeline.memory_match`) : seulement les
        # personnes de la distribution de cet épisode.
        cast_ids = {m.person_id for m in cast}
        mem_ids = [pid for pid in series if pid in cast_ids]
        mem = [series[pid] for pid in mem_ids]
        self.memory_ids = mem_ids
        self.memory = np.stack(mem).astype(np.float32) if mem else None
        self.skips = self._skips(item_id, row)
        if raw_skip is not None:
            skip_source = "ordre"
        else:
            cur = self.db.one("SELECT skip_json FROM items WHERE item_id=?", (item_id,))
            skip_source = "jellyfin" if cur is not None and cur["skip_json"] is not None else "aucune"
        try:
            prev = self.db.one("SELECT run_json FROM items WHERE item_id=?", (item_id,))
            facts = report.run_facts(self.models, skip_source,
                                     json.loads(prev["run_json"]) if prev is not None and prev["run_json"] else None,
                                     engine=self.engine, lane=self.lane)
            self.db.run("UPDATE items SET run_json=? WHERE item_id=?", (json.dumps(facts, ensure_ascii=False), item_id))
        except Exception:  # le rapport ne fait jamais échouer l'analyse
            log.exception("[xray] %s : faits de l'analyse non gardés", item_id)
        event(log, "[xray] %s : %d acteurs, %d avec référence, %d en mémoire de série, %.0f s de vidéo (%s %s %dx%d), "
              "plages sautées : %s", item_id, len(cast), len(refs), len(mem), info.duration, info.codec,
              info.profile, info.width, info.height,
              ", ".join(f"{a:.0f}–{b:.0f} s" for a, b in self.skips) or "aucune",
              item=item_id, action="job_plan", cast=len(cast), refs=len(refs), memory=len(mem),
              durationS=round(info.duration, 3), codec=info.codec, profile=info.profile, width=info.width,
              height=info.height, hdr=info.hdr, skipSource=skip_source, skipped=[[a, b] for a, b in self.skips],
              chunks=self.db.one("SELECT COUNT(*) FROM chunks WHERE item_id=?", (item_id,))[0],
              chunksDone=self.db.one("SELECT COUNT(*) FROM chunks WHERE item_id=? AND done=1", (item_id,))[0])
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
                event(log, "[xray] %s : voix — piste %s (%s, %s, %d canaux, %s)", item_id,
                      f"0:{t.index}" if t else "aucune", (self.voice_tinfo or {}).get("reason"),
                      t.language if t else "-", t.channels if t else 0, t.title if t else "-", item=item_id,
                      action="voice_track", reason=(self.voice_tinfo or {}).get("reason"),
                      originalLanguage=(self.voice_tinfo or {}).get("originalLanguage"),
                      track=audiomod.describe(t) if t else None)
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
            if self.cancel.is_set() or not self._same(item_id, etag):
                raise Cancelled()
            if self.cpu_only and self._gpu_busy():
                # Jellyfin transcode : la voie A repasse sur le processeur, la voie B s'arrête ici (l'élément
                # retourne en file, ses tronçons faits restent faits).
                self._pause("jellyfin_transcode")
                event(log, "[xray] %s : rendu à la file, voie %s en pause", item_id, self.lane, item=item_id,
                      action="job_yield", reason="lane_pause", seconds=round(time.monotonic() - t_job, 1))
                self.store.set_status(item_id, "queued")
                return
            if self.store.should_yield(item_id, cpu_lane=self.cpu_only):
                event(log, "[xray] %s : cède la place à un ordre plus pressé", item_id, item=item_id, action="job_yield",
                      seconds=round(time.monotonic() - t_job, 1))
                self.store.set_status(item_id, "queued")
                return
            self.chunk_audio = [] if self.voice_track is not None else None
            calls0 = device_calls(self.engine)
            shots, tracks, decoder, clock = self.process_chunk(item_id, path, info, idx, start, end)
            # Où l'inférence a tourné pendant ce tronçon (rapport de décision) : à côté du chronomètre.
            chunk_stats = clock.as_dict()
            if decoder != "skip":
                chunk_stats["device"] = device_label(calls0, device_calls(self.engine))
            chunk_stats["lane"] = self.lane
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
                chunk_stats.update(clock.as_dict())
                c.execute("UPDATE chunks SET done=1, decoder=?, stats=? WHERE item_id=? AND idx=?",
                          (decoder, json.dumps(chunk_stats), item_id, idx))
            with job_clock.stage("build"):
                built = self.checkpoint(item_id, etag, model, info.duration, anchor, refs)
            self._save_job_clock(item_id, job_clock)
            job_clock = StageClock()
            if stage is not None and self.chunk_audio is not None:
                stage.note_faces(item_id, built)
                stage.submit(item_id, etag, idx, self.chunk_audio, row["series_id"], self.voice_tinfo, lane=self.lane)
        with job_clock.stage("build"):
            built = self.checkpoint(item_id, etag, model, info.duration, anchor, refs)
        self._save_job_clock(item_id, job_clock)
        if stage is not None and self.voice_track is not None and built is not None:
            vres = stage.finish(item_id, etag, row["series_id"], self.voice_tinfo, built)
            if vres is not None:
                st = vres.stats
                event(log, "[xray] %s : voix — %d voix nommées, %d indécises, %d en désaccord (visages / mémoire), "
                      "%d trop petites ; %d morceaux sur %d nommés", item_id, st.get("voicesNamed", 0),
                      st.get("voicesUndecided", 0), st.get("voicesConflict", 0), st.get("voicesSmall", 0),
                      st.get("named", 0), st.get("pieces", 0), item=item_id, action="voices_done", stats=st,
                      errors=stage.errors.get(item_id))
        elif stage is not None and self.voice_track is None and built is not None and built.complete:
            voicejob.no_audio(self.db, item_id, etag, self.voice_models.name, self.voice_tinfo)
        if built is not None and built.complete:
            _, label_t = thresholds(model)
            castmod.update_series(self.db, row["series_id"], model, built, label_t, item_id)
            # Les chapitres du fichier, une fois (« Revenir au début de la scène », scenecuts.py) : l'en-tête seul.
            scenecuts.store_chapters(self.db, item_id, path)
            self.store.set_status(item_id, "done")
            st = job_stats(self.db, item_id, info.duration)
            event(log, "[xray] %s : terminé en %.0f s (%.0f s de calcul, %s× le temps réel), %d scènes — %s",
                  item_id, time.monotonic() - t_job, st["seconds"], st["realtime"], len(built.scenes), line(st),
                  item=item_id, action="job_done", seconds=round(time.monotonic() - t_job, 1),
                  computeSeconds=st["seconds"], realtime=st["realtime"], scenes=len(built.scenes), stages=st["stages"],
                  counts=st["counts"], decodeSeconds=st.get("decodeSeconds"), skippedSeconds=st.get("skippedSeconds"))
            report.save(self.db, item_id, "analyse")

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
            event(log, "[xray] %s : tronçon %d (%.0f–%.0f s) sauté", item_id, idx, start, end, item=item_id,
                  action="chunk_skipped", chunk=idx, start=start, end=end)
            if getattr(self, "chunk_audio", None) is not None:
                self.chunk_audio = []  # rien à écouter : le tronçon est fait, sans parole
            return [], [], "skip", clock
        want_vaapi = (
            not self.cpu_only and settings.hwaccel and decode.vaapi_suits(info) and decode.vaapi_available()
            and not self.guard.busy()
        )
        try:
            return self._process(item_id, path, info, idx, start, end, parts, want_vaapi)
        except DecodeFailed as e:
            if not want_vaapi:
                raise RuntimeError(str(e)) from None
            event(log, "[xray] %s : VA-API en échec sur le tronçon %d, reprise sur le processeur (%s)", item_id, idx, e,
                  level=logging.WARNING, item=item_id, action="vaapi_fallback", chunk=idx, error=str(e)[:500])
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
            gen = decode.read_frames(path, p0, p1 - p0, info, vaapi, stats, self.cancel, audio=track,
                                     audio_out=audio_out,
                                     threads=self.decode_threads if vaapi else self.threads)
            for ts, frame in _prefetch(gen, clock=clock):
                with clock.stage("shots"):
                    done = splitter.push(ts, frame)
                if done is not None:
                    analyse(done)
            # Une plage sautée coupe le plan : rien ne relie ce qui l'entoure.
            last = splitter.flush(p1)
            if self.cancel.is_set():
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
        event(
            log,
            "[xray] %s : tronçon %d (%.0f–%.0f s) %s · %d images en %.1f s · %d plans · %d pistes · "
            "détection %.0f ms/image (%d) · empreinte %.1f ms/visage (%d) · attente décodage %.1f s%s",
            item_id, idx, start, end, decoder, n.get("decoded", 0), wall, len(shots_out), len(tracks_out),
            1000 * sec.get("detect", 0.0) / max(n.get("images", 0), 1), n.get("images", 0),
            1000 * sec.get("embed", 0.0) / max(n.get("embedded", 0), 1), n.get("embedded", 0),
            sec.get("decode_wait", 0.0), f" · {skipped:.0f} s sautées" if skipped > 0 else "",
            item=item_id, action="chunk_done", chunk=idx, start=start, end=end, decoder=decoder,
            frames=n.get("decoded", 0), seconds=round(wall, 2), shots=len(shots_out), tracks=len(tracks_out),
            images=n.get("images", 0), embedded=n.get("embedded", 0), skippedSeconds=round(skipped, 1) or None,
        )
        return shots_out, tracks_out, decoder, clock
