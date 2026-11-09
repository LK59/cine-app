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
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path

import numpy as np

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

    def __init__(self, path: Path, threads: int, device: str = "CPU"):
        import openvino as ov

        core = ov.Core()
        self.device = device
        if device == "CPU":
            # Une seule requête à la fois, sur `threads` fils : la latence d'abord (l'ouvrier attend
            # chaque résultat), sans flux parallèles qui prendraient d'autres cœurs.
            self._cfg = {"INFERENCE_NUM_THREADS": int(threads), "PERFORMANCE_HINT": "LATENCY", "NUM_STREAMS": 1,
                         "INFERENCE_PRECISION_HINT": "f32",
                         "ENABLE_CPU_PINNING": False}
        else:
            # Essai 11/2026 : iGPU (plugin GPU, OpenCL), demi-précision.
            self._cfg = {"PERFORMANCE_HINT": "LATENCY", "INFERENCE_PRECISION_HINT": "f16",
                         "CACHE_DIR": "/tmp/ov-cache"}
        self._core = core
        model = core.read_model(str(path))
        inp = model.inputs[0]
        self.input_name = inp.get_any_name()
        ps = inp.get_partial_shape()
        self.input_shape = [d.get_length() if d.is_static else None for d in ps]
        self.output_names = [o.get_any_name() for o in model.outputs]
        self._lock = threading.Lock()
        self._model = model
        self._static: dict = {}
        if device == "CPU" or not getattr(OvSession, "gpu_static", True):
            dyn = [-1] + [d if d is not None else -1 for d in self.input_shape[1:]]
            model.reshape({self.input_name: dyn})
            self._req = core.compile_model(model, device, self._cfg).create_infer_request()
        else:
            # GPU : une forme compilée par taille d'entrée rencontrée (formes dynamiques lentes ou
            # refusées sur Gen9).
            self._req = None
        probe = [1] + [d if d is not None else 64 for d in self.input_shape[1:]]
        self.run(self.output_names, {self.input_name: np.zeros(probe, dtype=np.float32)})

    # GPU : formes compilées bornées. Chaque forme compilée garde sa copie des poids (en mémoire
    # partagée avec le système sur un iGPU) : une forme par taille de lot a fait sortir le conteneur
    # de ses 4 Go (09/11/2026). Le lot est complété jusqu'au palier suivant ; au-delà de GPU_MAX
    # formes (photos de tailles diverses), la forme passe par une copie dynamique sur le processeur.
    GPU_BUCKETS = (1, 8, 32)
    GPU_MAX = 6

    def _request(self, shape):
        if self._req is not None:
            return self._req, shape[0]
        n = shape[0]
        b = next((x for x in self.GPU_BUCKETS if x >= n), n)
        key = (b,) + tuple(shape[1:])
        r = self._static.get(key)
        if r is None and len(self._static) < self.GPU_MAX:
            m = self._model.clone()
            m.reshape({self.input_name: list(key)})
            r = self._core.compile_model(m, self.device, self._cfg).create_infer_request()
            self._static[key] = r
        if r is None:
            if getattr(self, "_cpu", None) is None:
                m = self._model.clone()
                m.reshape({self.input_name: [-1] + [d if d is not None else -1 for d in self.input_shape[1:]]})
                self._cpu = self._core.compile_model(m, "CPU", {"INFERENCE_NUM_THREADS": 2, "PERFORMANCE_HINT": "LATENCY",
                                                               "INFERENCE_PRECISION_HINT": "f32"}).create_infer_request()
            return self._cpu, n
        return r, b

    def run(self, names, feed):
        x = np.ascontiguousarray(next(iter(feed.values())), dtype=np.float32)
        with self._lock:
            req, b = self._request(x.shape)
            n = x.shape[0]
            if b > n:
                # Seul l'empreinteur (sortie (lot, 512)) arrive ici avec un lot incomplet :
                # SCRFD sur GPU n'est appelé que par lots de 1 ou de 8 (`Scrfd.detect_batch`).
                x = np.concatenate([x, np.zeros((b - n,) + x.shape[1:], np.float32)])
            res = req.infer({0: x})
            return [np.array(res[name])[:n] if b > n else np.array(res[name]) for name in names]


def open_session(path: Path, threads: int, prefer: str = "auto", device: str = "CPU"):
    """La session d'un réseau : OpenVINO si demandé ou disponible, ONNX Runtime sinon."""
    if prefer in ("auto", "openvino"):
        try:
            return OvSession(path, threads, device)
        except ImportError:
            if prefer == "openvino":
                log.warning("OpenVINO absent : ONNX Runtime pour %s", Path(path).name)
        except Exception as e:  # modèle refusé, plugin absent…
            log.warning("OpenVINO en échec sur %s (%s : %s) : ONNX Runtime à la place",
                        Path(path).name, type(e).__name__, e)
    return OrtSession(path, threads)
