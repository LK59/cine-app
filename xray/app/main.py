"""API HTTP de laterna-xray (contrat v1 avec Laterna ; voir README, « Référence de l'API »)."""

from __future__ import annotations

import hmac
import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from . import decode
from .config import VERSION, settings
from .asd import AsdModels
from .voice import VoiceModels
from . import lanes, logs, memory, relabel, report, scenecuts, subsyncjob
from .db import Database
from .gpu_guard import GpuGuard
from .jobs import HEX32, PRIORITIES, InvalidJob, JobStore, validate_job
from .logs import event
from .models import ModelManager
from .timing import job_stats

log = logging.getLogger("xray")


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def _inference(mm) -> dict:
    status = getattr(mm, "inference_status", None)
    if status is None:
        return {"engine": None, "device": settings.ov_device, "gpu": False, "gpuActive": False, "gpuError": None,
                "detector": "fp32", "int8": {"state": "off", "error": None}}
    return status()


def quality(db) -> dict:
    """La qualité des noms, par série et pour toute la bibliothèque (les films ensemble) : part du temps de
    parole nommée, voix indécises et en désaccord, part du temps de visage nommée. Les séries les moins
    bien nommées d'abord. Seulement les éléments finis."""
    rows = db.q("""SELECT i.item_id, i.series_id, r.stats_json AS fstats, v.stats_json AS vstats, v.complete AS vdone,
                          a.stats_json AS astats
                   FROM items i LEFT JOIN results r ON r.item_id = i.item_id LEFT JOIN voice_results v ON v.item_id = i.item_id
                   LEFT JOIN asd_runs a ON a.item_id = i.item_id AND a.status = 'done'
                   WHERE i.status='done'""")
    groups: dict = {}
    items: list[dict] = []
    for r in rows:
        f = json.loads(r["fstats"]) if r["fstats"] else {}
        v = json.loads(r["vstats"]) if r["vstats"] else {}
        # Ajout compatible (11/2026) : chaque élément, avec le lien de son rapport de décision.
        items.append({"itemId": r["item_id"], "seriesId": r["series_id"],
                      "speechNamed": v.get("speechNamed") if r["vdone"] else None, "facesNamed": f.get("facesNamed"),
                      "voicesNamed": v.get("voicesNamed"), "voicesUndecided": v.get("voicesUndecided"),
                      "voicesConflict": v.get("voicesConflict"), "voicesAsd": v.get("voicesAsd"),
                      "reportUrl": f"/items/{r['item_id']}/report"})
        g = groups.setdefault(r["series_id"], {"items": 0, "withVoices": 0, "speech": [], "faceT": 0.0, "faceN": 0.0,
                                                "voicesNamed": 0, "voicesUndecided": 0, "voicesConflict": 0,
                                                "itemsWithConflict": 0, "voicesAsd": 0, "asdItems": 0, "asdTried": 0,
                                                "asdResolved": 0, "asdCpu": 0.0})
        g["items"] += 1
        if r["vdone"] and v:
            g["withVoices"] += 1
            if v.get("speechNamed") is not None:
                g["speech"].append(float(v["speechNamed"]))
            for k in ("voicesNamed", "voicesUndecided", "voicesConflict"):
                g[k] += int(v.get(k) or 0)
            g["itemsWithConflict"] += 1 if v.get("voicesConflict") else 0
            g["voicesAsd"] += int(v.get("voicesAsd") or 0)
        a = json.loads(r["astats"]) if r["astats"] else None
        if a:
            g["asdItems"] += 1
            g["asdTried"] += int(a.get("voicesTried") or 0)
            g["asdResolved"] += int(a.get("voicesResolved") or 0)
            g["asdCpu"] += float(a.get("cpuSeconds") or 0.0)
        if f.get("facesNamed") is not None:
            g["faceT"] += float(f.get("faceSeconds") or 0.0)
            g["faceN"] += float(f["facesNamed"]) * float(f.get("faceSeconds") or 0.0)

    def out(key, g) -> dict:
        return {"seriesId": key, "items": g["items"], "withVoices": g["withVoices"],
                "speechNamed": round(sum(g["speech"]) / len(g["speech"]), 4) if g["speech"] else None,
                "facesNamed": round(g["faceN"] / g["faceT"], 4) if g["faceT"] > 0 else None,
                "voicesNamed": g["voicesNamed"], "voicesUndecided": g["voicesUndecided"],
                "voicesConflict": g["voicesConflict"], "itemsWithConflict": g["itemsWithConflict"],
                # Lecture des lèvres (11/2026) : voix nommées par elle, éléments lus, voix tentées et résolues,
                # calcul dépensé.
                "voicesAsd": g["voicesAsd"],
                "asd": {"items": g["asdItems"], "tried": g["asdTried"], "resolved": g["asdResolved"],
                        "cpuSeconds": round(g["asdCpu"], 1)}}

    allg = {"items": 0, "withVoices": 0, "speech": [], "faceT": 0.0, "faceN": 0.0, "voicesNamed": 0,
            "voicesUndecided": 0, "voicesConflict": 0, "itemsWithConflict": 0, "voicesAsd": 0, "asdItems": 0,
            "asdTried": 0, "asdResolved": 0, "asdCpu": 0.0}
    for g in groups.values():
        for k in allg:
            allg[k] = allg[k] + g[k]
    series = [out(k, g) for k, g in groups.items() if k]
    series.sort(key=lambda x: (x["speechNamed"] is None, x["speechNamed"] if x["speechNamed"] is not None else 0, -x["voicesConflict"]))
    items.sort(key=lambda x: (x["speechNamed"] is None, x["speechNamed"] if x["speechNamed"] is not None else 0,
                              -(x["voicesConflict"] or 0), x["itemId"]))
    return {"overall": out(None, allg), "movies": out(None, groups[None]) if None in groups else None, "series": series,
            "items": items}


