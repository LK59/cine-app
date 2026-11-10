"""Le rapport de décision d'un élément : ce qui a été fait, avec quoi, et pourquoi.

Une voix restée sans nom, un visage anonyme, une scène coupée là : sans ce rapport, la réponse tenait
dans des lignes de journal éparpillées sur plusieurs passages (analyse, son seul, lecture des lèvres,
renommages) et dans le code du jour. Il est **refait et gardé en base** (`reports`) à chaque fin de
passage qui change le résultat — analyse complète, voix par le son seul, lecture des lèvres,
renommage — et servi par `GET /items/{id}/report` ; une ligne de journal le résume.

Tout ce qu'il dit vient de la base (le résultat, son détail par voix et par groupe de visages, les
tronçons, les faits de l'analyse gardés avec l'ordre, `items.run_json`) et des constantes du code : le
refaire plus tard donne le même rapport. Contenu (voir README, « Journaux et rapport d'analyse ») :
versions du service et des résultats, modèles (fichier, version, SHA-256, précision du détecteur),
périphérique de chaque étape (part des tronçons sur l'iGPU ou le processeur), chemin de décodage,
piste son et pourquoi, seuils en vigueur, plages sautées, comptes, calcul par étape, et **par voix** son
nom, d'où il vient (`via`) ou pourquoi elle n'en a pas (`reason`) ; par groupe de visages, nommé ou
anonyme, avec sa note et sa marge.

Le rapport ne fait jamais échouer ce qui l'appelle : une erreur ici est journalisée, rien de plus.
"""

from __future__ import annotations

import collections
import dataclasses
import datetime as _dt
import json
import logging
import os

import numpy as np

from .config import ASD_VERSION, RESULT_VERSION, VERSION, VOICE_VERSION, settings
from .db import Database
from .logs import event

log = logging.getLogger("xray.report")

REPORT_VERSION = 1
# Groupes de visages détaillés au plus (les nommés, puis les anonymes les plus présents) ; les autres
# sont comptés.
MAX_CLUSTERS = 60
MIN_CLUSTER_SECONDS = 2.0

# Version publiée de chaque fichier de poids (le SHA-256 est celui de `models.py`, `voice.py`, `asd.py`).
FILE_VERSIONS = {
    "det_10g.onnx": "insightface buffalo_l v0.7 (SCRFD-10GF)",
    "w600k_r50.onnx": "insightface buffalo_l v0.7 (ArcFace R50, WebFace600K)",
    "face_detection_yunet_2023mar.onnx": "YuNet 2023mar (opencv_zoo)",
    "glintr100.onnx": "AuraFace-v1",
    "silero_vad.onnx": "Silero VAD v6.2",
    "voxceleb_resnet34_LM.onnx": "WeSpeaker ResNet34-LM @f0c48c2",
    "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx": "3D-Speaker CAM++ (sherpa-onnx)",
    "pretrain_AVA_CVPR.model": "Light-ASD @ed38c23",
}


def commit() -> str | None:
    """Le commit de l'image (`XRAY_COMMIT`, posé à la construction : `--build-arg XRAY_COMMIT=…`)."""
    c = (os.environ.get("XRAY_COMMIT") or "").strip()
    return c[:64] or None


def service_facts() -> dict:
    return {"version": VERSION, "commit": commit(), "resultVersion": RESULT_VERSION, "voiceVersion": VOICE_VERSION,
            "asdVersion": ASD_VERSION, "reportVersion": REPORT_VERSION}


def _file(mf) -> dict:
    return {"file": mf.name, "sha256": mf.sha256, "version": FILE_VERSIONS.get(mf.name)}


def model_inventory(face_model: str | None = None, voice_model: str | None = None) -> dict:
    """Les modèles connus du code : nom, licence, et pour chaque fichier sa version et son SHA-256."""
    from .asd import ASD_FILE, LABEL, LICENSE
    from .models import MODELS
    from .voice import VAD_FILE, VOICE_MODELS

    fname = face_model or settings.model
    face = MODELS.get(fname) or MODELS["buffalo_l"]
    files = {f.name: f for f in face["files"]}
    vname = voice_model or settings.voice_model
    voice = VOICE_MODELS.get(vname) or VOICE_MODELS["wespeaker_r34"]
    return {
        "faces": {"name": fname, "license": face["license"], "detector": _file(files[face["detector"]]),
                  "embedder": _file(files[face["embedder"]])},
        "voice": {"enabled": settings.voice_enabled, "name": vname, "label": voice["label"], "license": voice["license"],
                  "vad": dict(_file(VAD_FILE), license="mit"), "embedder": _file(voice["file"])},
        "asd": {"enabled": settings.asd_enabled and settings.voice_enabled, "name": "light_asd", "label": LABEL,
                "license": LICENSE, **_file(ASD_FILE)},
    }


