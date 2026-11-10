"""« Qui parle » dans un ordre : le son de chaque tronçon, à côté de l'image, puis l'assemblage.

Pendant l'analyse des visages (`worker.py`), le son de chaque tronçon sort du même ffmpeg que l'image
(`decode.read_frames(audio=…)`) et part ici dans une file : un fil à lui (`VoiceStage`) en tire les
zones de parole et les empreintes (`voice.py`, sur ses propres cœurs), les écrit en base tronçon par
tronçon — un redémarrage ne refait que ce qui manque —, puis refait le résultat des voix avec ce que les
visages savent à cet instant (`voices.build`). À la fin de l'ordre, une dernière fois avec les visages
complets ; puis la mémoire des voix de la série.

**Un ordre fait avant l'étape des voix** (résultat v4, ou modèle de voix pas encore prêt) n'est pas
réanalysé : quand rien de plus pressé qu'un ordre `low` n'attend, l'ouvrier lit **le son seul** des
tronçons qui manquent (`run_voice_only`, bien moins cher que l'image) et prend les visages en base.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time

import numpy as np

from . import audio as audiomod
from . import memory
from . import segments
from .config import VOICE_VERSION, settings
from .db import Database
from .logs import event, set_lane
from .voices import VoiceResult, build

log = logging.getLogger("xray.voicejob")

# Une tentative du son seul en échec est retentée une semaine plus tard (fichier illisible, piste absente).
RETRY_AFTER_S = 7 * 24 * 3600


def track_for(db: Database, row, path: str) -> tuple[audiomod.AudioTrack | None, dict | None]:
    """La piste son de l'ordre : celle déjà retenue (une reprise lit la même), sinon choisie et gardée."""
    raw = row["voice_track_json"] if "voice_track_json" in row.keys() else None
    if raw:
        d = json.loads(raw)
        if d.get("track") is None:
            return None, d
        return audiomod.AudioTrack(**d["track"]), d
    tracks = audiomod.probe_tracks(path)
    orig = row["original_language"] if "original_language" in row.keys() else None
    t, why = audiomod.choose_track(tracks, orig, settings.voice_track)
    d = {"track": t.as_dict() if t else None, "reason": why, "originalLanguage": orig}
    db.run("UPDATE items SET voice_track_json=? WHERE item_id=?", (json.dumps(d, ensure_ascii=False), row["item_id"]))
    event(log, "[xray] %s : piste son choisie — %s (%s)", row["item_id"], f"0:{t.index}" if t else "aucune", why,
          item=row["item_id"], action="audio_track", reason=why, originalLanguage=orig, mode=settings.voice_track,
          tracks=len(tracks), track=audiomod.describe(t) if t else None)
    return t, d


def reset_if_other_model(db: Database, item_id: str, model: str) -> None:
    """Des empreintes d'un autre modèle de voix ne se comparent à rien : oubliées, à refaire."""
    row = db.one("SELECT voice_model FROM items WHERE item_id=?", (item_id,))
    if row is None or row["voice_model"] == model:
        return
    if row["voice_model"]:
        event(log, "[xray] %s : empreintes de voix d'un autre modèle (%s) oubliées, à refaire sous %s", item_id,
              row["voice_model"], model, item=item_id, action="voice_model_reset", previous=row["voice_model"],
              model=model)
    with db.tx() as c:
        # Les votes de la lecture des lèvres sont gardés (des instants et des visages, pas des voix) ; le
        # passage, lui, est à refaire : les voix indécises ne sont plus les mêmes.
        for table in ("voice_regions", "voice_windows", "voice_results", "asd_runs"):
            c.execute(f"DELETE FROM {table} WHERE item_id=?", (item_id,))
        c.execute("UPDATE chunks SET voice=0 WHERE item_id=?", (item_id,))
        c.execute("UPDATE items SET voice_model=? WHERE item_id=?", (model, item_id))


