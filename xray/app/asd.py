"""« Qui parle », lecture des lèvres : le réseau Light-ASD, ses poids et ce qu'il écoute.

**Light-ASD** (Junhua Liao et al., *A Light Weight Model for Active Speaker Detection*, CVPR 2023 ;
code et poids MIT, https://github.com/Junhua-Liao/Light-ASD) : pour un visage suivi image par image
(niveaux de gris 112×112, 25 images par seconde) et le son des mêmes instants (13 coefficients MFCC,
100 par seconde), une note par image — ce visage parle-t-il. ~1 M de paramètres, entraîné sur AVA
ActiveSpeaker (`pretrain_AVA_CVPR.model`, 94,1 % de mAP sur la validation d'AVA).

LR-ASD (IJCV 2025, même auteur, MIT aussi) annonce 94,45 % : le gain est dans le bruit de notre usage
(des votes, pas une décision image par image), et seul Light-ASD a été mesuré sur nos vérités de terrain.

**Sans PyTorch.** Le fichier de poids est un `state_dict` sauvé par `torch.save` (une archive zip, un
pickle et des tableaux bruts) : il est lu ici par un *unpickler* restreint qui n'accepte que ce qu'un tel
fichier contient (`OrderedDict`, la reconstruction d'un tenseur, les types de stockage) — rien d'autre ne s'exécute. Le
réseau est reconstruit couche par couche en OpenVINO (`build_model`), normalisations par lot fondues
dans les convolutions. La parité avec le code d'origine (PyTorch) a été vérifiée sur les vrais poids
(écart max. 2,4·10⁻⁶ sur la note, MFCC à 10⁻¹² ; README « Lecture des lèvres ») ; `test_asd.py` la vérifie
à chaque construction de l'image contre une référence numpy, sur des poids tirés au hasard.

Les MFCC sont ceux de `python_speech_features` 0.6 (ce sur quoi le réseau a été entraîné), réécrits en
numpy : préaccentuation 0,97, fenêtres de 25 ms tous les 10 ms, FFT de 512, 26 bandes de Mel, DCT
orthonormée, liftrage 22, premier coefficient remplacé par le log de l'énergie.
"""

from __future__ import annotations

import collections
import logging
import pickle
import threading
import time
import zipfile
from pathlib import Path

import numpy as np

from .models import ModelError, ModelFile, _download, sha256_of

log = logging.getLogger("xray.asd")

SR = 16000
FPS = 25
CROP = 112

# Commit ed38c232 du dépôt Light-ASD (23/03/2025) : l'adresse ne bouge plus, l'empreinte non plus.
ASD_FILE = ModelFile(
    "pretrain_AVA_CVPR.model", "d44bc3ea7baa8e0946fa3921311714a630ed8b90a1928fab0dbe30d918909317",
    urls=("https://github.com/Junhua-Liao/Light-ASD/raw/ed38c232de5efe0261dbd68627c0ade7cdfe14eb/weight/pretrain_AVA_CVPR.model",),
)
LICENSE = "mit"
LABEL = "Light-ASD (AVA ActiveSpeaker)"


# ---- les poids, sans PyTorch -------------------------------------------------------------------------

_STORAGES = {"FloatStorage": np.float32, "LongStorage": np.int64, "HalfStorage": np.float16,
             "DoubleStorage": np.float64, "IntStorage": np.int32}


def _rebuild_tensor(storage, offset, size, stride, *_rest):
    itemsize = storage.dtype.itemsize
    if not size:
        return np.array(storage[offset], copy=True)
    view = np.lib.stride_tricks.as_strided(storage[offset:], shape=tuple(size),
                                           strides=tuple(s * itemsize for s in stride))
    return np.array(view, copy=True)