def startup_summary() -> dict:
    """Les réglages du service, une fois au démarrage (jamais une clé : seulement si elle est posée)."""
    from .relabel import face_thresholds

    cluster_t, label_t = face_thresholds(settings.model)
    return {
        "service": service_facts(),
        "threads": settings.threads, "voiceThreads": settings.voice_threads, "asdThreads": settings.asd_threads,
        "inference": settings.inference, "ovDevice": settings.ov_device, "detectorInt8": settings.detector_int8,
        "hwaccel": settings.hwaccel, "vaapiDevice": settings.vaapi_device, "vaapiNoref": settings.vaapi_noref,
        "incremental": settings.incremental, "voice": settings.voice_enabled, "voiceTrack": settings.voice_track,
        "asd": settings.asd_enabled and settings.voice_enabled, "asdBudgetS": settings.asd_budget_s,
        "sampleFps": settings.sample_fps, "frameWidth": settings.frame_width, "chunkSeconds": settings.chunk_seconds,
        "minFace": settings.min_face, "facesPerTrack": settings.faces_per_track, "embedBatch": settings.embed_batch,
        "clusterThreshold": cluster_t, "labelThreshold": label_t,
        "jellyfin": bool(settings.jellyfin_url), "jellyfinKey": bool(settings.jellyfin_api_key),
        "apiKey": bool(settings.api_key), "dataDir": str(settings.data_dir), "mediaRoot": str(settings.media_root),
        "models": model_inventory(),
    }


def run_facts(models, skip_source: str | None, previous: dict | None = None, engine=None, lane: str | None = None) -> dict:
    """Les faits d'un passage d'analyse de l'image, gardés avec l'ordre (`items.run_json`) : le rapport dit
    ce qui a servi *alors*, pas ce que le service a aujourd'hui."""
    if hasattr(models, "inference_status"):
        status = models.inference_status(engine) if engine is not None else models.inference_status()
    else:
        status = None
    now = _dt.datetime.now().astimezone().isoformat(timespec="seconds")
    prev = previous or {}
    return {
        "service": VERSION, "commit": commit(), "resultVersion": RESULT_VERSION,
        "firstStartedAt": prev.get("firstStartedAt") or now, "lastStartedAt": now, "runs": int(prev.get("runs") or 0) + 1,
        "faceModel": getattr(models, "name", None),
        "inference": status,
        # Fichiers de l'IR INT8 produit sur place (manifeste de `quantize.py`) et leur SHA-256.
        "int8Files": getattr(models, "int8_files", None),
        "hwaccel": settings.hwaccel, "vaapiNoref": settings.vaapi_noref, "sampleFps": settings.sample_fps,
        "chunkSeconds": settings.chunk_seconds, "minFace": settings.min_face,
        "skipSource": skip_source,
        # Voie d'analyse du passage et décision du service (`lanes.py`).
        "lanes": _lane_facts(lane),
    }


def _lane_facts(lane: str | None) -> dict | None:
    try:
        from . import lanes

        return lanes.lane_facts(lane or lanes.PRIMARY)
    except Exception:  # le rapport ne fait jamais échouer l'analyse
        return None


# ---- visages ---------------------------------------------------------------------------------------------