def _face_state(db, item_id: str) -> dict | None:
    row = db.one("SELECT stats_json FROM results WHERE item_id=?", (item_id,))
    if row is None or not row["stats_json"]:
        return None
    return json.loads(row["stats_json"])


def _voice_state(db, item_id: str) -> dict | None:
    row = db.one("SELECT complete, stats_json FROM voice_results WHERE item_id=?", (item_id,))
    if row is None:
        return None
    st = json.loads(row["stats_json"]) if row["stats_json"] else {}
    out = {"complete": bool(row["complete"]), **{k: st[k] for k in ("voicesNamed", "voicesUndecided", "voicesConflict", "voicesSmall", "speechNamed", "voicesAsd") if k in st}}
    a = db.one("SELECT status, stats_json FROM asd_runs WHERE item_id=?", (item_id,))
    if a is not None:
        out["asd"] = dict(json.loads(a["stats_json"]) if a["stats_json"] else {}, status=a["status"])
    return out


def create_app(start_background: bool = True, db: Database | None = None, models: ModelManager | None = None,
               voice_models: VoiceModels | None = None) -> FastAPI:
    state: dict = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        database = db or Database(settings.db_path)
        store = JobStore(database)
        mm = models or ModelManager(settings.model, settings.models_dir)
        guard = GpuGuard()
        vm = voice_models or VoiceModels(settings.voice_model, settings.models_dir, settings.voice_enabled)
        am = AsdModels(settings.models_dir, settings.asd_enabled and settings.voice_enabled)
        state.update(db=database, store=store, models=mm, guard=guard, voice=vm, asd=am)
        subsyncjob.reset_running(database)
        try:
            event(log, "démarrage de laterna-xray %s", VERSION, action="startup", journal=str(log_path) if log_path else None,
                  **report.startup_summary())
        except Exception:
            log.exception("résumé de démarrage impossible")
        if not settings.api_key:
            log.error("XRAY_API_KEY vide : toutes les requêtes seront refusées")
        if start_background:
            from .worker import Worker

            mm.start()
            vm.start()
            am.start()
            guard.start()
            # Voies d'analyse (`lanes.py`) : décidées une fois, journalisées (`action: "lanes"`).
            plan = lanes.plan()
            primary = Worker(database, store, mm, guard, vm, am, lane=lanes.PRIMARY,
                             decode_threads=plan.a_decode_threads)
            primary.start()
            workers = [primary]
            if plan.count >= 2:
                second = Worker(database, store, mm, guard, vm, am, lane=lanes.CPU_LANE, cpu_only=True,
                                threads=plan.b_threads)
                second.start()
                workers.append(second)
            state["workers"] = workers
            # Premier essai du périphérique tout de suite : /health le dit dès le démarrage.
            decode.vaapi_available(force=True)
        yield

    app = FastAPI(title="laterna-xray", version=VERSION, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def auth(request: Request, call_next):
        # Toute requête, /health compris, porte la clé partagée. Comparaison en temps constant ;
        # une clé vide côté service refuse tout plutôt que de tout ouvrir.
        header = request.headers.get("authorization", "")
        key = settings.api_key
        given = header[7:] if header[:7].lower() == "bearer " else ""
        if not key or not hmac.compare_digest(given.encode("utf-8"), key.encode("utf-8")):
            return _error(401, "clé d'accès invalide")
        return await call_next(request)

    @app.get("/health")
    def health():
        mm: ModelManager = state["models"]
        store: JobStore = state["store"]
        vaapi = decode.vaapi_available()
        return {
            "ok": True,
            "version": VERSION,
            "model": {"name": mm.name, "ready": bool(mm.ready), "license": mm.license, "error": mm.error},
            "decode": {"vaapi": vaapi, "device": settings.vaapi_device if vaapi else None},
            # Ajout compatible (11/2026) : où et en quelle précision tourne l'inférence.
            "inference": _inference(mm),
            # Ajout compatible (11/2026) : « qui parle » — modèle d'empreinte de voix, détection de parole.
            "voice": dict(state["voice"].status(), asd=state["asd"].status()),
            "queue": {"pending": store.pending_count(), "running": store.running_id,
                      # Ajout compatible (11/2026) : élément en cours par voie, et voies en pause.
                      "lanes": store.running_ids(),
                      "paused": [w.lane for w in state.get("workers", []) if getattr(w, "paused", False)]},
            # Ajout compatible (11/2026) : la décision des voies d'analyse (`lanes.py`).
            "lanes": lanes.plan().as_dict(),
            # Ajout compatible (11/2026) : la synchro des sous-titres — ordres en file ou en cours.
            "subsync": {"pending": subsyncjob.pending_count(state["db"]), "version": subsyncjob.subsync.ALGO_VERSION},
        }

    @app.post("/jobs")
    async def post_job(request: Request):
        try:
            body = json.loads(await request.body() or b"null")
        except (ValueError, UnicodeDecodeError):
            return _error(400, "JSON invalide")
        try:
            spec = validate_job(body, settings.media_root)
        except InvalidJob as e:
            item = body.get("itemId") if isinstance(body, dict) and isinstance(body.get("itemId"), str) else None
            event(log, "ordre refusé : %s", e, level=logging.WARNING, item=item if item and HEX32.match(item) else None,
                  action="job_refused", error=str(e))
            return _error(400, str(e))
        status, payload = state["store"].submit(spec)
        names = {v: k for k, v in PRIORITIES.items()}
        event(log, "[xray] %s : ordre reçu (%s) — %s", spec.item_id, names.get(spec.priority), payload.get("status"),
              item=spec.item_id, action="job_received", priority=names.get(spec.priority), startAt=spec.start_at,
              skip=None if spec.skip is None else [[a, b] for a, b in spec.skip],
              originalLanguage=spec.original_language, seriesId=spec.series_id, cast=len(spec.cast),
              photos=sum(len(m.photos) for m in spec.cast), rebindDuration=spec.rebind_duration, path=spec.path,
              etag=spec.etag, http=status, status=payload.get("status"), position=payload.get("position"))
        return JSONResponse(payload, status_code=status)

    @app.get("/items/{item_id}")
    def get_item(item_id: str):
        if not HEX32.match(item_id):
            return _error(404, "inconnu")
        store: JobStore = state["store"]
        row = store.get(item_id)
        if row is None:
            return _error(404, "inconnu")
        res = state["db"].one("SELECT progress, analyzed_until FROM results WHERE item_id=?", (row["item_id"],))
        status = row["status"]
        stats = job_stats(state["db"], row["item_id"], float(row["duration"] or 0.0))
        return {
            "itemId": row["item_id"],
            "etag": row["etag"],
            "status": status,
            "progress": 1.0 if status == "done" else (float(res["progress"]) if res else 0.0),
            "analyzedUntil": float(res["analyzed_until"]) if res else 0.0,
            "error": row["error"],
            # Durée du fichier lue par ffprobe (ajout compatible) ; null tant que l'analyse n'a pas commencé.
            "durationS": round(float(row["duration"]), 3) if row["duration"] else None,
            # Ajout compatible (11/2026) : où le temps est passé, tronçons faits jusqu'ici.
            "stats": stats if stats["seconds"] else None,
            # Ajout compatible (11/2026) : où en sont les voix — voix nommées, indécises, en désaccord.
            "voices": _voice_state(state["db"], row["item_id"]),
            # Ajout compatible (11/2026) : part du temps de visage nommée.
            "faces": _face_state(state["db"], row["item_id"]),
        }

    @app.get("/items/{item_id}/scenes")
    def get_scenes(item_id: str):
        if not HEX32.match(item_id):
            return _error(404, "inconnu")
        res = state["db"].one("SELECT * FROM results WHERE item_id=?", (item_id.lower(),))
        if res is None:
            return _error(404, "aucun résultat")
        body = {
            "itemId": res["item_id"],
            "etag": res["etag"],
            "model": res["model"],
            # La version qui a produit *ce* résultat : un résultat ancien reste servi (il reste
            # valable) ; Laterna peut le redemander (DELETE puis ordre) s'il veut les nouvelles règles.
            "version": int(res["version"]),
            "complete": bool(res["complete"]),
            "analyzedUntil": float(res["analyzed_until"]),
            "scenes": json.loads(res["scenes_json"]),
        }
        # Ajout compatible (10/11/2026, scenecuts.py) : pour un résultat complet déjà mesuré, le point d'entrée
        # et le verdict de chaque début de scène (`entry`, `cut`), la part de parole et les chapitres. Les
        # scènes et leurs personnes restent exactement ce qu'elles étaient ; sans mesure, rien n'est ajouté.
        extra = scenecuts.annotate(state["db"], res)
        if extra is not None:
            for scene, more in zip(body["scenes"], extra["scenes"]):
                if more is not None:
                    scene.update(more)
            body["speechShare"] = extra["speechShare"]
            body["chapters"] = extra["chapters"]
            body["cutsVersion"] = extra["cutsVersion"]
        return body

    @app.get("/items/{item_id}/report")
    def get_report(item_id: str):
        """Le rapport de décision (report.py) : modèles et versions, périphériques, piste son, seuils, plages
        sautées, comptes, et par voix son nom et d'où il vient, ou pourquoi elle n'en a pas."""
        if not HEX32.match(item_id):
            return _error(404, "inconnu")
        rep = report.get(state["db"], item_id.lower())
        if rep is None:
            return _error(404, "inconnu")
        return rep

    @app.get("/items/{item_id}/voices")
    def get_voices(item_id: str):
        """« Qui parle » : les segments de parole, chacun avec sa voix et, quand elle est nommée, la
        personne (`personId` de la distribution) et une confiance. `conflict` : visages et mémoire de la
        série en désaccord, la voix reste sans nom. Laterna aligne lui-même ses répliques."""
        if not HEX32.match(item_id):
            return _error(404, "inconnu")
        res = state["db"].one("SELECT * FROM voice_results WHERE item_id=?", (item_id.lower(),))
        if res is None:
            return _error(404, "aucun résultat")
        track = json.loads(res["track_json"]) if res["track_json"] else None
        t = (track or {}).get("track")
        return {
            "itemId": res["item_id"],
            "etag": res["etag"],
            "model": res["model"],
            "version": int(res["version"]),
            "complete": bool(res["complete"]),
            "analyzedUntil": float(res["analyzed_until"]),
            "track": None if t is None else {
                "index": t["index"], "language": t["language"] or None, "title": t["title"] or None,
                "channels": t["channels"], "reason": track.get("reason"),
            },
            "stats": json.loads(res["stats_json"]) if res["stats_json"] else None,
            "segments": json.loads(res["segments_json"]),
        }

    # ---- renommer sans relire, mémoire des séries, qualité (11/2026) ------------------------------

    async def _ids(request: Request) -> list[str] | None:
        try:
            body = json.loads(await request.body() or b"null")
        except (ValueError, UnicodeDecodeError):
            return None
        ids = body.get("itemIds") if isinstance(body, dict) else None
        if not isinstance(ids, list):
            return None
        return [i for i in ids if isinstance(i, str) and HEX32.match(i)][:2000]

    @app.post("/items/{item_id}/relabel")
    def relabel_one(item_id: str):
        if not HEX32.match(item_id):
            return _error(404, "inconnu")
        row = state["store"].get(item_id)
        if row is None:
            return _error(404, "inconnu")
        if row["status"] != "done":
            return _error(409, "analyse pas finie")
        n = relabel.enqueue(state["db"], [row["item_id"]])
        event(log, "[xray] %s : renommage demandé", row["item_id"], item=row["item_id"], action="relabel_requested",
              queued=n)
        state["store"].wake()
        return JSONResponse({"queued": n, "pending": relabel.pending(state["db"])}, status_code=202)

    @app.post("/series/{series_id}/relabel")
    async def relabel_series(series_id: str, request: Request):
        if not HEX32.match(series_id):
            return _error(404, "inconnu")
        items = relabel.series_items(state["db"], series_id, await _ids(request))
        n = relabel.enqueue(state["db"], items)
        event(log, "série %s : renommage demandé (%d épisodes, %d mis en file)", series_id.lower(), len(items), n,
              action="relabel_requested", seriesId=series_id.lower(), items=len(items), queued=n)
        state["store"].wake()
        return JSONResponse({"queued": n, "items": len(items), "pending": relabel.pending(state["db"])}, status_code=202)

    @app.post("/relabel")
    def relabel_all():
        """Toute la bibliothèque, série par série dans l'ordre des chemins ; servi par lots bornés en temps."""
        ids = [r["item_id"] for r in state["db"].q("SELECT item_id FROM items WHERE status='done' ORDER BY series_id, path")]
        n = relabel.enqueue(state["db"], ids)
        event(log, "bibliothèque : renommage demandé (%d éléments, %d mis en file)", len(ids), n,
              action="relabel_requested", scope="all", items=len(ids), queued=n)
        state["store"].wake()
        return JSONResponse({"queued": n, "pending": relabel.pending(state["db"])}, status_code=202)

    @app.get("/relabel")
    def relabel_state():
        return {"pending": relabel.pending(state["db"])}

    @app.get("/series/{series_id}/memory")
    def series_memory(series_id: str):
        if not HEX32.match(series_id):
            return _error(404, "inconnu")
        return {"seriesId": series_id.lower(), "entries": memory.provenance(state["db"], series_id.lower())}

    @app.post("/series/{series_id}/memory/reset")
    async def series_memory_reset(series_id: str, request: Request):
        """Efface la mémoire de la série (visages et voix), puis la renomme dans l'ordre des épisodes."""
        if not HEX32.match(series_id):
            return _error(404, "inconnu")
        sid = series_id.lower()
        removed = memory.reset(state["db"], sid)
        items = relabel.series_items(state["db"], sid, await _ids(request))
        n = relabel.enqueue(state["db"], items)
        event(log, "[xray] série %s : mémoire réinitialisée (%d contributions), %d épisodes à renommer", sid, removed, n,
              action="memory_reset", seriesId=sid, removed=removed, queued=n, items=len(items))
        state["store"].wake()
        return {"removed": removed, "queued": n}

    @app.get("/quality")
    def get_quality():
        return quality(state["db"])

    # ---- synchro des sous-titres (11/2026, subsyncjob.py) -----------------------------------------------

    @app.post("/subsync/jobs")
    async def post_subsync_job(request: Request):
        """Mesurer les sous-titres texte d'un élément (ceux du conteneur, et les fichiers à côté dont Laterna donne
        les chemins). Seulement à la demande d'un administrateur, côté Laterna ; jamais de soi-même."""
        try:
            body = json.loads(await request.body() or b"null")
        except (ValueError, UnicodeDecodeError):
            return _error(400, "JSON invalide")
        try:
            spec = subsyncjob.validate(body, settings.media_root)
        except InvalidJob as e:
            item = body.get("itemId") if isinstance(body, dict) and isinstance(body.get("itemId"), str) else None
            event(log, "ordre de synchro refusé : %s", e, level=logging.WARNING,
                  item=item if item and HEX32.match(item) else None, action="subsync_refused", error=str(e))
            return _error(400, str(e))
        status, payload = subsyncjob.submit(state["db"], spec)
        names = {v: k for k, v in PRIORITIES.items()}
        event(log, "[xray] %s : ordre de synchro des sous-titres reçu (%s) — %s", spec.item_id, names.get(spec.priority),
              payload.get("status"), item=spec.item_id, action="subsync_received", priority=names.get(spec.priority),
              externals=len(spec.externals), force=spec.force, path=spec.path, etag=spec.etag, http=status,
              status=payload.get("status"), position=payload.get("position"))
        state["store"].wake()
        return JSONResponse(payload, status_code=status)

    @app.get("/subsync/results")
    def get_subsync_results(itemId: str | None = None, since: float | None = None):
        """Les ordres et mesures : `?itemId=a,b,…` (200 au plus), ou `?since=<epoch>` (ce qui a bougé depuis). Un
        élément inconnu se lit `status: "unknown"` dans la liste — jamais un 404."""
        if itemId is not None:
            ids = [i for i in itemId.split(",") if HEX32.match(i)][:200]
            return subsyncjob.results(state["db"], ids)
        if since is not None and since == since:
            return subsyncjob.results(state["db"], None, max(0.0, float(since)))
        return _error(400, "itemId ou since attendu")

    @app.delete("/items/{item_id}")
    def delete_item(item_id: str):
        if HEX32.match(item_id):
            known = state["store"].get(item_id) is not None
            state["store"].delete(item_id)
            if known:
                event(log, "[xray] %s : ordre et résultats oubliés (DELETE)", item_id.lower(), item=item_id.lower(),
                      action="item_deleted")
        return Response(status_code=204)

    return app


# Sortie standard et `XRAY_DATA_DIR/logs/xray.log` (JSON, tournant) : voir logs.py.
log_path = logs.setup(settings.data_dir / "logs")
app = create_app()
