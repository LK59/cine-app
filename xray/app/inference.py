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

    def __init__(self, path: Path, threads: int):
        import openvino as ov

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