def store_chunk(db: Database, item_id: str, etag: str, idx: int, regions, wins: np.ndarray, embs: np.ndarray) -> bool:
    """Écrit le son d'un tronçon d'un bloc ; `False` si l'ordre a changé de fichier entre-temps."""
    with db.tx() as c:
        cur = c.execute("SELECT etag FROM items WHERE item_id=?", (item_id,)).fetchone()
        if cur is None or cur["etag"] != etag:
            return False
        c.execute("DELETE FROM voice_regions WHERE item_id=? AND chunk_idx=?", (item_id, idx))
        c.execute("DELETE FROM voice_windows WHERE item_id=? AND chunk_idx=?", (item_id, idx))
        c.executemany("INSERT INTO voice_regions (item_id, chunk_idx, start, end) VALUES (?, ?, ?, ?)",
                      [(item_id, idx, float(s), float(e)) for s, e in regions])
        # Les empreintes en demi-précision : la moitié de la place, des cosinus identiques à 10⁻³ près.
        c.executemany("INSERT INTO voice_windows (item_id, chunk_idx, start, end, emb) VALUES (?, ?, ?, ?, ?)",
                      [(item_id, idx, float(w[0]), float(w[1]), e.astype(np.float16).tobytes()) for w, e in zip(wins, embs)])
        c.execute("UPDATE chunks SET voice=1 WHERE item_id=? AND idx=?", (item_id, idx))
    return True


def load_voice(db: Database, item_id: str) -> tuple[list[tuple[float, float]], np.ndarray, np.ndarray]:
    regions = [(r["start"], r["end"]) for r in db.q("SELECT start, end FROM voice_regions WHERE item_id=? ORDER BY start", (item_id,))]
    rows = db.q("SELECT start, end, emb FROM voice_windows WHERE item_id=? ORDER BY start", (item_id,))
    wins = np.array([(r["start"], r["end"]) for r in rows], dtype=np.float64).reshape(-1, 2)
    embs = np.stack([np.frombuffer(r["emb"], dtype=np.float16).astype(np.float32) for r in rows]) if rows else np.zeros((0, 256), np.float32)
    return regions, wins, embs


def load_asd(db: Database, item_id: str) -> list[tuple[float, float, int | None, float, float | None]]:
    """Les votes de la lecture des lèvres d'un élément (`asdjob.py`) : (début, fin, personne, note, note du suivant)."""
    return [(r["start"], r["end"], r["person_id"], r["score"], r["second"])
            for r in db.q("SELECT start, end, person_id, score, second FROM asd_votes WHERE item_id=? ORDER BY start", (item_id,))]


def series_memory(db: Database, series_id: str | None, model: str,
                  exclude_item: str | None = None) -> dict[int, np.ndarray]:
    """La mémoire des voix de la série, sans la contribution de l'épisode `exclude_item` (memory.recall)."""
    return memory.recall(db, series_id, "voice", model, exclude_item)


def update_series(db: Database, series_id: str | None, model: str, result: VoiceResult, item_id: str = "?") -> int:
    """Dépose la contribution de cet épisode à la mémoire des voix : seulement des voix que les **visages**
    ont nommées avec assurance (`profiles`) — jamais la mémoire elle-même."""
    return memory.contribute(db, series_id, "voice", model, item_id,
                             {pid: (emb, float(n), float(n)) for pid, (emb, n) in result.profiles.items()})


