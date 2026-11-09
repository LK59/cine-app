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
from .db import Database
from .gpu_guard import GpuGuard
from .jobs import HEX32, InvalidJob, JobStore, validate_job
from .models import ModelManager
from .timing import job_stats

log = logging.getLogger("xray")


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


def create_app(start_background: bool = True, db: Database | None = None, models: ModelManager | None = None) -> FastAPI:
    state: dict = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        database = db or Database(settings.db_path)
        store = JobStore(database)
        mm = models or ModelManager(settings.model, settings.models_dir)
        guard = GpuGuard()
        state.update(db=database, store=store, models=mm, guard=guard)
        if not settings.api_key:
            log.error("XRAY_API_KEY vide : toutes les requêtes seront refusées")
        if start_background:
            from .worker import Worker

            mm.start()
            guard.start()
            Worker(database, store, mm, guard).start()
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
