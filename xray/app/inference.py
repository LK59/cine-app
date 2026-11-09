"""Exécution des réseaux sur le processeur : OpenVINO quand il est là, ONNX Runtime sinon.

Les deux lisent les mêmes fichiers `.onnx` (vérifiés par leur SHA-256, `models.py`) et rendent
les mêmes sorties, dans le même ordre ; `Scrfd` et `Embedder` ne voient qu'une méthode
`run(noms_de_sortie, {entrée: tableau})`, celle d'ONNX Runtime.

OpenVINO (le moteur d'Intel, plugin CPU) compile chaque réseau pour une forme d'entrée fixe :
le détecteur reçoit toujours la même taille d'image pour un fichier donné, l'empreinte des lots
de 1 à `EMBED_BATCH` visages. Une forme nouvelle est compilée au premier passage (une à deux
secondes) et gardée ; le lot d'empreinte est arrondi à une taille d'une courte liste, complétée
d'images noires, pour ne pas compiler trente-deux variantes. Les sorties d'un lot complété sont
coupées à ce qui a été demandé : une image noire n'a pas d'effet sur ses voisines (chaque image
d'un lot est calculée à part — vérifié par `test_inference.py`).

Gain mesuré le 09/11/2026 (i7-8700, voir README, « Performances ») sur les mêmes images. OpenVINO
est installé sans ses dépendances : son paquet de télémétrie (`openvino-telemetry`) ne sert
qu'aux outils de conversion, et rien ne doit sortir de la machine.

`XRAY_INFERENCE` : `auto` (OpenVINO s'il se charge, ONNX Runtime sinon), `openvino`,
`onnxruntime`. Un échec d'OpenVINO au chargement d'un réseau retombe sur ONNX Runtime et le dit.
"""

from __future__ import annotations

import logging
import threading
from pathlib import Path

import numpy as np

log = logging.getLogger("xray.inference")

# Tailles de lot compilées pour l'empreinte : un lot de 5 visages passe en 8, de 20 en 32.
BATCH_BUCKETS = (1, 2, 4, 8, 16, 32)
MAX_SHAPES = 12


def bucket(n: int) -> int:
    for b in BATCH_BUCKETS:
        if n <= b:
            return b
    return BATCH_BUCKETS[-1]


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
    """OpenVINO, plugin CPU, une forme compilée par taille d'entrée rencontrée."""

    backend = "openvino"
    # La taille du lot peut changer même quand le fichier la fixe à 1 (`Scrfd.detect_batch`).
    batchable = True

    def __init__(self, path: Path, threads: int, pad_batch: bool = False):
        import openvino as ov

        self._ov = ov
        self._core = ov.Core()
        self._path = str(path)
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
        self._model = self._core.read_model(self._path)
        inp = self._model.inputs[0]
        self.input_name = inp.get_any_name()
        ps = inp.get_partial_shape()
        self.input_shape = [d.get_length() if d.is_static else None for d in ps]
        self.output_names = [o.get_any_name() for o in self._model.outputs]
        self._pad_batch = pad_batch
        self._compiled: dict[tuple, object] = {}
        self._lock = threading.Lock()
        # Premier passage tout de suite : un modèle qu'OpenVINO ne sait pas compiler échoue
        # ici, au chargement, et non au milieu d'un tronçon.
        probe = [d if d is not None else (1 if i == 0 else 64) for i, d in enumerate(self.input_shape)]
        if self.input_shape[2:] == [None, None]:
            probe[2:] = [384, 640]
        self.run(self.output_names, {self.input_name: np.zeros(probe, dtype=np.float32)})

    def _request(self, shape: tuple):
        with self._lock:
            req = self._compiled.get(shape)
            if req is None:
                model = self._core.read_model(self._path)
                model.reshape({model.inputs[0].get_any_name(): list(shape)})
                req = self._core.compile_model(model, "CPU", self._cfg).create_infer_request()
                # Les photos de référence arrivent en tailles variées : au-delà de quelques
                # formes, la plus ancienne repart (chacune garde une copie des poids).
                if len(self._compiled) >= MAX_SHAPES:
                    self._compiled.pop(next(iter(self._compiled)))
                self._compiled[shape] = req
            return req

    def run(self, names, feed):
        x = np.ascontiguousarray(next(iter(feed.values())), dtype=np.float32)
        n = x.shape[0]
        if self._pad_batch and bucket(n) != n:
            pad = np.zeros((bucket(n) - n,) + x.shape[1:], dtype=np.float32)
            x = np.concatenate([x, pad])
        req = self._request(tuple(x.shape))
        res = req.infer({0: x})
        outs = []
        for name in names:
            o = np.asarray(res[name])
            outs.append(o[:n] if self._pad_batch else o)
        return outs


def open_session(path: Path, threads: int, prefer: str = "auto", pad_batch: bool = False):
    """La session d'un réseau : OpenVINO si demandé ou disponible, ONNX Runtime sinon."""
    if prefer in ("auto", "openvino"):
        try:
            return OvSession(path, threads, pad_batch=pad_batch)
        except ImportError:
            if prefer == "openvino":
                log.warning("OpenVINO absent : ONNX Runtime pour %s", Path(path).name)
        except Exception as e:  # modèle refusé, plugin absent…
            log.warning("OpenVINO en échec sur %s (%s : %s) : ONNX Runtime à la place",
                        Path(path).name, type(e).__name__, e)
    return OrtSession(path, threads)
