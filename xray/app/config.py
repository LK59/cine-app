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
#   4 — (09/11/2026) images non référencées sautées aussi sur l'iGPU (`XRAY_VAAPI_NOREF`) : les
#       images échantillonnées changent un peu ; détecteur INT8 (`XRAY_DETECTOR_INT8`) : quelques
#       visages à la limite (moins de 36 px) gagnés ou perdus. Règles de noms et de scènes inchangées.
RESULT_VERSION = 4


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if not raw:
        return default
    return raw not in ("0", "false", "no", "off")


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
    # Images non référencées sautées sur l'iGPU aussi (déjà le cas sur le processeur) : 4K HEVC,
    # 9,4 → 3,9 s de décodage par tronçon de 120 s (mesuré le 09/11/2026). Voir decode.py.
    vaapi_noref: bool = field(default_factory=lambda: _flag("XRAY_VAAPI_NOREF", True))
    # Assemblage incrémental du résultat (`results.Assembler`) : mêmes scènes que le recalcul
    # complet, 3 à 6 fois moins de calcul. « 0 » : recalcul complet à chaque tronçon (`results.build`).
    incremental: bool = field(default_factory=lambda: _flag("XRAY_INCREMENTAL", True))
    # Détecteur SCRFD quantifié en INT8, produit sur place au premier démarrage (`quantize.py`) ;
    # buffalo_l et OpenVINO seulement. L'empreinte reste en float32.
    detector_int8: bool = field(default_factory=lambda: _flag("XRAY_DETECTOR_INT8", True))
    # Périphérique d'inférence OpenVINO : CPU (défaut) ou GPU (iGPU Intel, en option ; rendu au
    # processeur tant que Jellyfin transcode sur l'iGPU — voir inference.py).
    ov_device: str = field(default_factory=lambda: (os.environ.get("XRAY_OV_DEVICE", "CPU").strip().upper() or "CPU"))
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

    @property
    def ov_cache_dir(self) -> Path:
        """Noyaux OpenCL compilés par OpenVINO pour l'iGPU (gardés d'un démarrage à l'autre)."""
        return self.data_dir / "ov-cache"


def _opt_float(name: str) -> float | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


settings = Settings()