class _Unpickler(pickle.Unpickler):
    """N'accepte que ce qu'un `state_dict` contient : toute autre classe est refusée, rien ne s'exécute."""

    def __init__(self, f, zf: zipfile.ZipFile, prefix: str):
        super().__init__(f)
        self.zf, self.prefix = zf, prefix

    def find_class(self, module, name):
        if (module, name) == ("collections", "OrderedDict"):
            return collections.OrderedDict
        if (module, name) == ("torch._utils", "_rebuild_tensor_v2"):
            return _rebuild_tensor
        if module == "torch" and name in _STORAGES:
            return _STORAGES[name]
        raise pickle.UnpicklingError(f"classe refusée dans les poids : {module}.{name}")

    def persistent_load(self, pid):
        kind, dtype, key, _location, numel = pid
        if kind != "storage":
            raise pickle.UnpicklingError("stockage inattendu")
        raw = self.zf.read(f"{self.prefix}/data/{key}")
        arr = np.frombuffer(raw, dtype=np.dtype(dtype).newbyteorder("<"))
        return arr[:numel]


def load_state(path: Path | str) -> dict[str, np.ndarray]:
    """Le `state_dict` d'un fichier `torch.save` (format zip), en tableaux numpy ; préfixes `module.` ôtés."""
    with zipfile.ZipFile(path) as zf:
        pkl = next(n for n in zf.namelist() if n.endswith("/data.pkl"))
        prefix = pkl[: -len("/data.pkl")]
        with zf.open(pkl) as f:
            state = _Unpickler(f, zf, prefix).load()
    return {k.replace("module.", ""): np.asarray(v) for k, v in state.items()}


# ---- MFCC (python_speech_features 0.6) -----------------------------------------------------------------

