"""Exécution des réseaux sur le processeur : OpenVINO quand il est là, ONNX Runtime sinon.

Les deux lisent les mêmes fichiers `.onnx` (vérifiés par leur SHA-256, `models.py`) et rendent
les mêmes sorties, dans le même ordre ; `Scrfd` et `Embedder` ne voient qu'une méthode
`run(noms_de_sortie, {entrée: tableau})`, celle d'ONNX Runtime.

OpenVINO (le moteur d'Intel, plugin CPU) compile chaque réseau **une fois**, la taille du lot
laissée libre (et la taille d'image pour le détecteur) : un lot de 1 à 32 visages, une image de
640×384 ou une photo de 320×480 passent par le même réseau compilé. Le 09/11/2026, une forme
compilée par taille de lot (1, 2, 4… 32) coûtait 4 Go de mémoire — chaque compilation garde sa
copie des poids — contre 1,45 Go ainsi, pour la même vitesse (mesurée sous charge, à 10 % près
dans un sens ou dans l'autre). Le détecteur, dont le fichier fixe un lot de 1, accepte ainsi des
lots (`Scrfd.detect_batch`) ; ONNX Runtime, qui respecte la forme du fichier, ne le fait pas.

Gain et équivalence mesurés le 09/11/2026 (i7-8700, voir README, « Performances ») sur les mêmes
images : boîtes identiques à 10⁻⁴ pixel près, empreintes à un cosinus ≥ 0,9999998. OpenVINO est
installé sans ses dépendances : son paquet de télémétrie (`openvino-telemetry`) ne sert qu'aux
outils de conversion, et rien ne doit sortir de la machine.

`XRAY_INFERENCE` : `auto` (OpenVINO s'il se charge, ONNX Runtime sinon), `openvino`,
`onnxruntime`. Un échec d'OpenVINO au chargement d'un réseau retombe sur ONNX Runtime et le dit.

**iGPU, en option** (`XRAY_OV_DEVICE=GPU`, `OvGpuSession`) : le plugin GPU d'OpenVINO (OpenCL,
demi-précision) sur l'iGPU Intel. Mesuré le 09/11/2026 sur l'UHD 630 : 8,7 images/s + 34,8
visages/s contre 4,7 + 19,0 sur le processeur, et presque plus rien sur le processeur (8 ms par
image au lieu de 200). Les formes y sont fixes, compilées à la demande et bornées : chaque forme
compilée garde sa copie des poids, en mémoire partagée avec le système — une forme par taille de
lot a fait sortir le conteneur de ses 4 Go. Les lots sont donc complétés jusqu'au palier suivant
(1, 8, 32 visages ; le détecteur par 1 ou par 8 images, sans complément), et seules les
dernières formes servies restent compilées. Pic mesuré : ~3,3 Go.

**Jellyfin garde l'iGPU** (`RoutedSession`) : tant qu'il transcode sur l'iGPU (`gpu_guard`),
l'inférence repasse sur le processeur, et revient sur l'iGPU ensuite — une transcodification
perdait 39 % de sa vitesse avec l'inférence sur l'iGPU, 8 % avec l'inférence sur le processeur
(mesuré le 09/11/2026). Le réseau du processeur n'est compilé qu'à la première bascule. Les
photos de la distribution, de tailles toutes différentes, passent toujours par le processeur
(`cpu_only`) : une forme compilée par photo n'aurait servi qu'une fois.
"""

from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from contextlib import contextmanager
from pathlib import Path
from typing import Callable

import numpy as np

from .logs import event

log = logging.getLogger("xray.inference")


class OrtSession:
    """ONNX Runtime, comme avant : une session par réseau, fils bornés."""

    backend = "onnxruntime"
    batchable = False

    def __init__(self, path: Path, threads: int):
        import onnxruntime as ort

        # Rien ne sort de la machine : pas d'événements de télémétrie d'ONNX Runtime.
        try:
            ort.set_default_logger_severity(3)  # avertissements sans portée ici (identifiant de télémétrie)
            ort.disable_telemetry_events()
        except AttributeError:
            pass
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self._s = ort.InferenceSession(str(path), sess_options=opts, providers=["CPUExecutionProvider"])
        i = self._s.get_inputs()[0]
        self.input_name = i.name
        self.input_shape = list(i.shape)
        self.output_names = [o.name for o in self._s.get_outputs()]

    def run(self, names, feed):
        return self._s.run(names, feed)