def assemble(db: Database, item_id: str, etag: str, model: str, series_id: str | None, track: dict | None,
             presence, scenes, final: bool) -> VoiceResult | None:
    """Refait le résultat des voix d'un ordre et l'écrit. `final` : les visages sont complets — si le son
    de chaque tronçon est fait, le résultat l'est aussi, et la mémoire de la série apprend."""
    chunks = db.q("SELECT start, end, voice FROM chunks WHERE item_id=?", (item_id,))
    if not chunks:
        return None
    t0 = time.process_time()
    regions, wins, embs = load_voice(db, item_id)
    memory = series_memory(db, series_id, model, exclude_item=item_id)
    result = build(regions, wins, embs, presence, scenes, memory, asd=load_asd(db, item_id))
    done = [(r["start"], r["end"]) for r in chunks if r["voice"]]
    complete = final and len(done) == len(chunks)
    until = max((e for _, e in done), default=0.0)
    stats = dict(result.stats, seconds=round(time.process_time() - t0, 2))
    with db.tx() as c:
        cur = c.execute("SELECT etag FROM items WHERE item_id=?", (item_id,)).fetchone()
        if cur is None or cur["etag"] != etag:
            return None
        c.execute(
            """INSERT OR REPLACE INTO voice_results (item_id, etag, model, track_json, segments_json, analyzed_until,
                                                     complete, version, stats_json, updated, diag_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (item_id, etag, model, json.dumps(track, ensure_ascii=False) if track else None,
             json.dumps(result.segments, separators=(",", ":")), round(until, 3), 1 if complete else 0, VOICE_VERSION,
             json.dumps(stats), time.time(),
             # Le détail par voix (rapport de décision), seulement quand le résultat est final : refait à
             # chaque tronçon, il ne servirait à rien.
             json.dumps(result.voices, separators=(",", ":"), ensure_ascii=False) if final else None),
        )
    if complete:
        update_series(db, series_id, model, result, item_id)
    return result


def no_audio(db: Database, item_id: str, etag: str, model: str, track: dict | None) -> None:
    """Sans piste son utilisable : un résultat complet et vide (rien à retenter), qui le dit."""
    with db.tx() as c:
        c.execute(
            """INSERT OR REPLACE INTO voice_results (item_id, etag, model, track_json, segments_json, analyzed_until,
                                                     complete, version, stats_json, updated)
               VALUES (?, ?, ?, ?, '[]', 0, 1, ?, NULL, ?)""",
            (item_id, etag, model, json.dumps(track, ensure_ascii=False) if track else None, VOICE_VERSION, time.time()),
        )


class VoiceStage:
    """Le son d'un ordre, à côté de l'image : une file, un fil. Le fil de l'ouvrier dépose le son de
    chaque tronçon (`submit`) et la photographie des visages (`note_faces`) ; il attend la fin (`finish`)."""

    def __init__(self, db: Database, engine, model: str):
        self.db = db
        self.engine = engine
        self.model = model
        self.q: queue.Queue = queue.Queue()
        self.faces: dict[str, tuple[list, list]] = {}
        self.cancel = threading.Event()
        self.errors: dict[str, str] = {}
        # Tronçons déposés et pas encore écoutés, par élément : avec deux voies d'analyse (`lanes.py`), le
        # fil est partagé, et `finish` d'un élément n'attend que *ses* tronçons, pas ceux de l'autre voie.
        self._pending: dict[str, int] = {}
        self._cv = threading.Condition()
        self._t = threading.Thread(target=self._run, name="voice", daemon=True)
        self._t.start()

    def note_faces(self, item_id: str, built) -> None:
        if built is not None:
            self.faces[item_id] = (list(built.presence), list(built.scenes))

    def submit(self, item_id: str, etag: str, idx: int, parts: list[tuple[float, np.ndarray]], series_id: str | None,
               track: dict | None, lane: str | None = None) -> None:
        with self._cv:
            self._pending[item_id] = self._pending.get(item_id, 0) + 1
        self.q.put((item_id, etag, idx, parts, series_id, track, lane))

    def wait_item(self, item_id: str) -> None:
        with self._cv:
            self._cv.wait_for(lambda: self._pending.get(item_id, 0) == 0)

    def finish(self, item_id: str, etag: str, series_id: str | None, track: dict | None, built) -> VoiceResult | None:
        """Attend le son des tronçons déposés, puis le résultat final avec les visages complets."""
        self.wait_item(item_id)
        self.note_faces(item_id, built)
        presence, scenes = self.faces.get(item_id, ([], []))
        return assemble(self.db, item_id, etag, self.model, series_id, track, presence, scenes, final=True)

    def _run(self) -> None:
        while True:
            item_id, etag, idx, parts, series_id, track, lane = self.q.get()
            set_lane(lane)
            try:
                regions: list = []
                wins_l: list = []
                embs_l: list = []
                for start, pcm in parts:
                    if len(pcm) < audiomod.SR // 4:
                        continue
                    cv = self.engine.analyse(pcm, start, self.cancel)
                    regions += cv.regions
                    wins_l.append(cv.wins)
                    embs_l.append(cv.embs)
                wins = np.concatenate(wins_l) if wins_l else np.zeros((0, 2))
                embs = np.concatenate(embs_l) if embs_l else np.zeros((0, 256), np.float32)
                if store_chunk(self.db, item_id, etag, idx, regions, wins, embs):
                    presence, scenes = self.faces.get(item_id, ([], []))
                    assemble(self.db, item_id, etag, self.model, series_id, track, presence, scenes, final=False)
            except Exception as e:  # le son ne fait jamais échouer l'ordre : le tronçon reste à faire
                self.errors[item_id] = f"{type(e).__name__}: {e}"[:300]
                log.exception("[xray] %s : voix du tronçon %d en échec", item_id, idx)
            finally:
                set_lane(None)
                with self._cv:
                    n = self._pending.get(item_id, 1) - 1
                    if n <= 0:
                        self._pending.pop(item_id, None)
                    else:
                        self._pending[item_id] = n
                    self._cv.notify_all()
                self.q.task_done()


def next_voice_only(db: Database, model: str, now: float | None = None):
    """Un ordre fini dont les voix manquent (fait avant l'étape des voix, ou sous un autre modèle) : le
    plus récemment touché d'abord. Un essai en échec attend une semaine."""
    now = time.time() if now is None else now
    return db.one(
        """SELECT i.* FROM items i LEFT JOIN voice_results v ON v.item_id = i.item_id
           WHERE i.status='done' AND (v.item_id IS NULL OR v.complete=0 OR v.etag != i.etag OR v.model != ?)
             AND (i.voice_tried IS NULL OR i.voice_tried < ?)
           ORDER BY i.updated DESC LIMIT 1""",
        (model, now - RETRY_AFTER_S),
    )


def run_voice_only(db: Database, row, engine, model: str, presence_of, skips_of, should_stop) -> str:
    """Le son seul d'un ordre fini : les tronçons qui manquent, puis le résultat. Rend `done`, `yield`
    (un ordre plus pressé attend : on reprendra) ou `failed`."""
    item_id, etag, path = row["item_id"], row["etag"], row["path"]
    try:
        reset_if_other_model(db, item_id, model)
        db.run("UPDATE items SET voice_model=? WHERE item_id=?", (model, item_id))
        track, tinfo = track_for(db, row, path)
        if track is None:
            no_audio(db, item_id, etag, model, tinfo)
            event(log, "[xray] %s : voix — aucune piste son utilisable", item_id, item=item_id, action="voice_only",
                  outcome="no_audio")
            _report(db, item_id, "voix")
            return "done"
        skips = skips_of(item_id, row)
        todo = db.q("SELECT idx, start, end FROM chunks WHERE item_id=? AND voice=0 ORDER BY idx", (item_id,))
        t0 = time.monotonic()
        event(log, "[xray] %s : voix par le son seul — %d tronçons à lire", item_id, len(todo), item=item_id,
              action="voice_only_start", chunks=len(todo), model=model)
        speech = 0.0
        for r in todo:
            if should_stop():
                event(log, "[xray] %s : voix par le son seul — cède la place à un ordre plus pressé", item_id,
                      item=item_id, action="voice_only_yield")
                return "yield"
            regions: list = []
            wins_l, embs_l = [], []
            for a, b in segments.pieces(r["start"], r["end"], skips):
                pcm = audiomod.read_audio(path, a, b - a, track)
                if len(pcm) < audiomod.SR // 4:
                    continue
                cv = engine.analyse(pcm, a)
                speech += cv.speech_s
                regions += cv.regions
                wins_l.append(cv.wins)
                embs_l.append(cv.embs)
            wins = np.concatenate(wins_l) if wins_l else np.zeros((0, 2))
            embs = np.concatenate(embs_l) if embs_l else np.zeros((0, 256), np.float32)
            if not store_chunk(db, item_id, etag, r["idx"], regions, wins, embs):
                return "yield"
        presence, scenes = presence_of(row)
        res = assemble(db, item_id, etag, model, row["series_id"], tinfo, presence, scenes, final=True)
        event(log, "[xray] %s : voix complétées par le son seul — %d tronçons en %.0f s, %.0f s de parole", item_id,
              len(todo), time.monotonic() - t0, speech, item=item_id, action="voice_only_done", chunks=len(todo),
              seconds=round(time.monotonic() - t0, 1), speechSeconds=round(speech, 1),
              stats=res.stats if res else None)
        _report(db, item_id, "voix")
        return "done"
    except Exception as e:
        db.run("UPDATE items SET voice_error=?, voice_tried=? WHERE item_id=?", (f"{type(e).__name__}: {e}"[:500], time.time(), item_id))
        log.exception("[xray] %s : voix par le son seul en échec", item_id)
        return "failed"


def _report(db: Database, item_id: str, trigger: str) -> None:
    from . import report

    report.save(db, item_id, trigger)
