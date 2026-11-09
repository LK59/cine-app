"""Jellyfin garde la priorité sur l'iGPU.

Si une session Jellyfin transcode avec l'accélération matérielle, le tronçon suivant se décode
sur le processeur : l'unité de décodage de l'iGPU est partagée, et un spectateur qui attend
son image compte plus qu'une analyse qui peut prendre une minute de plus. Vérifié avant chaque
ordre et toutes les 30 s ; sans `JELLYFIN_URL`, l'iGPU est toujours considéré libre.
"""

from __future__ import annotations

import logging
import threading
import time

import httpx

from .config import settings

log = logging.getLogger("xray.guard")


def sessions_use_hw(sessions: object) -> bool:
    if not isinstance(sessions, list):
        return False
    for s in sessions:
        info = s.get("TranscodingInfo") if isinstance(s, dict) else None
        if not isinstance(info, dict):
            continue
        hw = info.get("HardwareAccelerationType")
        if isinstance(hw, str) and hw and hw.lower() != "none":
            return True
    return False


class GpuGuard:
    def __init__(self, interval: float = 30.0):
        self.interval = interval
        self._busy = False
        self._checked = 0.0
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return bool(settings.jellyfin_url and settings.jellyfin_api_key)

    def check(self) -> bool:
        if not self.enabled:
            return False
        try:
            r = httpx.get(
                f"{settings.jellyfin_url}/Sessions",
                params={"activeWithinSeconds": 120},
                # Seule forme d'authentification acceptée par Jellyfin 12 par défaut.
                headers={"Authorization": f'MediaBrowser Token="{settings.jellyfin_api_key}"'},
                timeout=10.0,
            )
            r.raise_for_status()
            busy = sessions_use_hw(r.json())
        except Exception as e:
            # Jellyfin injoignable : on garde le dernier état connu plutôt que de supposer.
            log.warning("Jellyfin /Sessions : %s", type(e).__name__)
            return self._busy
        with self._lock:
            if busy != self._busy:
                log.info("iGPU %s par Jellyfin", "occupé" if busy else "libéré")
            self._busy = busy
            self._checked = time.time()
        return busy

    def busy(self) -> bool:
        if not self.enabled:
            return False
        if time.time() - self._checked > self.interval:
            return self.check()
        return self._busy

    def start(self) -> None:
        if not self.enabled:
            return

        def loop() -> None:
            while True:
                self.check()
                time.sleep(self.interval)

        threading.Thread(target=loop, name="gpu-guard", daemon=True).start()