class OvSession:
    """OpenVINO, plugin CPU : un réseau compilé, lot (et dimensions libres du fichier) dynamiques."""

    backend = "openvino"
    # La taille du lot peut changer même quand le fichier la fixe à 1 (`Scrfd.detect_batch`).
    batchable = True

    def __init__(self, path: Path, threads: int):
        import openvino as ov

        self.path = Path(path)
        core = ov.Core()
        # Une seule requête à la fois, sur `threads` fils : la latence d'abord (l'ouvrier attend
        # chaque résultat), sans flux parallèles qui prendraient d'autres cœurs.
        self._cfg = {"INFERENCE_NUM_THREADS": int(threads), "PERFORMANCE_HINT": "LATENCY", "NUM_STREAMS": 1,
                     # Calcul en float32 : sur une machine qui sait le bfloat16 (pas l'i7-8700),
                     # OpenVINO l'emploierait sinon de lui-même, et l'empreinte changerait.
                     "INFERENCE_PRECISION_HINT": "f32",
                     # Pas de fils épinglés à des cœurs : le service tourne en priorité basse sur
                     # une machine partagée, et un fil épinglé attend que *son* cœur se libère.
                     # Mesuré le 09/11/2026 sous charge : 209 ms par image au lieu de 244.
                     "ENABLE_CPU_PINNING": False}
        model = core.read_model(str(path))
        inp = model.inputs[0]
        self.input_name = inp.get_any_name()
        ps = inp.get_partial_shape()
        self.input_shape = [d.get_length() if d.is_static else None for d in ps]
        # Lot libre ; les autres dimensions restent ce que le fichier dit (libres ou fixes).
        dyn = [-1] + [d if d is not None else -1 for d in self.input_shape[1:]]
        model.reshape({self.input_name: dyn})
        self.output_names = [o.get_any_name() for o in model.outputs]
        self._req = core.compile_model(model, "CPU", self._cfg).create_infer_request()
        self._lock = threading.Lock()
        # Premier passage tout de suite : un modèle qu'OpenVINO ne sait pas exécuter échoue
        # ici, au chargement, et non au milieu d'un tronçon.
        probe = [1] + [d if d is not None else 64 for d in self.input_shape[1:]]
        self.run(self.output_names, {self.input_name: np.zeros(probe, dtype=np.float32)})

    def run(self, names, feed):
        x = np.ascontiguousarray(next(iter(feed.values())), dtype=np.float32)
        with self._lock:
            res = self._req.infer({0: x})
            return [np.array(res[name]) for name in names]

    def accepts_batch(self, n: int) -> bool:
        return True


_local = threading.local()


@contextmanager
def cpu_only():
    """Dans ce bloc (ce fil), l'inférence reste sur le processeur, quel que soit le réglage."""
    prev = getattr(_local, "cpu", False)
    _local.cpu = True
    try:
        yield
    finally:
        _local.cpu = prev


def _forced_cpu() -> bool:
    return bool(getattr(_local, "cpu", False))


