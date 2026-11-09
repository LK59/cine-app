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
from .voice import VoiceModels
from . import memory, relabel
from .db import Database
from .gpu_guard import GpuGuard
from .jobs import HEX32, InvalidJob, JobStore, validate_job
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
    rows = db.q("""SELECT i.item_id, i.series_id, r.stats_json AS fstats, v.stats_json AS vstats, v.complete AS vdone
                   FROM items i LEFT JOIN results r ON r.item_id = i.item_id LEFT JOIN voice_results v ON v.item_id = i.item_id
                   WHERE i.status='done'""")
    groups: dict = {}
    for r in rows:
        f = json.loads(r["fstats"]) if r["fstats"] else {}
        v = json.loads(r["vstats"]) if r["vstats"] else {}
        g = groups.setdefault(r["series_id"], {"items": 0, "withVoices": 0, "speech": [], "faceT": 0.0, "faceN": 0.0,
                                                "voicesNamed": 0, "voicesUndecided": 0, "voicesConflict": 0,
                                                "itemsWithConflict": 0})
        g["items"] += 1
        if r["vdone"] and v:
            g["withVoices"] += 1
            if v.get("speechNamed") is not None:
                g["speech"].append(float(v["speechNamed"]))
            for k in ("voicesNamed", "voicesUndecided", "voicesConflict"):
                g[k] += int(v.get(k) or 0)
            g["itemsWithConflict"] += 1 if v.get("voicesConflict") else 0
        if f.get("facesNamed") is not None:
            g["faceT"] += float(f.get("faceSeconds") or 0.0)
            g["faceN"] += float(f["facesNamed"]) * float(f.get("faceSeconds") or 0.0)

    def out(key, g) -> dict:
        return {"seriesId": key, "items": g["items"], "withVoices": g["withVoices"],
                "speechNamed": round(sum(g["speech"]) / len(g["speech"]), 4) if g["speech"] else None,
                "facesNamed": round(g["faceN"] / g["faceT"], 4) if g["faceT"] > 0 else None,
                "voicesNamed": g["voicesNamed"], "voicesUndecided": g["voicesUndecided"],
                "voicesConflict": g["voicesConflict"], "itemsWithConflict": g["itemsWithConflict"]}

    allg = {"items": 0, "withVoices": 0, "speech": [], "faceT": 0.0, "faceN": 0.0, "voicesNamed": 0,
            "voicesUndecided": 0, "voicesConflict": 0, "itemsWithConflict": 0}
    for g in groups.values():
        for k in allg:
            allg[k] = allg[k] + g[k]
    series = [out(k, g) for k, g in groups.items() if k]
    series.sort(key=lambda x: (x["speechNamed"] is None, x["speechNamed"] if x["speechNamed"] is not None else 0, -x["voicesConflict"]))
    return {"overall": out(None, allg), "movies": out(None, groups[None]) if None in groups else None, "series": series}


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
    return {"complete": bool(row["complete"]), **{k: st[k] for k in ("voicesNamed", "voicesUndecided", "voicesConflict", "voicesSmall", "speechNamed") if k in st}}


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
        state.update(db=database, store=store, models=mm, guard=guard, voice=vm)
        if not settings.api_key:
            log.error("XRAY_API_KEY vide : toutes les requêtes seront refusées")
        if start_background:
            from .worker import Worker

            mm.start()
            vm.start()
            guard.start()
            Worker(database, store, mm, guard, vm).start()
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
            "voice": state["voice"].status(),
            "queue": {"pending": store.pending_count(), "running": store.running_id},
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
            return _error(400, str(e))
        status, payload = state["store"].submit(spec)
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
        return {
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
        state["store"].wake()
        return JSONResponse({"queued": n, "pending": relabel.pending(state["db"])}, status_code=202)

    @app.post("/series/{series_id}/relabel")
    async def relabel_series(series_id: str, request: Request):
        if not HEX32.match(series_id):
            return _error(404, "inconnu")
        items = relabel.series_items(state["db"], series_id, await _ids(request))
        n = relabel.enqueue(state["db"], items)
        state["store"].wake()
        return JSONResponse({"queued": n, "items": len(items), "pending": relabel.pending(state["db"])}, status_code=202)

    @app.post("/relabel")
    def relabel_all():
        """Toute la bibliothèque, série par série dans l'ordre des chemins ; servi par lots bornés en temps."""
        ids = [r["item_id"] for r in state["db"].q("SELECT item_id FROM items WHERE status='done' ORDER BY series_id, path")]
        n = relabel.enqueue(state["db"], ids)
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
        log.info("[xray] série %s : mémoire réinitialisée (%d contributions), %d épisodes à renommer", sid, removed, n)
        state["store"].wake()
        return {"removed": removed, "queued": n}

    @app.get("/quality")
    def get_quality():
        return quality(state["db"])

    @app.delete("/items/{item_id}")
    def delete_item(item_id: str):
        if HEX32.match(item_id):
            state["store"].delete(item_id)
        return Response(status_code=204)

    return app


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
# Une ligne par requête sortante (Jellyfin toutes les 30 s, chaque photo) noierait le journal.
logging.getLogger("httpx").setLevel(logging.WARNING)
app = create_app()
