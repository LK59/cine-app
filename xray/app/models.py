"""Téléchargement et vérification des poids des modèles, au démarrage du conteneur.

Les poids ne sont ni dans le dépôt ni dans l'image : ceux de `buffalo_l` sont réservés à un
usage non commercial, et c'est à l'installateur de choisir de les télécharger chez lui (comme
le fait le service d'apprentissage d'Immich). Chaque fichier est comparé à une empreinte
SHA-256 fixée ici, calculée sur la publication officielle :

- un fichier présent n'est jamais retéléchargé ; s'il ne correspond pas, le service refuse de
  s'en servir et le dit dans /health (supprimer le fichier pour qu'il soit repris) ;
- un téléchargement s'écrit dans un `.part`, et ne prend son nom définitif qu'une fois vérifié.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path

import httpx

log = logging.getLogger("xray.models")


@dataclass(frozen=True)
class ModelFile:
    name: str
    sha256: str
    urls: tuple[str, ...] = ()
    # Fichier pris dans une archive : (URL de l'archive, SHA-256 de l'archive, membre).
    archive: tuple[str, str, str] | None = None


BUFFALO_ZIP = (
    "https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip",
    "80ffe37d8a5940d59a7384c201a2a38d4741f2f3c51eef46ebb28218a7b0ca2f",
)

MODELS: dict[str, dict] = {
    "buffalo_l": {
        "license": "non-commercial",
        "detector": "det_10g.onnx",
        "embedder": "w600k_r50.onnx",
        "files": [
            ModelFile("det_10g.onnx", "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
                      archive=(BUFFALO_ZIP[0], BUFFALO_ZIP[1], "det_10g.onnx")),
            ModelFile("w600k_r50.onnx", "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43",
                      archive=(BUFFALO_ZIP[0], BUFFALO_ZIP[1], "w600k_r50.onnx")),
        ],
    },
    "auraface": {
        "license": "apache-2.0",
        "detector": "face_detection_yunet_2023mar.onnx",
        "embedder": "glintr100.onnx",
        "files": [
            # Le dépôt opencv_zoo range ses modèles dans Git LFS : l'adresse « raw » ne rend
            # qu'un pointeur de 92 octets, d'où l'hôte « media » d'abord.
            ModelFile(
                "face_detection_yunet_2023mar.onnx",
                "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
                urls=(
                    "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
                    "https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx",
                ),
            ),
            # Seul ce fichier est pris dans le dépôt AuraFace-v1 (Apache-2.0).
            ModelFile(
                "glintr100.onnx",
                "a7933ea5330113b01c9b60351d8f4c33003f145d8470ac5f0e52ee2effe25c60",
                urls=("https://huggingface.co/fal/AuraFace-v1/resolve/main/glintr100.onnx",),
            ),
        ],
    },
}


class ModelError(RuntimeError):
    pass


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _download(url: str, dest: Path) -> None:
    tmp = dest.with_name(dest.name + ".part")
    with httpx.stream("GET", url, follow_redirects=True, timeout=httpx.Timeout(30.0, read=120.0)) as r:
        r.raise_for_status()
        with open(tmp, "wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
    tmp.replace(dest)


class ModelManager:
    """Prépare les poids dans un fil à part : l'API répond tout de suite (`ready: false`)."""

    def __init__(self, name: str, models_dir: Path):
        if name not in MODELS:
            raise ModelError(f"XRAY_MODEL inconnu : {name} (buffalo_l ou auraface)")
        self.name = name
        self.spec = MODELS[name]
        self.dir = models_dir / name
        self.ready = False
        self.error: str | None = None
        self.state = "attente"
        self._lock = threading.Lock()

    @property
    def license(self) -> str:
        return self.spec["license"]

    def path(self, role: str) -> Path:
        return self.dir / self.spec[role]

    def start(self) -> threading.Thread:
        t = threading.Thread(target=self._loop, name="models", daemon=True)
        t.start()
        return t

    def _loop(self) -> None:
        delay = 30.0
        while True:
            try:
                self.prepare()
                return
            except ModelError as e:
                # Empreinte fausse sur un fichier présent : on ne réessaie pas, l'installateur tranche.
                self.error = str(e)
                log.error("modèles : %s", e)
                return
            except Exception as e:  # réseau : on réessaie, de plus en plus espacé
                self.error = f"téléchargement impossible ({type(e).__name__}: {e}) ; nouvel essai dans {int(delay)} s"
                log.warning("modèles : %s", self.error)
                time.sleep(delay)
                delay = min(delay * 2, 900.0)

    def prepare(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        archives: dict[str, Path] = {}
        try:
            for mf in self.spec["files"]:
                dest = self.dir / mf.name
                if dest.exists():
                    self.state = f"vérification de {mf.name}"
                    got = sha256_of(dest)
                    if got != mf.sha256:
                        raise ModelError(
                            f"{mf.name} ne correspond pas à l'empreinte attendue ({got[:12]}… au lieu de "
                            f"{mf.sha256[:12]}…) ; supprimer ce fichier pour qu'il soit retéléchargé"
                        )
                    continue
                if mf.archive:
                    url, zsha, member = mf.archive
                    zpath = archives.get(url)
                    if zpath is None:
                        zpath = self.dir / (url.rsplit("/", 1)[-1])
                        self.state = f"téléchargement de {zpath.name}"
                        log.info("modèles : téléchargement de %s", url)
                        _download(url, zpath)
                        got = sha256_of(zpath)
                        if got != zsha:
                            zpath.unlink(missing_ok=True)
                            raise RuntimeError(f"archive {zpath.name} : empreinte inattendue ({got[:12]}…)")
                        archives[url] = zpath
                    tmp = dest.with_name(dest.name + ".part")
                    with zipfile.ZipFile(zpath) as z, z.open(member) as src, open(tmp, "wb") as out:
                        for block in iter(lambda: src.read(1 << 20), b""):
                            out.write(block)
                    self._accept(tmp, dest, mf)
                else:
                    last: Exception | None = None
                    for url in mf.urls:
                        self.state = f"téléchargement de {mf.name}"
                        log.info("modèles : téléchargement de %s", url)
                        tmp = dest.with_name(dest.name + ".dl")
                        try:
                            _download(url, tmp)
                            self._accept(tmp, dest, mf)
                            last = None
                            break
                        except Exception as e:
                            tmp.unlink(missing_ok=True)
                            last = e
                    if last is not None:
                        raise last
        finally:
            # L'archive de buffalo_l (288 Mo, trois modèles inutiles ici) ne reste pas.
            for z in archives.values():
                z.unlink(missing_ok=True)
        self.state = "prêt"
        self.error = None
        self.ready = True
        log.info("modèles : %s prêt (%s)", self.name, self.license)

    @staticmethod
    def _accept(tmp: Path, dest: Path, mf: ModelFile) -> None:
        got = sha256_of(tmp)
        if got != mf.sha256:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"{mf.name} téléchargé : empreinte inattendue ({got[:12]}…)")
        os.chmod(tmp, 0o644)
        tmp.replace(dest)

    def load_engine(self, threads: int, min_face: int):
        from .faces import Embedder, FaceEngine, QualityRules, Scrfd, YuNet

        if self.name == "buffalo_l":
            det = Scrfd(self.path("detector"), threads)
        else:
            det = YuNet(self.path("detector"), threads)
        from .config import settings

        emb = Embedder(self.path("embedder"), threads, batch=settings.embed_batch)
        log.info("modèles : inférence %s / %s, %d fils", getattr(det, "session", None) and det.session.backend or "opencv",
                 emb.session.backend, threads)
        return FaceEngine(self.name, det, emb, QualityRules(min_face=min_face))