def face_diag(built) -> dict:
    """Par groupe de visages : temps, pistes, nom ou anonyme, note et marge sur le deuxième acteur, bande
    (`sure`, `confirm`, `doubt`) et, anonyme, pourquoi (`doubt_band`, `runner_up_close`, `too_short`,
    `person_taken`, `no_reference`). Seuls les nommés et les anonymes de 2 s au moins sont détaillés."""
    from .cluster import (DOUBT_GAP, DOUBT_MARGIN, DOUBT_MIN_TIME, DOUBT_MIN_TRACKS, SURE_MARGIN,
                          score_matrix)
    from .faces import normalize

    cents = built.centroids
    k = 0 if cents is None else len(cents)
    if k == 0:
        return {"clusters": 0, "named": 0, "namedSeconds": 0.0, "anonymousSeconds": 0.0, "reasons": {},
                "listed": [], "omitted": 0}
    refs = built.refs or []
    T = built.label_threshold if built.label_threshold is not None else 0.30
    ctime = built.cluster_time if built.cluster_time is not None else np.zeros(k)
    ctracks = built.cluster_tracks if built.cluster_tracks is not None else np.zeros(k, dtype=np.int64)
    score = None
    if refs:
        score, _ = score_matrix(normalize(np.asarray(cents, dtype=np.float32)), refs)
    pid_col = {r.person_id: j for j, r in enumerate(refs)}
    rows = []
    reasons: collections.Counter = collections.Counter()
    for i in range(k):
        secs = float(ctime[i])
        asg = built.assignments.get(i)
        r: dict = {"cluster": i, "seconds": round(secs, 1), "tracks": int(ctracks[i]) if i < len(ctracks) else 0,
                   "personId": asg.person_id if asg else None}
        if score is None:
            r["reason"] = "no_reference"
        else:
            row = score[i]
            if asg is not None and asg.person_id in pid_col:
                j = pid_col[asg.person_id]
                sc = float(asg.score)
            else:
                j = int(np.argmax(row))
                sc = float(row[j])
            runner = float(np.delete(row, j).max()) if len(row) > 1 else 0.0
            margin = sc - max(runner, 0.0)
            band = "sure" if sc >= T + SURE_MARGIN else ("confirm" if sc >= T + DOUBT_MARGIN else "doubt")
            r.update(score=round(sc, 3), margin=round(margin, 3), band=band)
            if asg is not None:
                r["confidence"] = round(float(asg.confidence), 3)
            else:
                r["candidate"] = refs[j].person_id
                if band == "doubt":
                    r["reason"] = "doubt_band"
                elif band == "confirm" and margin < DOUBT_GAP:
                    r["reason"] = "runner_up_close"
                elif band == "confirm" and secs < DOUBT_MIN_TIME and r["tracks"] < DOUBT_MIN_TRACKS:
                    r["reason"] = "too_short"
                else:
                    r["reason"] = "person_taken"  # l'acteur est allé à un autre groupe (un à un)
        if r.get("reason"):
            reasons[r["reason"]] += 1
        rows.append(r)
    named = [r for r in rows if r["personId"] is not None]
    anon = sorted((r for r in rows if r["personId"] is None and r["seconds"] >= MIN_CLUSTER_SECONDS),
                  key=lambda r: -r["seconds"])
    listed = sorted(named, key=lambda r: -r["seconds"]) + anon
    listed = listed[: max(MAX_CLUSTERS, len(named))]
    return {
        "clusters": k, "named": len(named),
        "namedSeconds": round(sum(r["seconds"] for r in named), 1),
        "anonymousSeconds": round(sum(r["seconds"] for r in rows if r["personId"] is None), 1),
        "reasons": dict(reasons), "listed": listed, "omitted": k - len(listed),
    }


# ---- seuils ----------------------------------------------------------------------------------------------

def thresholds(face_model: str) -> dict:
    from . import shots
    from .asdjob import DEFAULT as ASD
    from .cluster import (DOUBT_GAP, DOUBT_MARGIN, DOUBT_MIN_TIME, DOUBT_MIN_TRACKS, SECOND_PASS_MIN_TIME,
                          SURE_MARGIN, TWIN_MARGIN)
    from .relabel import face_thresholds
    from .voices import DEFAULT_PARAMS as V

    cluster_t, label_t = face_thresholds(face_model)
    voices = dataclasses.asdict(V)
    asd_votes = {k: voices.pop(k) for k in list(voices) if k.startswith("asd_")}
    return {
        "faces": {"cluster": cluster_t, "label": label_t, "sure": round(label_t + SURE_MARGIN, 3),
                  "confirm": [round(label_t + DOUBT_MARGIN, 3), round(label_t + SURE_MARGIN, 3)],
                  "confirmGap": DOUBT_GAP, "confirmMinSeconds": DOUBT_MIN_TIME, "confirmMinTracks": DOUBT_MIN_TRACKS,
                  "secondPassMinSeconds": SECOND_PASS_MIN_TIME, "twinMargin": TWIN_MARGIN, "minFace": settings.min_face},
        "voices": voices,
        "smallVoice": {"pieces": V.small_voice, "confidence": V.small_conf},
        "asd": {"votes": asd_votes, "selection": dataclasses.asdict(ASD), "budgetS": settings.asd_budget_s},
        "scenes": {"minScene": shots.MIN_SCENE, "maxScene": shots.MAX_SCENE, "similarity": shots.SCENE_SIMILARITY,
                   "similarityWithFace": shots.SCENE_SIMILARITY_WITH_FACE, "lookback": shots.SCENE_LOOKBACK,
                   # Rafale de plans courts gardée en scène (`shots._keep_bursts`) : deux scènes courtes au
                   # moins, contiguës, MIN_SCENE ensemble, deux personnes au moins, dont la part `newPeople`
                   # est nouvelle des deux côtés (dans `peopleWindowS`).
                   "burst": {"minSeconds": shots.MIN_SCENE, "minPeople": 2, "newPeople": shots.BURST_NEW_PEOPLE,
                             "peopleWindowS": shots.BURST_PEOPLE_WINDOW}},
    }


