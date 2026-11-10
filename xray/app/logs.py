"""Le journal du service : une ligne JSON par événement, gardée dans le volume de données.

`docker logs` meurt avec le conteneur, recréé à chaque déploiement : une analyse ratée la nuit n'y était
plus le matin. Chaque appel de journal (`logging`, tous modules) va donc aussi dans
`<XRAY_DATA_DIR>/logs/xray.log` — un objet JSON par ligne : `ts`, `level`, `scope` (le module), `msg`,
`itemId` quand l'événement concerne un élément, les champs structurés de l'événement (`event(…)`), et
`error`/`stack` pour une exception. Rotation à 5 Mo, cinq archives (`xray.log.1` la plus récente …
`.5`). La sortie standard garde sa ligne lisible, champs structurés en fin de ligne.

**Aucun secret n'en sort** : la clé partagée avec Laterna, la clé Jellyfin et toute variable
d'environnement dont le nom dit une clé, un jeton, un secret ou un mot de passe sont remplacées par
`«secret»` dans chaque ligne écrite (fichier et sortie standard), ainsi que ce qui suit `Bearer ` ou
`Token="`. Le contenu des fichiers n'est jamais journalisé ; les chemins le sont.
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
import logging.handlers
import os
import re
import sys
import threading
from contextlib import contextmanager
from pathlib import Path

LOG_NAME = "xray.log"
MAX_BYTES = 5 * 1024 * 1024
BACKUPS = 5
MASK = "«secret»"

# « [xray] <itemId> : … » — la forme des lignes de l'ouvrier : l'élément est repris sans rien changer à
# leurs appels.
_ITEM_IN_MSG = re.compile(r"^\[xray\] ([0-9a-f]{32})\b")
_SECRET_NAME = re.compile(r"(KEY|TOKEN|SECRET|PASSW)", re.I)
_PATTERNS = (
    (re.compile(r"(?i)(bearer\s+)[^\s\"',;]+"), r"\1" + MASK),
    (re.compile(r"(?i)(token=\\?\")[^\"\\]*"), r"\1" + MASK),
    (re.compile(r"(?i)(api_?key=)[^&\s\"']+"), r"\1" + MASK),
)
_MARK = "_xray_handler"

# La voie d'analyse du fil qui écrit (`lanes.py`) : posée par chaque voie pour tout son fil, et par le fil
# des voix le temps d'un tronçon. Chaque ligne la porte (`lane`), sans rien changer aux appels.
_lane = threading.local()


def set_lane(lane: str | None) -> None:
    _lane.value = lane


def current_lane() -> str | None:
    return getattr(_lane, "value", None)


@contextmanager
def lane_scope(lane: str | None):
    prev = current_lane()
    set_lane(lane)
    try:
        yield
    finally:
        set_lane(prev)


_base_factory = logging.getLogRecordFactory()


def _record_factory(*args, **kwargs):
    rec = _base_factory(*args, **kwargs)
    rec.lane = current_lane()
    return rec


logging.setLogRecordFactory(_record_factory)


def secret_values() -> list[str]:
    """Les valeurs à ne jamais écrire, relues à chaque ligne (une variable posée en cours de route compte)."""
    vals: set[str] = set()
    for k, v in os.environ.items():
        if v and len(v) >= 6 and _SECRET_NAME.search(k):
            vals.add(v)
    try:
        from .config import settings

        for v in (settings.api_key, settings.jellyfin_api_key):
            if v and len(v) >= 4:
                vals.add(v)
    except Exception:  # le journal ne tombe jamais pour ça
        pass
    return sorted(vals, key=len, reverse=True)


def redact(text: str) -> str:
    for v in secret_values():
        if v in text:
            text = text.replace(v, MASK)
        # Sa forme échappée dans une chaîne JSON (guillemets, barres obliques inverses).
        esc = json.dumps(v, ensure_ascii=False)[1:-1]
        if esc != v and esc in text:
            text = text.replace(esc, MASK)
    for rx, rep in _PATTERNS:
        text = rx.sub(rep, text)
    return text


def _scope(name: str) -> str:
    if name == "xray":
        return "api"
    return name[5:] if name.startswith("xray.") else name


def _default(o):
    try:
        import numpy as np

        if isinstance(o, np.generic):
            return o.item()
        if isinstance(o, np.ndarray):
            return o.tolist()
    except ImportError:
        pass
    if isinstance(o, (set, frozenset, tuple)):
        return list(o)
    return str(o)


def item_of(record: logging.LogRecord) -> str | None:
    item = getattr(record, "item_id", None)
    if item:
        return str(item)
    m = _ITEM_IN_MSG.match(record.getMessage())
    return m.group(1) if m else None


class JsonFormatter(logging.Formatter):
    """Une ligne JSON par enregistrement, nettoyée de tout secret."""

    def format(self, record: logging.LogRecord) -> str:
        d: dict = {
            "ts": _dt.datetime.fromtimestamp(record.created).astimezone().isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(),
            "scope": _scope(record.name),
            "msg": record.getMessage(),
        }
        item = item_of(record)
        if item:
            d["itemId"] = item
        lane = getattr(record, "lane", None)
        if lane:
            d["lane"] = lane
        fields = getattr(record, "fields", None)
        if isinstance(fields, dict):
            for k, v in fields.items():
                if v is not None and k not in d:
                    d[k] = v
        if record.exc_info and record.exc_info[1] is not None:
            e = record.exc_info[1]
            d["error"] = f"{type(e).__name__}: {e}"[:1000]
            d["stack"] = self.formatException(record.exc_info)
        elif record.exc_text:
            d["stack"] = record.exc_text
        if record.stack_info:
            d["stack"] = self.formatStack(record.stack_info)
        d["thread"] = record.threadName
        try:
            line = json.dumps(d, ensure_ascii=False, default=_default)
        except (TypeError, ValueError):
            d = {k: (v if isinstance(v, (str, int, float, bool)) or v is None else str(v)) for k, v in d.items()}
            line = json.dumps(d, ensure_ascii=False)
        return redact(line)


class TextFormatter(logging.Formatter):
    """La ligne lisible d'avant (`docker logs`), les champs structurés à la fin, nettoyée de tout secret."""

    def __init__(self) -> None:
        super().__init__("%(asctime)s %(levelname)s %(name)s %(message)s")

    def format(self, record: logging.LogRecord) -> str:
        line = super().format(record)
        fields = getattr(record, "fields", None)
        lane = getattr(record, "lane", None)
        if lane:
            fields = dict(fields or {}, lane=lane) if not (isinstance(fields, dict) and "lane" in fields) else fields
        if isinstance(fields, dict) and fields:
            try:
                extra = json.dumps({k: v for k, v in fields.items() if v is not None}, ensure_ascii=False,
                                   default=_default, separators=(",", ":"))
            except (TypeError, ValueError):
                extra = str(fields)
            if len(extra) > 2000:
                extra = extra[:2000] + "…"
            line = f"{line} {extra}"
        return redact(line)


