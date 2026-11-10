"""Téléchargement et vérification des poids des modèles, au démarrage du conteneur.

Les poids ne sont ni dans le dépôt ni dans l'image : ceux de `buffalo_l` sont réservés à un
usage non commercial, et c'est à l'installateur de choisir de les télécharger chez lui (comme
le fait le service d'apprentissage d'Immich). Chaque fichier est comparé à une empreinte
SHA-256 fixée ici, calculée sur la publication officielle :

- un fichier présent n'est jamais retéléchargé ; s'il ne correspond pas, le service refuse de
  s'en servir et le dit dans /health (supprimer le fichier pour qu'il soit repris) ;
- un téléchargement s'écrit dans un `.part`, et ne prend son nom définitif qu'une fois vérifié.

Pour `buffalo_l`, le détecteur est ensuite quantifié en INT8 sur place (`quantize.py`), une fois,
avant que le service ne se dise prêt ; en cas d'échec, il reste en float32 (`int8` dans /health).
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

from .logs import event

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
        # Détecteur INT8 : état (`off`, `building`, `ready`, `failed`), raison, chemin de l'IR.
        self.int8: dict = {"state": "off", "error": None}
        self.int8_path: Path | None = None
        # Fichiers de l'IR INT8 et leur SHA-256 (manifeste de `quantize.py`), pour le rapport de décision.
        self.int8_files: dict | None = None
        self.engine = None

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
        self._prepare_int8()
        self.state = "prêt"
        self.error = None
        self.ready = True
        # Chaque fichier vient d'être comparé à son empreinte (ou téléchargé et comparé) : la liste le dit.
        event(log, "modèles : %s prêt (%s), poids vérifiés", self.name, self.license, action="models_ready",
              kind="faces", model=self.name, license=self.license,
              files={mf.name: mf.sha256 for mf in self.spec["files"]}, int8=dict(self.int8), int8Files=self.int8_files)

    def int8_wanted(self) -> str | None:
        """None si le détecteur doit être quantifié, sinon pourquoi il ne l'est pas."""
        from .config import settings

        if not settings.detector_int8:
            return "XRAY_DETECTOR_INT8=0"
        if self.name != "buffalo_l":
            return f"pas de détecteur INT8 pour {self.name}"
        if settings.inference == "onnxruntime":
            return "XRAY_INFERENCE=onnxruntime (l'IR INT8 est propre à OpenVINO)"
        try:
            import openvino  # noqa: F401
        except ImportError:
            return "OpenVINO absent"
        return None

    def _prepare_int8(self) -> None:
        from . import quantize
        from .config import settings

        why = self.int8_wanted()
        if why is not None:
            self.int8 = {"state": "off", "error": why}
            event(log, "détecteur INT8 non utilisé : %s", why, action="int8", state="off", reason=why)
            return
        spec = next(f for f in self.spec["files"] if f.name == self.spec["detector"])
        self.state = "quantification du détecteur (INT8)"
        self.int8 = {"state": "building", "error": None}
        path, err = quantize.ensure(self.dir / spec.name, spec.sha256, self.dir / "int8", settings.media_root,
                                    settings.threads)
        if path is None:
            event(log, "détecteur INT8 indisponible, float32 à la place : %s", err, level=logging.WARNING,
                  action="int8", state="failed", error=err)
            self.int8 = {"state": "failed", "error": err}
        else:
            self.int8_path = path
            self.int8 = {"state": "ready", "error": None}
            try:
                m = quantize.load_manifest(self.dir / "int8", spec.sha256)
                self.int8_files = dict(m.get("files") or {}) if m else None
            except Exception:
                self.int8_files = None
            event(log, "détecteur INT8 prêt : %s", path.name, action="int8", state="ready", path=str(path),
                  files=self.int8_files)

    @staticmethod
    def _accept(tmp: Path, dest: Path, mf: ModelFile) -> None:
        got = sha256_of(tmp)
        if got != mf.sha256:
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"{mf.name} téléchargé : empreinte inattendue ({got[:12]}…)")
        os.chmod(tmp, 0o644)
        tmp.replace(dest)

    def load_engine(self, threads: int, min_face: int, use_gpu=None, cpu_only: bool = False):
        """Détecteur et empreinte. Sur le processeur, le détecteur est l'IR INT8 s'il est prêt ;
        avec `XRAY_OV_DEVICE=GPU`, les réseaux d'origine tournent sur l'iGPU tant que `use_gpu()`
        le permet (`inference.RoutedSession`), et sur le processeur sinon."""
        from .config import settings
        from .faces import Embedder, FaceEngine, QualityRules, Scrfd, YuNet
        from .inference import make_session

        # `cpu_only` : la voie B (`lanes.py`) — processeur seul, son propre moteur, sans toucher à celui
        # de la voie A (`self.engine`, que /health décrit).
        gpu = settings.ov_device == "GPU" and not cpu_only
        common = {"cache_dir": settings.ov_cache_dir}
        if self.name == "buffalo_l":
            dpath = self.path("detector")
            dsess = make_session(dpath, threads, settings.inference, cpu_path=self.int8_path,
                                 gpu=dict(common, buckets=(1, 8), pad=False) if gpu else None,
                                 use_gpu=use_gpu, label="détecteur")
            det = Scrfd(dpath, threads, session=dsess)
        else:
            det = YuNet(self.path("detector"), threads)
        epath = self.path("embedder")
        esess = make_session(epath, threads, settings.inference,
                             gpu=dict(common, buckets=(1, 8, 32), pad=True) if gpu else None,
                             use_gpu=use_gpu, label="empreinte")
        emb = Embedder(epath, threads, batch=settings.embed_batch, session=esess)
        engine = FaceEngine(self.name, det, emb, QualityRules(min_face=min_face))
        if not cpu_only:
            self.engine = engine
        st = self.inference_status(engine)
        event(log, "modèles : inférence %s, détecteur %s, iGPU %s, %d fils", st["engine"], st["detector"],
              "oui" if st["gpu"] else ("non (" + str(st["gpuError"]) + ")" if gpu else "non"), threads,
              action="engine_loaded", engine=st["engine"], detector=st["detector"], device=st["device"],
              gpu=st["gpu"], gpuActive=st["gpuActive"], gpuError=st["gpuError"], threads=threads, minFace=min_face,
              cpuOnly=cpu_only)
        return engine

    def inference_status(self, engine=None) -> dict:
        """Pour /health : moteur, précision du détecteur, iGPU demandé, servi, et où l'on en est."""
        from .config import settings
        from .inference import RoutedSession

        eng = engine if engine is not None else self.engine
        sessions = []
        if eng is not None:
            sessions = [getattr(eng.detector, "session", None), getattr(eng.embedder, "session", None)]
        routed = [s for s in sessions if isinstance(s, RoutedSession)]
        errors = [getattr(s, "gpu_error", None) for s in sessions if getattr(s, "gpu_error", None)]
        det = sessions[0] if sessions else None
        # Le détecteur du processeur : l'IR INT8 s'il s'est chargé (sur l'iGPU, c'est toujours le
        # réseau d'origine, en demi-précision ; le processeur n'y sert que pendant une transcodification).
        # Avant le chargement des réseaux (juste après `ready`), ce qui est prévu.
        on_cpu_int8 = self.int8_path is not None and (
            det is None or isinstance(det, RoutedSession) or getattr(det, "path", None) == self.int8_path)
        return {
            "engine": next((getattr(s, "backend", None) for s in sessions if s is not None), None),
            "device": settings.ov_device if engine is None or routed or engine is self.engine else "CPU",
            "gpu": bool(routed),
            "gpuActive": bool(routed) and all(s.on_gpu() for s in routed),
            "gpuError": errors[0] if errors else None,
            # Sur l'iGPU, le détecteur d'origine (demi-précision) ; l'INT8 sert sur le processeur.
            "detector": "int8" if on_cpu_int8 else "fp32",
            "int8": dict(self.int8),
        }
