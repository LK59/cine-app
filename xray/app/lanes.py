"""Voies d'analyse : deux éléments à la fois quand la machine le permet.

Pendant une analyse sur l'iGPU (décodage VA-API, inférence OpenVINO GPU), l'iGPU est plein et le
processeur reste aux trois quarts libre (mesuré le 10/11/2026 sur un i7-8700 : 3 à 4,5 fils sur 12).
Une seconde voie emploie ce reste :

- **voie A** — le chemin de toujours : iGPU s'il est là (décodage et inférence), processeur sinon, et
  repli sur le processeur pendant une transcodification de Jellyfin ;
- **voie B** — le processeur seul : décodage par ffmpeg, détecteur INT8 et empreinte sur le processeur —
  exactement le chemin de repli de la voie A, sur un *autre* élément.

Les règles et les réseaux sont les mêmes ; seule diffère, entre l'iGPU et le processeur, l'arithmétique
(demi-précision et détecteur d'origine sur l'iGPU, INT8 sur le processeur ; réduction `scale_vaapi`
contre `scale` du processeur) — la différence que le repli de la voie A produit déjà. Chaque tronçon
garde sa voie et son périphérique (`chunks.stats`, rapport de décision).

Partage de la file (`JobStore.claim`) : la voie A prend la tête de la file comme avant ; la voie B ne
prend un ordre `normal` ou `low` que pendant que la voie A analyse déjà un élément (il y a donc un
second ordre), dans l'ordre de la file, jamais le même élément. Un ordre `high` va à la voie A (qui cède
entre deux tronçons) ; un élément de la voie B passé `high` lui est rendu. Pendant une transcodification
de Jellyfin la voie A repasse sur le processeur, et la voie B s'arrête à la fin de son tronçon (l'élément
retourne en file, rien n'est perdu) : le processeur n'est jamais demandé deux fois.

`XRAY_LANES=auto` (défaut) décide au démarrage, une fois, d'après ce que le conteneur a vraiment :
deux voies si l'inférence sur l'iGPU est demandée et que l'iGPU est là, que le quota de processeur
atteint `MIN_CPUS_TWO_LANES` et la limite de mémoire `MIN_MEMORY_TWO_LANES` ; une sinon. Sans iGPU,
une seule voie : deux voies du processeur se partageraient les mêmes cœurs. `XRAY_LANES=1|2` impose.
Si l'iGPU ne s'ouvre pas finalement (pilote, plugin), la voie B s'arrête et le journal le dit.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass, field

from .config import cpu_budget, memory_limit, settings
from .logs import event

log = logging.getLogger("xray.lanes")

PRIMARY = "A"
CPU_LANE = "B"
# Seuils de la décision automatique. Le pic de mémoire à deux voies a été mesuré le 10/11/2026
# (voir README, « Voies d'analyse ») ; la limite demandée lui laisse une marge.
MIN_CPUS_TWO_LANES = 8
MIN_MEMORY_TWO_LANES = 7 * 1024 ** 3


@dataclass
class LanePlan:
    count: int
    reason: str
    mode: str
    cpus: int
    memory: int | None
    gpu: bool
    # Fils : inférence et ffmpeg de la voie B ; ffmpeg de la voie A quand elle décode sur l'iGPU à côté
    # de la voie B ; la voie A sur le processeur garde `XRAY_THREADS` (la voie B est alors arrêtée).
    a_threads: int
    a_decode_threads: int
    b_threads: int
    voice_threads: int
    asd_threads: int
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def as_dict(self) -> dict:
        return {"count": self.count, "mode": self.mode, "reason": self.reason, "cpus": self.cpus,
                "memoryBytes": self.memory, "gpu": self.gpu,
                "threads": {"A": self.a_threads, "ADecode": self.a_decode_threads, "B": self.b_threads,
                            "voice": self.voice_threads, "asd": self.asd_threads},
                "laneBMaxPixels": settings.lane_b_max_pixels}

    def gpu_failed(self, error: str | None) -> None:
        """L'iGPU demandé ne s'est pas ouvert : en `auto`, la voie B s'arrête (deux voies du processeur
        se partageraient les mêmes cœurs)."""
        with self._lock:
            if self.mode != "auto" or self.count < 2:
                return
            self.count = 1
            self.reason = "iGPU indisponible au chargement des réseaux"
            self.gpu = False
        event(log, "voies d'analyse : 1 (%s)", self.reason, action="lanes", error=error, **self.as_dict())


def _gpu_present() -> bool:
    if settings.ov_device != "GPU":
        return False
    dev = settings.vaapi_device or "/dev/dri/renderD128"
    return os.path.exists(dev)


def decide(mode: str | None = None, cpus: int | None = None, memory: int | None | bool = False,
           gpu: bool | None = None) -> LanePlan:
    """La décision, depuis les réglages et ce que le conteneur a (paramètres : pour les tests)."""
    mode = (mode if mode is not None else settings.lanes).strip().lower()
    cpus = cpu_budget() if cpus is None else cpus
    mem = memory_limit() if memory is False else memory
    gpu = _gpu_present() if gpu is None else gpu
    if mode in ("1", "2"):
        count, reason = int(mode), f"XRAY_LANES={mode}"
    else:
        mode = "auto"
        if not gpu:
            count, reason = 1, "inférence sur le processeur seulement (pas d'iGPU demandé ou présent)"
        elif cpus < MIN_CPUS_TWO_LANES:
            count, reason = 1, f"{cpus} fils de processeur (< {MIN_CPUS_TWO_LANES})"
        elif mem is not None and mem < MIN_MEMORY_TWO_LANES:
            count, reason = 1, (f"mémoire limitée à {mem / 1024 ** 3:.1f} Gio "
                                f"(< {MIN_MEMORY_TWO_LANES / 1024 ** 3:.0f} Gio pour deux voies)")
        else:
            count, reason = 2, f"iGPU + {cpus} fils de processeur"
    voice, asd = settings.voice_threads, settings.asd_threads
    if count == 2:
        # Un tiers du budget à la voie B : la voie A (quatre fois plus efficace) et son fil des voix passent
        # d'abord. Avec la moitié (6 sur 12), la voie A perdait 15 à 25 % et le son de ses éléments prenait
        # jusqu'à 87 s de retard (mesuré le 10/11/2026). Le ffmpeg de la voie A sur l'iGPU (réduction,
        # téléchargement, adaptation HDR de 4 images par seconde) se contente de quelques fils.
        b = settings.lane_b_threads or max(2, cpus // 3)
        a_dec = settings.lane_a_decode_threads or max(2, min(4, cpus - b - voice))
    else:
        b, a_dec = 0, settings.lane_a_decode_threads or settings.threads
    return LanePlan(count=count, reason=reason, mode=mode, cpus=cpus, memory=mem, gpu=gpu,
                    a_threads=settings.threads, a_decode_threads=a_dec, b_threads=b,
                    voice_threads=voice, asd_threads=asd)


_plan: LanePlan | None = None


def plan() -> LanePlan:
    """La décision du processus, prise (et journalisée) une fois."""
    global _plan
    if _plan is None:
        _plan = decide()
        event(log, "voies d'analyse : %d (%s)", _plan.count, _plan.reason, action="lanes", **_plan.as_dict())
    return _plan


def lane_facts(lane: str) -> dict:
    """Pour le rapport : la voie d'un passage et la décision du service."""
    p = plan()
    return {"lane": lane, "cpuOnly": lane != PRIMARY, "plan": p.as_dict()}
