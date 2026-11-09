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
RESULT_VERSION = 1


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