class OvGpuSession:
    """OpenVINO sur l'iGPU : formes fixes, compilées à la demande, au plus `max_shapes` à la fois
    (les moins récemment servies sont libérées). `pad` : un lot incomplet est complété de zéros
    jusqu'au palier suivant (l'empreinte, une ligne de sortie par visage) ; sans `pad`, seuls les
    paliers exacts passent (le détecteur, dont la sortie mêle les images du lot — `split_batched`)."""

    backend = "openvino"
    batchable = True

    def __init__(self, path: Path, buckets: tuple[int, ...] = (1, 8, 32), pad: bool = True, max_shapes: int = 4,
                 device: str = "GPU", precision: str = "f16", cache_dir: Path | None = None):
        import openvino as ov

        self.device = device
        self.buckets = tuple(sorted(buckets))
        self.pad = pad
        self.max_shapes = max(1, max_shapes)
        self._core = ov.Core()
        self._cfg = {"PERFORMANCE_HINT": "LATENCY", "INFERENCE_PRECISION_HINT": precision}
        if cache_dir is not None:
            # Noyaux OpenCL compilés gardés sur disque : la première compilation d'une forme prend
            # des secondes, les suivantes (même après un redémarrage) presque rien.
            try:
                Path(cache_dir).mkdir(parents=True, exist_ok=True)
                self._cfg["CACHE_DIR"] = str(cache_dir)
            except OSError:
                pass
        self._model = self._core.read_model(str(path))
        inp = self._model.inputs[0]
        self.input_name = inp.get_any_name()
        ps = inp.get_partial_shape()
        self.input_shape = [d.get_length() if d.is_static else None for d in ps]
        self.output_names = [o.get_any_name() for o in self._model.outputs]
        self._compiled: OrderedDict[tuple[int, ...], object] = OrderedDict()
        self._lock = threading.Lock()
        # Premier passage tout de suite : pas de plugin GPU, pas de pilote de calcul, iGPU
        # inaccessible — l'échec arrive ici, et le processeur prend le relais (`make_session`).
        probe = [1] + [d if d is not None else 64 for d in self.input_shape[1:]]
        self.run(self.output_names, {self.input_name: np.zeros(probe, dtype=np.float32)})

    def bucket(self, n: int) -> int | None:
        if self.pad:
            return next((b for b in self.buckets if b >= n), None)
        return n if n in self.buckets else None

    def accepts_batch(self, n: int) -> bool:
        return self.bucket(n) is not None

    @property
    def compiled_shapes(self) -> list[tuple[int, ...]]:
        return list(self._compiled)

    def _request(self, key: tuple[int, ...]):
        req = self._compiled.get(key)
        if req is not None:
            self._compiled.move_to_end(key)
            return req
        while len(self._compiled) >= self.max_shapes:
            self._compiled.popitem(last=False)
        m = self._model.clone()
        m.reshape({self.input_name: list(key)})
        req = self._core.compile_model(m, self.device, self._cfg).create_infer_request()
        self._compiled[key] = req
        return req

    def run(self, names, feed):
        x = np.ascontiguousarray(next(iter(feed.values())), dtype=np.float32)
        n = x.shape[0]
        b = self.bucket(n)
        if b is None:
            raise ValueError(f"lot de {n} hors des paliers {self.buckets}")
        if b > n:
            x = np.concatenate([x, np.zeros((b - n,) + x.shape[1:], np.float32)])
        with self._lock:
            res = self._request(tuple(x.shape)).infer({0: x})
            return [np.array(res[name])[:n] if b > n else np.array(res[name]) for name in names]


class RoutedSession:
    """L'iGPU tant que `use_gpu()` le permet (et hors de `cpu_only`), le processeur sinon. Le
    réseau du processeur (`cpu_factory`, qui peut être un autre fichier : le détecteur INT8) n'est
    créé qu'au premier besoin ; ses sorties sont rendues dans l'ordre et sous les noms de l'iGPU."""

    backend = "openvino"
    batchable = True

    def __init__(self, gpu: OvGpuSession, cpu_factory: Callable[[], object], use_gpu: Callable[[], bool], label: str = ""):
        self.gpu = gpu
        self._cpu_factory = cpu_factory
        self._cpu = None
        self.use_gpu = use_gpu
        self.label = label
        self.input_name = gpu.input_name
        self.input_shape = gpu.input_shape
        self.output_names = gpu.output_names
        self.last: str | None = None
        self._lock = threading.Lock()
        # Appels servis par chaque périphérique (rapport de décision : part des tronçons sur l'iGPU).
        self.calls = {"GPU": 0, "CPU": 0}

    def on_gpu(self) -> bool:
        if _forced_cpu():
            return False
        try:
            return bool(self.use_gpu())
        except Exception:  # un garde en échec ne doit pas arrêter l'analyse
            return False

    def accepts_batch(self, n: int) -> bool:
        return self.gpu.accepts_batch(n) if self.on_gpu() else True

    def _cpu_session(self):
        with self._lock:
            if self._cpu is None:
                self._cpu = self._cpu_factory()
            return self._cpu

    def _note(self, device: str, reason: str) -> None:
        """Une bascule iGPU ↔ processeur, une ligne avec sa raison : `jellyfin_transcode` (Jellyfin transcode
        sur l'iGPU, qui lui est laissé), `jellyfin_idle` (il a fini), `start` (premier appel)."""
        if device != self.last:
            event(log, "inférence %s : %s (%s)", self.label or "réseau", "iGPU" if device == "GPU" else "processeur",
                  reason, action="device_switch", network=self.label or None, device=device,
                  previous=self.last, reason=reason if self.last is not None else "start")
            self.last = device

    def run(self, names, feed):
        x = next(iter(feed.values()))
        if self.on_gpu():
            self._note("GPU", "jellyfin_idle")
            if self.gpu.accepts_batch(x.shape[0]):
                self.calls["GPU"] += 1
                return self.gpu.run(names, feed)
            # Un lot hors des paliers de l'iGPU passe sur le processeur, sans bascule (compté seulement).
        elif not _forced_cpu():
            self._note("CPU", "jellyfin_transcode")
        self.calls["CPU"] += 1
        cpu = self._cpu_session()
        idx = [self.output_names.index(n) for n in names]
        return cpu.run([cpu.output_names[i] for i in idx], {cpu.input_name: x})