# ---- le rapport ------------------------------------------------------------------------------------------

def _j(raw):
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def _share(n: int, total: int) -> float | None:
    return round(n / total, 3) if total else None


def build(db: Database, item_id: str, trigger: str = "lecture") -> dict | None:
    from .timing import job_stats

    item = db.one("SELECT * FROM items WHERE item_id=?", (item_id,))
    if item is None:
        return None
    res = db.one("SELECT * FROM results WHERE item_id=?", (item_id,))
    vres = db.one("SELECT * FROM voice_results WHERE item_id=?", (item_id,))
    asd = db.one("SELECT * FROM asd_runs WHERE item_id=?", (item_id,))
    run = _j(item["run_json"]) or {}
    face_model = (res["model"] if res is not None else None) or item["model"] or settings.model
    voice_model = (vres["model"] if vres is not None else None) or item["voice_model"] or settings.voice_model

    # Modèles : ceux du code, et ce qui a servi à l'analyse (précision du détecteur, moteur).
    models = model_inventory(face_model, voice_model)
    inf = run.get("inference") or {}
    models["faces"]["detector"]["precision"] = inf.get("detector")
    if inf.get("int8"):
        models["faces"]["detector"]["int8"] = dict(inf["int8"], files=run.get("int8Files"))
    models["faces"]["engine"] = inf.get("engine")

    # Tronçons : décodage et périphérique de l'inférence, tronçon par tronçon.
    chunks = db.q("SELECT idx, start, end, done, decoder, stats, voice FROM chunks WHERE item_id=?", (item_id,))
    done = [c for c in chunks if c["done"]]
    dec = collections.Counter((c["decoder"] or "?") for c in done)
    dev = collections.Counter()
    by_lane = collections.Counter()
    for c in done:
        if c["decoder"] == "skip":
            continue
        st = _j(c["stats"]) or {}
        dev[st.get("device") or "unknown"] += 1
        by_lane[st.get("lane") or "A"] += 1
    analysed = sum(dev.values())
    known_dev = analysed - dev.get("unknown", 0)
    asd_stats = _j(asd["stats_json"]) if asd is not None else None
    devices = {
        "inference": {"setting": inf.get("device") or None, "engine": inf.get("engine"), "detector": inf.get("detector"),
                      "gpuError": inf.get("gpuError"), "chunks": dict(dev),
                      "gpuShare": _share(dev.get("gpu", 0) + dev.get("mixed", 0), known_dev),
                      "cpuShare": _share(dev.get("cpu", 0), known_dev)},
        "decode": {"chunks": dict(dec), "vaapiShare": _share(dec.get("vaapi", 0), sum(n for k, n in dec.items() if k != "skip")),
                   # Images non référencées sautées : toujours sur le processeur, sur l'iGPU selon le réglage.
                   "noref": {"cpu": True, "vaapi": run.get("vaapiNoref")}},
        "voice": {"device": "CPU", "chunks": sum(1 for c in chunks if c["voice"])},
        # Tronçons par voie d'analyse (`lanes.py`) ; avant les voies, tout passait par la voie A.
        "lanes": dict(by_lane),
        "asd": None if not asd_stats else {"decoders": asd_stats.get("decoders"), "inference": asd_stats.get("inference"),
                                           "device": "CPU"},
    }

    # Piste son.
    tinfo = (_j(vres["track_json"]) if vres is not None else None) or _j(item["voice_track_json"])
    audio = None
    if tinfo is not None:
        from .audio import AudioTrack, describe

        t = tinfo.get("track")
        audio = {"reason": tinfo.get("reason"), "originalLanguage": tinfo.get("originalLanguage"),
                 "mode": settings.voice_track,
                 "track": describe(AudioTrack(**t)) if t else None}

    # Plages sautées.
    skips = _j(item["skip_json"])
    skipped = {"source": run.get("skipSource") or ("ordre" if skips else None),
               "ranges": skips or [], "seconds": round(sum(b - a for a, b in skips), 1) if skips else 0.0}

    # Comptes.
    face = _j(res["diag_json"]) if res is not None else None
    fstats = _j(res["stats_json"]) if res is not None else None
    vstats = _j(vres["stats_json"]) if vres is not None else None
    voices = _j(vres["diag_json"]) if vres is not None else None
    scenes = _j(res["scenes_json"]) if res is not None else None
    counts = {
        "chunks": len(chunks), "chunksDone": len(done), "chunksSkipped": dec.get("skip", 0),
        "shots": int(db.one("SELECT COUNT(*) FROM shots WHERE item_id=?", (item_id,))[0]),
        "scenes": len(scenes) if scenes is not None else None,
        "faceTracks": int(db.one("SELECT COUNT(*) FROM tracks WHERE item_id=?", (item_id,))[0]),
        "faceClusters": face["clusters"] if face else None,
        "facesNamed": face["named"] if face else None,
        "faceTimeNamed": (fstats or {}).get("facesNamed"),
    }
    for k in ("voices", "voicesNamed", "voicesUndecided", "voicesConflict", "voicesSmall", "voicesAsd", "speechNamed",
              "pieces", "named", "people", "memory", "asdVotes"):
        if vstats is not None and k in vstats:
            counts[{"pieces": "voicePieces", "named": "voicePiecesNamed", "people": "voicePeople",
                    "memory": "voiceMemory"}.get(k, k)] = vstats[k]
    if asd_stats is not None:
        counts.update(asdTried=asd_stats.get("voicesTried"), asdResolved=asd_stats.get("voicesResolved"),
                      asdWindows=asd_stats.get("windows"), asdVotesCast=asd_stats.get("votes"))
    reasons = collections.Counter(v.get("reason") for v in voices or [] if v.get("reason"))
    vias = collections.Counter(v.get("via") for v in voices or [] if v.get("via"))

    # Calcul.
    js = job_stats(db, item_id, float(item["duration"] or 0.0))
    cpu = {"imageSeconds": js["seconds"], "realtime": js["realtime"], "stages": js["stages"],
           "decodeSeconds": js.get("decodeSeconds"), "skippedSeconds": js.get("skippedSeconds"),
           "voiceAssembleSeconds": (vstats or {}).get("seconds"),
           "asdSeconds": (asd_stats or {}).get("cpuSeconds"), "asdWallSeconds": (asd_stats or {}).get("wallSeconds"),
           "asdCapped": (asd_stats or {}).get("capped")}

    return {
        "reportVersion": REPORT_VERSION,
        "itemId": item_id, "etag": item["etag"], "status": item["status"], "error": item["error"],
        "seriesId": item["series_id"], "path": item["path"],
        "durationS": round(float(item["duration"]), 3) if item["duration"] else None,
        "generatedAt": _dt.datetime.now().astimezone().isoformat(timespec="seconds"), "trigger": trigger,
        "service": dict(service_facts(), analysedWith={"version": run.get("service"), "commit": run.get("commit"),
                                                        "runs": run.get("runs"), "firstStartedAt": run.get("firstStartedAt"),
                                                        "lastStartedAt": run.get("lastStartedAt")}),
        "results": {"scenesVersion": int(res["version"]) if res is not None else None,
                    "scenesComplete": bool(res["complete"]) if res is not None else None,
                    "voicesVersion": int(vres["version"]) if vres is not None else None,
                    "voicesComplete": bool(vres["complete"]) if vres is not None else None,
                    "asd": None if asd is None else {"version": int(asd["version"]), "status": asd["status"]}},
        "models": models,
        "devices": devices,
        "audio": audio,
        "thresholds": thresholds(face_model),
        "skipped": skipped,
        "counts": counts,
        "cpu": cpu,
        "voiceReasons": dict(reasons), "voiceVia": dict(vias),
        "voices": voices,
        "faceClusters": face,
    }


