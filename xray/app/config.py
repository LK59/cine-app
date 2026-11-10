"""Réglages du service, lus une fois dans l'environnement.

Tout est surchargeable par variable d'environnement : le service est un conteneur
qu'on règle depuis son `docker-compose.yml`, jamais en éditant le code.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# Version du service (X.Y.Z, comme Laterna : majeure pour une refonte, mineure pour une fonction ou un lot de
# changements de comportement, correctif sinon), montée dans un commit à elle avant chaque déploiement. L'historique
# est dans CHANGELOG.md ; elle est servie par /health, écrite dans chaque rapport et au démarrage du journal.
VERSION = "1.6.0"
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
#   5 — (11/2026) l'étape « qui parle » (voix, `/voices`) dans le même passage ; règles des visages et
#       des scènes inchangées. Un ordre v4 fini garde ses scènes, et ses voix sont complétées par une
#       lecture du son seul (`voicejob.py`), sans refaire l'image.
#   (10/11/2026, sans changer de version) une rafale de plans courts d'un autre lieu reste une scène
#       (`shots._keep_bursts`). Les scènes sont regroupées à neuf à chaque assemblage depuis les plans
#       gardés en base : rien ne se mêle, et monter la version referait de zéro les ordres en cours.
RESULT_VERSION = 5
# Version de l'assemblage des voix (`version` de /voices) — 1 : morceaux de 2 s coupés aux changements
# de voix, consensus de trois seuils, contraste local avec les visages, mémoire de la série.
# 2 (10/11/2026) — petites voix (moins de 6 morceaux) nommées seulement à 0,75 de confiance ; lecture des
# lèvres (`asdjob.py`, segments `via: "asd"`). Un résultat 1 reste servi ; un renommage le refait en 2.
VOICE_VERSION = 2
# Version de la lecture des lèvres (`asdjob.py`) : un élément passé sous une version antérieure est repris
# (ses votes gardés). 1 — Light-ASD, votes par morceau, voix indécises seulement (11/2026).
ASD_VERSION = 1


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
    # Sans réglage : le budget de processeur du conteneur (`cpu_budget`, quota du cgroup). Avec deux voies
    # d'analyse (`lanes.py`), c'est le budget de la voie A quand elle calcule sur le processeur.
    threads: int = field(default_factory=lambda: max(1, _int("XRAY_THREADS", cpu_budget())))
    # Voies d'analyse (`lanes.py`) : `auto` (défaut), `1` ou `2` ; fils de la voie B (processeur) et du
    # ffmpeg de la voie A quand elle décode sur l'iGPU — 0 = calculé depuis le budget de processeur.
    lanes: str = field(default_factory=lambda: os.environ.get("XRAY_LANES", "auto").strip().lower() or "auto")
    lane_b_threads: int = field(default_factory=lambda: max(0, _int("XRAY_LANE_B_THREADS", 0)))
    lane_a_decode_threads: int = field(default_factory=lambda: max(0, _int("XRAY_LANE_A_DECODE_THREADS", 0)))
    # La voie B ne prend que les fichiers dont le décodage sur le processeur est bon marché : au plus tant de
    # pixels par image (1080p par défaut). Un épisode 4K HEVC y était décodé à 3× le temps réel et ralentissait
    # la voie A d'un quart : moins de débit à deux voies qu'à une (mesuré le 10/11/2026).
    lane_b_max_pixels: int = field(default_factory=lambda: max(0, _int("XRAY_LANE_B_MAX_PIXELS", 1920 * 1200)))
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

    # « Qui parle » (11/2026) : coupé par XRAY_VOICE=0 ; modèle d'empreinte (wespeaker_r34 ou
    # campplus_en) ; fils de ses réseaux, à côté de ceux de l'image ; piste retenue (`original` : la
    # version originale quand elle existe, `default` : la piste par défaut du fichier).
    voice_enabled: bool = field(default_factory=lambda: _flag("XRAY_VOICE", True))
    voice_model: str = field(default_factory=lambda: os.environ.get("XRAY_VOICE_MODEL", "wespeaker_r34").strip().lower())
    voice_threads: int = field(default_factory=lambda: max(1, _int("XRAY_VOICE_THREADS", 2)))
    voice_track: str = field(default_factory=lambda: os.environ.get("XRAY_VOICE_TRACK", "original").strip().lower())
    # Lecture des lèvres (11/2026, `asdjob.py`) : après les voix, pour les seules voix indécises, à basse
    # priorité ; plafond de calcul par élément (secondes de processeur, ffmpeg compris) ; fils du réseau.
    asd_enabled: bool = field(default_factory=lambda: _flag("XRAY_ASD", True))
    asd_budget_s: float = field(default_factory=lambda: max(0.0, _float("XRAY_ASD_BUDGET_S", 600.0)))
    asd_threads: int = field(default_factory=lambda: max(1, _int("XRAY_ASD_THREADS", 2)))

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


def cpu_budget() -> int:
    """Les fils de processeur dont le conteneur dispose vraiment : le quota du cgroup (`cpus:` de la
    composition, `/sys/fs/cgroup/cpu.max`, ou `cpu.cfs_quota_us` en cgroup v1), borné par les cœurs
    qu'il peut voir (`sched_getaffinity`). `nproc` seul voit tous les cœurs de l'hôte, quota ou non."""
    try:
        seen = len(os.sched_getaffinity(0))
    except (AttributeError, OSError):
        seen = os.cpu_count() or 1
    quota = None
    try:
        raw = Path("/sys/fs/cgroup/cpu.max").read_text().split()
        if raw and raw[0] != "max":
            quota = float(raw[0]) / float(raw[1])
    except (OSError, ValueError, IndexError, ZeroDivisionError):
        try:
            q = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_quota_us").read_text())
            per = int(Path("/sys/fs/cgroup/cpu/cpu.cfs_period_us").read_text())
            if q > 0 and per > 0:
                quota = q / per
        except (OSError, ValueError):
            pass
    if quota is not None:
        return max(1, min(seen, int(quota)))
    return max(1, seen)


def memory_limit() -> int | None:
    """La limite de mémoire du conteneur en octets (`mem_limit`), None sans limite."""
    for p in ("/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"):
        try:
            raw = Path(p).read_text().strip()
        except OSError:
            continue
        if raw == "max":
            return None
        try:
            v = int(raw)
        except ValueError:
            continue
        # cgroup v1 sans limite : un très grand nombre.
        return None if v >= 1 << 60 else v
    return None


def _opt_float(name: str) -> float | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


settings = Settings()