def make_session(path: Path, threads: int, prefer: str = "auto", cpu_path: Path | None = None,
                 gpu: dict | None = None, use_gpu: Callable[[], bool] | None = None, label: str = ""):
    """La session d'un réseau selon les réglages. `cpu_path` : le fichier à exécuter sur le
    processeur s'il diffère (IR INT8 du détecteur) — en échec, retour au fichier d'origine.
    `gpu` : options d'`OvGpuSession` quand l'inférence est demandée sur l'iGPU (le fichier
    d'origine y est exécuté, en demi-précision) ; si l'iGPU ne s'ouvre pas, la session rendue est
    celle du processeur, et son attribut `gpu_error` dit pourquoi."""

    def cpu() -> object:
        if cpu_path is not None and Path(cpu_path) != Path(path):
            try:
                return OvSession(Path(cpu_path), threads)
            except Exception as e:  # IR refusé, OpenVINO absent…
                log.warning("%s : %s (%s) — %s à la place", Path(cpu_path).name, type(e).__name__, e, Path(path).name)
        return open_session(path, threads, prefer)

    if gpu is not None and prefer in ("auto", "openvino"):
        try:
            g = OvGpuSession(Path(path), **gpu)
        except Exception as e:
            s = cpu()
            s.gpu_error = f"{type(e).__name__}: {e}"[:300]  # type: ignore[attr-defined]
            event(log, "iGPU indisponible pour %s (%s) : inférence sur le processeur", Path(path).name,
                  s.gpu_error, level=logging.WARNING, action="gpu_unavailable", network=label or None,  # type: ignore[attr-defined]
                  file=Path(path).name, error=s.gpu_error)  # type: ignore[attr-defined]
            return s
        return RoutedSession(g, cpu, use_gpu or (lambda: True), label)
    return cpu()


def device_calls(engine) -> dict | None:
    """Appels servis par l'iGPU et le processeur, toutes sessions routées du moteur (détecteur, empreinte)
    réunies ; None sans session routée (inférence sur le processeur seulement)."""
    if engine is None:
        return None
    out = {"GPU": 0, "CPU": 0}
    found = False
    for part in (getattr(engine, "detector", None), getattr(engine, "embedder", None)):
        s = getattr(part, "session", None)
        if isinstance(s, RoutedSession):
            found = True
            for k in out:
                out[k] += s.calls.get(k, 0)
    return out if found else None


def device_label(before: dict | None, after: dict | None) -> str:
    """`gpu`, `cpu` ou `mixed` entre deux relevés de `device_calls` (`cpu` sans session routée)."""
    if before is None or after is None:
        return "cpu"
    g = after["GPU"] - before["GPU"]
    c = after["CPU"] - before["CPU"]
    if g and c:
        return "mixed"
    return "gpu" if g else "cpu"


def open_session(path: Path, threads: int, prefer: str = "auto"):
    """La session d'un réseau : OpenVINO si demandé ou disponible, ONNX Runtime sinon."""
    if prefer in ("auto", "openvino"):
        try:
            return OvSession(path, threads)
        except ImportError:
            if prefer == "openvino":
                log.warning("OpenVINO absent : ONNX Runtime pour %s", Path(path).name)
        except Exception as e:  # modèle refusé, plugin absent…
            log.warning("OpenVINO en échec sur %s (%s : %s) : ONNX Runtime à la place",
                        Path(path).name, type(e).__name__, e)
    return OrtSession(path, threads)