def file_handler(log_dir: Path, max_bytes: int = MAX_BYTES, backups: int = BACKUPS) -> logging.Handler:
    log_dir.mkdir(parents=True, exist_ok=True)
    h = logging.handlers.RotatingFileHandler(log_dir / LOG_NAME, maxBytes=max_bytes, backupCount=backups,
                                             encoding="utf-8", delay=False)
    h.setFormatter(JsonFormatter())
    setattr(h, _MARK, True)
    return h


def setup(log_dir: Path | None, max_bytes: int = MAX_BYTES, backups: int = BACKUPS, level: int = logging.INFO) -> Path | None:
    """Installe (ou réinstalle) la sortie standard et le fichier. Rend le chemin du fichier, ou None si le
    dossier n'est pas inscriptible (le service tourne alors avec la seule sortie standard, et le dit)."""
    root = logging.getLogger()
    for h in list(root.handlers):
        if getattr(h, _MARK, False):
            root.removeHandler(h)
            h.close()
    uv = logging.getLogger("uvicorn.error")
    for h in list(uv.handlers):
        if getattr(h, _MARK, False):
            uv.removeHandler(h)
            h.close()
    root.setLevel(level)
    out = logging.StreamHandler(sys.stderr)
    out.setFormatter(TextFormatter())
    setattr(out, _MARK, True)
    root.addHandler(out)
    # Une ligne par requête sortante (Jellyfin toutes les 30 s, chaque photo) noierait le journal.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    path = None
    if log_dir is not None:
        try:
            fh = file_handler(Path(log_dir), max_bytes, backups)
            root.addHandler(fh)
            # uvicorn configure ses journaux avant d'importer l'application, sans les faire remonter :
            # une exception dans une route n'arrivait qu'à `docker logs`.
            if not logging.getLogger("uvicorn").propagate:
                uv.addHandler(fh)
            path = Path(log_dir) / LOG_NAME
        except OSError as e:
            root.warning("journal %s inscriptible impossible (%s) : sortie standard seule", log_dir, type(e).__name__)
    return path


def event(logger: logging.Logger, msg: str, *args, level: int = logging.INFO, item: str | None = None,
          exc_info=None, **fields) -> None:
    """Un événement : message lisible et champs structurés (`extra`), l'élément à part."""
    logger.log(level, msg, *args, extra={"item_id": item, "fields": fields}, exc_info=exc_info)