def _filterbank(nfilt: int = 26, nfft: int = 512, sr: int = SR) -> np.ndarray:
    def hz2mel(hz):
        return 2595 * np.log10(1 + hz / 700.0)

    def mel2hz(mel):
        return 700 * (10 ** (mel / 2595.0) - 1)

    pts = np.linspace(hz2mel(0), hz2mel(sr / 2), nfilt + 2)
    bins = np.floor((nfft + 1) * mel2hz(pts) / sr)
    fb = np.zeros((nfilt, nfft // 2 + 1))
    for j in range(nfilt):
        for i in range(int(bins[j]), int(bins[j + 1])):
            fb[j, i] = (i - bins[j]) / (bins[j + 1] - bins[j])
        for i in range(int(bins[j + 1]), int(bins[j + 2])):
            fb[j, i] = (bins[j + 2] - i) / (bins[j + 2] - bins[j + 1])
    return fb


_FB = _filterbank()


def _dct_ortho(x: np.ndarray, n: int) -> np.ndarray:
    N = x.shape[1]
    k = np.arange(n)[:, None]
    basis = np.cos(np.pi * k * (2 * np.arange(N)[None, :] + 1) / (2 * N))
    out = x @ basis.T * np.sqrt(2.0 / N)
    out[:, 0] /= np.sqrt(2.0)
    return out


def mfcc(pcm: np.ndarray, numcep: int = 13) -> np.ndarray:
    """(trames, 13) à 100 trames par seconde, sur des échantillons int16 (l'échelle compte : le premier
    coefficient est le log de l'énergie, comme à l'entraînement)."""
    sig = np.asarray(pcm, dtype=np.float64)
    if len(sig) == 0:
        return np.zeros((0, numcep))
    sig = np.append(sig[0], sig[1:] - 0.97 * sig[:-1])
    flen, step, nfft = 400, 160, 512
    n = 1 if len(sig) <= flen else 1 + int(np.ceil((len(sig) - flen) / step))
    pad = np.concatenate([sig, np.zeros((n - 1) * step + flen - len(sig))])
    idx = np.arange(flen)[None, :] + step * np.arange(n)[:, None]
    frames = pad[idx]
    pspec = (np.abs(np.fft.rfft(frames, nfft)) ** 2) / nfft
    energy = pspec.sum(1)
    energy = np.where(energy == 0, np.finfo(float).eps, energy)
    feat = pspec @ _FB.T
    feat = np.where(feat == 0, np.finfo(float).eps, feat)
    feat = _dct_ortho(np.log(feat), numcep)
    lift = 1 + 11.0 * np.sin(np.pi * np.arange(numcep) / 22.0)
    feat = feat * lift
    feat[:, 0] = np.log(energy)
    return feat


# ---- le visage, tel que Light-ASD l'attend ---------------------------------------------------------------

def face_crop(gray: np.ndarray, box) -> np.ndarray:
    """Le recadrage de `Columbia_test.py` : un carré centré sur le visage, élargi de 40 % (le menton et
    la bouche entiers), bordure grise, ramené à 224 puis le centre 112×112."""
    import cv2

    x1, y1, x2, y2 = (float(v) for v in box)
    bs = max(y2 - y1, x2 - x1) / 2
    cs = 0.4
    bsi = int(bs * (1 + 2 * cs))
    img = cv2.copyMakeBorder(gray, bsi, bsi, bsi, bsi, cv2.BORDER_CONSTANT, value=110)
    my, mx = (y1 + y2) / 2 + bsi, (x1 + x2) / 2 + bsi
    face = img[int(my - bs):int(my + bs * (1 + 2 * cs)), int(mx - bs * (1 + cs)):int(mx + bs * (1 + cs))]
    if face.size == 0:
        return np.full((CROP, CROP), 110, np.uint8)
    face = cv2.resize(face, (224, 224))
    return face[56:168, 56:168]


# ---- le réseau, en OpenVINO --------------------------------------------------------------------------------

BN_EPS = 1e-3


def _fold(state: dict, conv: str, bn: str) -> tuple[np.ndarray, np.ndarray]:
    w = state[conv + ".weight"].astype(np.float32)
    g, b = state[bn + ".weight"], state[bn + ".bias"]
    m, v = state[bn + ".running_mean"], state[bn + ".running_var"]
    s = g / np.sqrt(v + BN_EPS)
    return (w * s.reshape((-1,) + (1,) * (w.ndim - 1))).astype(np.float32), (b - m * s).astype(np.float32)


def _gru_gates(state: dict, name: str) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """PyTorch range ses portes (r, z, n), OpenVINO (z, r, h) ; biais « linéaire avant reset » : 4 blocs."""
    wi, wh = state[name + ".weight_ih_l0"], state[name + ".weight_hh_l0"]
    bi, bh = state[name + ".bias_ih_l0"], state[name + ".bias_hh_l0"]
    H = wh.shape[1]

    def zr(x):
        return np.concatenate([x[H:2 * H], x[:H], x[2 * H:]])

    B = np.concatenate([bi[H:2 * H] + bh[H:2 * H], bi[:H] + bh[:H], bi[2 * H:], bh[2 * H:]])
    return zr(wi)[None].astype(np.float32), zr(wh)[None].astype(np.float32), B[None].astype(np.float32)


def build_model(state: dict):
    """Le réseau de Light-ASD en graphe OpenVINO. Entrées : `audio` (1, 4T, 13), `video` (1, T, 112, 112)
    en niveaux de gris 0–255 ; sortie (T,) : la note « parle » de chaque image (logit de la classe 1)."""
    import openvino as ov
    import openvino.opset13 as ops

    def const(x):
        return ops.constant(np.ascontiguousarray(x, dtype=np.float32))

    def conv(x, prefix, conv_name, bn_name, stride, pad):
        w, b = _fold(state, f"{prefix}.{conv_name}", f"{prefix}.{bn_name}")
        nd = w.ndim - 2
        y = ops.convolution(x, const(w), list(stride), list(pad), list(pad), [1] * nd)
        y = ops.add(y, const(b.reshape((1, -1) + (1,) * nd)))
        return ops.relu(y)

    def block(x, prefix, down: bool, video: bool):
        if video:
            s = (1, 2, 2) if down else (1, 1, 1)
            x3 = conv(x, prefix, "s_3", "bn_s_3", s, (0, 1, 1))
            x3 = conv(x3, prefix, "t_3", "bn_t_3", (1, 1, 1), (1, 0, 0))
            x5 = conv(x, prefix, "s_5", "bn_s_5", s, (0, 2, 2))
            x5 = conv(x5, prefix, "t_5", "bn_t_5", (1, 1, 1), (2, 0, 0))
            return conv(ops.add(x3, x5), prefix, "last", "bn_last", (1, 1, 1), (0, 0, 0))
        x3 = conv(x, prefix, "m_3", "bn_m_3", (1, 1), (1, 0))
        x3 = conv(x3, prefix, "t_3", "bn_t_3", (1, 1), (0, 1))
        x5 = conv(x, prefix, "m_5", "bn_m_5", (1, 1), (2, 0))
        x5 = conv(x5, prefix, "t_5", "bn_t_5", (1, 1), (0, 2))
        return conv(ops.add(x3, x5), prefix, "last", "bn_last", (1, 1), (0, 0))

    # Image : (1, T, 112, 112) → (1, 1, T, 112, 112), normalisée comme à l'entraînement.
    video = ops.parameter([1, -1, CROP, CROP], np.float32, name="video")
    v = ops.unsqueeze(video, ops.constant(np.array([1], np.int64)))
    v = ops.multiply(ops.add(ops.multiply(v, const(np.array(1 / 255.0))), const(np.array(-0.4161))), const(np.array(1 / 0.1688)))
    ve = "model.visualEncoder"
    v = block(v, f"{ve}.block1", True, True)
    v = ops.max_pool(v, [1, 2, 2], [1, 1, 1], [0, 1, 1], [0, 1, 1], [1, 3, 3]).output(0)
    v = block(v, f"{ve}.block2", False, True)
    v = ops.max_pool(v, [1, 2, 2], [1, 1, 1], [0, 1, 1], [0, 1, 1], [1, 3, 3]).output(0)
    v = block(v, f"{ve}.block3", False, True)
    v = ops.reduce_max(v, ops.constant(np.array([3, 4], np.int64)), False)       # (1, 128, T)
    v = ops.transpose(v, ops.constant(np.array([0, 2, 1], np.int64)))          # (1, T, 128)

    # Son : (1, 4T, 13) → (1, 1, 13, 4T) ; le « MaxPool3d » d'origine, sur un tenseur 4D, ne réduit
    # que le temps (noyau 3, pas 2).
    audio = ops.parameter([1, -1, 13], np.float32, name="audio")
    a = ops.unsqueeze(ops.transpose(audio, ops.constant(np.array([0, 2, 1], np.int64))), ops.constant(np.array([1], np.int64)))
    ae = "model.audioEncoder"
    a = block(a, f"{ae}.block1", False, False)
    a = ops.max_pool(a, [1, 2], [1, 1], [0, 1], [0, 1], [1, 3]).output(0)
    a = block(a, f"{ae}.block2", False, False)
    a = ops.max_pool(a, [1, 2], [1, 1], [0, 1], [0, 1], [1, 3]).output(0)
    a = block(a, f"{ae}.block3", False, False)
    a = ops.reduce_mean(a, ops.constant(np.array([2], np.int64)), False)        # (1, 128, T)
    a = ops.transpose(a, ops.constant(np.array([0, 2, 1], np.int64)))           # (1, T, 128)

    x = ops.add(a, v)
    seq = ops.convert(ops.gather(ops.shape_of(x), ops.constant(np.array([1], np.int64)), ops.constant(np.int64(0))), np.int32)
    h0 = ops.constant(np.zeros((1, 1, 128), np.float32))
    for name, direction in (("model.GRU.gru_forward", "forward"), ("model.GRU.gru_backward", "reverse")):
        W, R, B = _gru_gates(state, name)
        g = ops.gru_sequence(x, h0, seq, const(W), const(R), const(B), 128, direction, linear_before_reset=True)
        x = ops.gelu(ops.squeeze(g.output(0), ops.constant(np.array([1], np.int64))), "erf")  # (1, T, 128)
    fc_w, fc_b = state["lossAV.FC.weight"][1], state["lossAV.FC.bias"][1]
    y = ops.add(ops.matmul(x, const(fc_w.reshape(128, 1)), False, False), const(np.array(fc_b).reshape(1)))
    y = ops.reshape(y, ops.constant(np.array([-1], np.int64)), False)
    return ov.Model([y], [audio, video], "light_asd")


class AsdNet:
    """Le réseau compilé (processeur ; l'iGPU reste au décodage et à Jellyfin)."""

    def __init__(self, path: Path | str, threads: int = 2):
        import openvino as ov

        self.state = load_state(path)
        core = ov.Core()
        self.compiled = core.compile_model(build_model(self.state), "CPU",
                                           {"INFERENCE_NUM_THREADS": int(threads), "INFERENCE_PRECISION_HINT": "f32"})
        self._lock = threading.Lock()

    def score(self, feats: np.ndarray, crops: np.ndarray) -> np.ndarray:
        """`feats` (4T, 13), `crops` (T, 112, 112) : une note par image (T,)."""
        T = min(len(crops), len(feats) // 4)
        if T < 1:
            return np.zeros(0, np.float32)
        a = np.ascontiguousarray(feats[: 4 * T][None], dtype=np.float32)
        v = np.ascontiguousarray(crops[:T][None], dtype=np.float32)
        with self._lock:
            out = self.compiled({"audio": a, "video": v})
        return np.asarray(next(iter(out.values())), dtype=np.float32).reshape(-1)[:T]


class AsdModels:
    """Le fichier de poids, téléchargé et vérifié dans un fil à part (comme ceux des visages et de la voix)."""

    def __init__(self, models_dir: Path, enabled: bool = True):
        self.enabled = enabled
        self.dir = models_dir / "asd"
        self.ready = False
        self.error: str | None = None

    @property
    def path(self) -> Path:
        return self.dir / ASD_FILE.name

    def start(self) -> threading.Thread | None:
        if not self.enabled:
            return None
        t = threading.Thread(target=self._loop, name="asd-models", daemon=True)
        t.start()
        return t

    def _loop(self) -> None:
        delay = 30.0
        while True:
            try:
                self.prepare()
                return
            except ModelError as e:
                self.error = str(e)
                log.error("lecture des lèvres : %s", e)
                return
            except Exception as e:
                self.error = f"téléchargement impossible ({type(e).__name__}: {e}) ; nouvel essai dans {int(delay)} s"
                log.warning("lecture des lèvres : %s", self.error)
                time.sleep(delay)
                delay = min(delay * 2, 900.0)

    def prepare(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        dest = self.path
        if dest.exists():
            got = sha256_of(dest)
            if got != ASD_FILE.sha256:
                raise ModelError(f"{ASD_FILE.name} ne correspond pas à l'empreinte attendue ({got[:12]}… au lieu de "
                                 f"{ASD_FILE.sha256[:12]}…) ; supprimer ce fichier pour qu'il soit retéléchargé")
        else:
            tmp = dest.with_name(dest.name + ".dl")
            log.info("lecture des lèvres : téléchargement de %s", ASD_FILE.urls[0])
            try:
                _download(ASD_FILE.urls[0], tmp)
                got = sha256_of(tmp)
                if got != ASD_FILE.sha256:
                    raise RuntimeError(f"{ASD_FILE.name} téléchargé : empreinte inattendue ({got[:12]}…)")
                tmp.chmod(0o644)
                tmp.replace(dest)
            finally:
                tmp.unlink(missing_ok=True)
        self.error = None
        self.ready = True
        log.info("lecture des lèvres : Light-ASD prêt (MIT)")

    def status(self) -> dict:
        return {"enabled": self.enabled, "name": "light_asd", "label": LABEL, "ready": bool(self.ready),
                "license": LICENSE, "error": self.error}

    def load(self, threads: int) -> AsdNet:
        return AsdNet(self.path, threads)