def summary(rep: dict) -> tuple[str, dict]:
    """Une ligne de journal : l'essentiel du rapport."""
    c = rep.get("counts") or {}
    dev = (rep.get("devices") or {}).get("inference") or {}
    dec = (rep.get("devices") or {}).get("decode") or {}
    fields = {
        "action": "report", "trigger": rep.get("trigger"), "scenes": c.get("scenes"), "shots": c.get("shots"),
        "faceClusters": c.get("faceClusters"), "facesNamed": c.get("facesNamed"), "faceTimeNamed": c.get("faceTimeNamed"),
        "voices": c.get("voices"), "voicesNamed": c.get("voicesNamed"), "voicesUndecided": c.get("voicesUndecided"),
        "voicesConflict": c.get("voicesConflict"), "voicesSmall": c.get("voicesSmall"), "voicesAsd": c.get("voicesAsd"),
        "speechNamed": c.get("speechNamed"), "asdTried": c.get("asdTried"), "asdResolved": c.get("asdResolved"),
        "voiceReasons": rep.get("voiceReasons"), "voiceVia": rep.get("voiceVia"),
        "gpuShare": dev.get("gpuShare"), "vaapiShare": dec.get("vaapiShare"),
        "detector": dev.get("detector"), "audioReason": (rep.get("audio") or {}).get("reason"),
        "skippedSeconds": (rep.get("skipped") or {}).get("seconds"),
    }
    # Une partie dont le rapport n'a pas les chiffres est omise : un résultat d'avant le détail des visages,
    # repris par la lecture des lèvres, écrivait « None/None groupes de visages nommés ».
    parts = [f"{c.get('scenes')} scènes" if c.get("scenes") is not None else None]
    if c.get("facesNamed") is not None and c.get("faceClusters") is not None:
        parts.append(f"{c['facesNamed']}/{c['faceClusters']} groupes de visages nommés")
    if c.get("voicesNamed") is not None:
        parts.append(f"voix {c.get('voicesNamed')} nommées / {c.get('voicesUndecided') or 0} indécises / "
                     f"{c.get('voicesConflict') or 0} en désaccord / {c.get('voicesSmall') or 0} petites")
    if c.get("asdTried") is not None:
        parts.append(f"lèvres {c.get('asdResolved') or 0}/{c['asdTried']}")
    msg = f"[xray] {rep.get('itemId')} : rapport ({rep.get('trigger')}) — " + (", ".join(p for p in parts if p) or "vide")
    return msg, {k: v for k, v in fields.items() if v is not None}


