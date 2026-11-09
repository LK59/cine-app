"""Réglages du service, lus une fois dans l'environnement.

Tout est surchargeable par variable d'environnement : le service est un conteneur
qu'on règle depuis son `docker-compose.yml`, jamais en éditant le code.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

VERSION = "1.0.0"
# Version du format et de l'algorithme des résultats (`version` de /scenes). À monter quand
# un changement rend les anciens résultats incomparables : Laterna peut alors les redemander.
# Chaque résultat garde la version qui l'a produit : un résultat ancien reste servi tel quel (il
# reste valable), et rien n'est réanalysé de soi-même ; un ordre commencé sous une version
# antérieure et pas fini repart de zéro, pour ne jamais mêler deux règles dans un résultat.
#   1 — première version.
#   2 — (09/11/2026) bande de noms « à confirmer » 0,345–0,40, scènes de 3 min au plus, HDR adapté ;
#       déployée vingt minutes sans la coupe « à contraste égal », d'où :
#   3 — (09/11/2026) la même, plus la coupe à contraste égal (décors sombres d'une seule teinte).
RESULT_VERSION = 3


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


@dataclass
class Settings:
    api_key: str = field(default_factory=lambda: os.environ.get("XRAY_API_KEY", ""))
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("XRAY_DATA_DIR", "/data")))
    # La médiathèque est montée au chemin même où Jellyfin la voit : Laterna envoie le chemin
    # de Jellyfin tel quel, sans table de correspondance à tenir à jour de part et d'autre.
    media_root: Path = field(default_factory=lambda: Path(os.environ.get("XRAY_MEDIA_ROOT", "/media")))
    model: str = field(default_factory=lambda: os.environ.get("XRAY_MODEL", "buffalo_l").strip().lower())
    threads: int = field(default_factory=lambda: max(1, _int("XRAY_THREADS", 4)))
    # Moteur d'inférence : auto (OpenVINO s'il se charge, ONNX Runtime sinon), openvino, onnxruntime.
    inference: str = field(default_factory=lambda: os.environ.get("XRAY_INFERENCE", "auto").strip().lower())
    # Visages empreintés par lot (un appel du réseau), et au plus par piste (les meilleurs).
    embed_batch: int = field(default_factory=lambda: max(1, _int("XRAY_EMBED_BATCH", 32)))
    faces_per_track: int = field(default_factory=lambda: max(1, _int("XRAY_FACES_PER_TRACK", 2)))
    vaapi_device: str = field(default_factory=lambda: os.environ.get("XRAY_VAAPI_DEVICE", "/dev/dri/renderD128"))
    # « 0 » coupe l'accélération matérielle (décodage toujours sur le processeur).
    hwaccel: bool = field(default_factory=lambda: os.environ.get("XRAY_HWACCEL", "1") not in ("0", "false", "no"))
    ffmpeg: str = field(default_factory=lambda: os.environ.get("XRAY_FFMPEG", "ffmpeg"))
    ffprobe: str = field(default_factory=lambda: os.environ.get("XRAY_FFPROBE", "ffprobe"))
    jellyfin_url: str = field(default_factory=lambda: os.environ.get("JELLYFIN_URL", "").rstrip("/"))
    jellyfin_api_key: str = field(default_factory=lambda: os.environ.get("JELLYFIN_API_KEY", ""))
    # Échantillonnage du flux réduit : assez pour placer une coupe à un quart de seconde près,
    # assez peu pour que la conversion en Python reste négligeable devant le décodage.
    sample_fps: float = field(default_factory=lambda: _float("XRAY_SAMPLE_FPS", 4.0))
    frame_width: int = field(default_factory=lambda: _int("XRAY_FRAME_WIDTH", 640))
    # Longueur d'un tronçon : l'unité de travail, de reprise après redémarrage et de résultat partiel.
    chunk_seconds: float = field(default_factory=lambda: _float("XRAY_CHUNK_SECONDS", 120.0))
    # Plus petit côté d'un visage retenu pour l'identification (pixels, à 640 de large).
    min_face: int = field(default_factory=lambda: _int("XRAY_MIN_FACE", 36))
    # Seuils de similarité cosinus. Laisser vides = valeur propre au modèle (voir faces.MODEL_DEFAULTS).
    cluster_threshold: float | None = field(default_factory=lambda: _opt_float("XRAY_CLUSTER_THRESHOLD"))
    label_threshold: float | None = field(default_factory=lambda: _opt_float("XRAY_LABEL_THRESHOLD"))

    @property
    def db_path(self) -> Path:
        return self.data_dir / "xray.db"

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def photos_dir(self) -> Path:
        return self.data_dir / "photos"


def _opt_float(name: str) -> float | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


settings = Settings()