def save(db: Database, item_id: str, trigger: str) -> dict | None:
    """Refait le rapport, le garde, le résume au journal. Ne lève jamais."""
    try:
        rep = build(db, item_id, trigger)
        if rep is None:
            return None
        _store(db, rep)
        msg, fields = summary(rep)
        event(log, msg, item=item_id, **fields)
        return rep
    except Exception:
        event(log, "[xray] %s : rapport de décision impossible", item_id, level=logging.ERROR, item=item_id,
              action="report_failed", exc_info=True)
        return None


def _store(db: Database, rep: dict) -> None:
    import time

    with db.tx() as c:
        cur = c.execute("SELECT etag FROM items WHERE item_id=?", (rep["itemId"],)).fetchone()
        if cur is None or cur["etag"] != rep["etag"]:
            return
        c.execute("INSERT OR REPLACE INTO reports (item_id, etag, report_json, updated) VALUES (?, ?, ?, ?)",
                  (rep["itemId"], rep["etag"], json.dumps(rep, separators=(",", ":"), ensure_ascii=False), time.time()))


def get(db: Database, item_id: str) -> dict | None:
    """Le rapport gardé s'il est du fichier du moment ; sinon refait (et gardé si l'élément est fini)."""
    item = db.one("SELECT etag, status FROM items WHERE item_id=?", (item_id,))
    if item is None:
        return None
    row = db.one("SELECT etag, report_json FROM reports WHERE item_id=?", (item_id,))
    if row is not None and row["etag"] == item["etag"]:
        rep = _j(row["report_json"])
        if rep is not None:
            return rep
    rep = build(db, item_id, "lecture")
    if rep is not None and item["status"] == "done":
        try:
            _store(db, rep)
        except Exception:
            log.exception("[xray] %s : rapport non gardé", item_id)
    return rep
