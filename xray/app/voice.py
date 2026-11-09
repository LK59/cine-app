"""« Qui parle » : les modèles (détection de parole, empreintes de voix) et l'analyse d'un tronçon de son.

Deux réseaux, en ONNX Runtime sur le processeur, avec leurs propres fils (`XRAY_VOICE_THREADS`, 2 par
défaut) — ils tournent à côté de l'image, sur les cœurs qu'elle laisse :

- **Silero VAD** (v6.2, MIT) : une probabilité de parole par trame de 32 ms. Les zones de parole sont
  les trames au-dessus de 0,5, deux zones à moins de 0,25 s l'une de l'autre jointes, celles de moins
  de 0,2 s écartées (réglages du banc de R&D).
- **L'empreinte de voix**, au choix (`XRAY_VOICE_MODEL`) : `wespeaker_r34` (WeSpeaker ResNet34-LM
  entraîné sur VoxCeleb, CC BY 4.0, 256 dimensions) ou `campplus_en` (3D-Speaker CAM++ VoxCeleb,
  Apache-2.0, 512 dimensions). Une empreinte par fenêtre de 1,5 s tous les 0,5 s dans les zones de
  parole (une zone plus courte : une fenêtre à elle), sur 80 bandes de Mel à la Kaldi (25 ms / 10 ms),
  moyenne retirée par fenêtre — exactement le calcul du banc.

Les poids ne sont ni dans le dépôt ni dans l'image : téléchargés au démarrage dans `models/voice/`,
vérifiés par leur SHA-256 comme ceux des visages (`models.py`).
"""

from __future__ import annotations

import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .models import ModelError, ModelFile, _download, sha256_of
from .voices import HOP_S, WIN_S

log = logging.getLogger("xray.voice")

SR = 16000

VAD_FILE = ModelFile(
    "silero_vad.onnx", "1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3",
    urls=("https://github.com/snakers4/silero-vad/raw/v6.2/src/silero_vad/data/silero_vad.onnx",),
)

VOICE_MODELS: dict[str, dict] = {
    "wespeaker_r34": {
        "label": "WeSpeaker ResNet34-LM (VoxCeleb)",
        "license": "cc-by-4.0",
        "window": "hamming",
        "dim": 256,
        "file": ModelFile(
            "voxceleb_resnet34_LM.onnx", "7bb2f06e9df17cdf1ef14ee8a15ab08ed28e8d0ef5054ee135741560df2ec068",
            urls=("https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM/resolve/"
                  "f0c48c298fd835726c27956a5d617bad7115627e/voxceleb_resnet34_LM.onnx",),
        ),
    },
    "campplus_en": {
        "label": "3D-Speaker CAM++ (VoxCeleb)",
        "license": "apache-2.0",
        "window": "povey",
        "dim": 512,
        "file": ModelFile(
            "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",
            "357a834f702b80161e5b981182c038e18553c1f2ca752ed6cec2052365d4129b",
            urls=("https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/"
                  "3dspeaker_speech_campplus_sv_en_voxceleb_16k.onnx",),
        ),
    },
}


class VoiceModels:
    """Les deux réseaux de la voix, préparés dans un fil à part ; `ready` dit s'ils sont là."""

    def __init__(self, name: str, models_dir: Path, enabled: bool = True):
        self.enabled = enabled
        self.name = name if name in VOICE_MODELS else "wespeaker_r34"
        self.unknown = None if name in VOICE_MODELS else name
        self.spec = VOICE_MODELS[self.name]
        self.dir = models_dir / "voice"
        self.ready = False
        self.error: str | None = None if self.unknown is None else f"XRAY_VOICE_MODEL inconnu : {name} (wespeaker_r34 ou campplus_en)"
        self.state = "attente"

    @property
    def license(self) -> str:
        return self.spec["license"]

    def files(self) -> list[ModelFile]:
        return [VAD_FILE, self.spec["file"]]

    def start(self) -> threading.Thread | None:
        if not self.enabled or self.unknown is not None:
            return None
        t = threading.Thread(target=self._loop, name="voice-models", daemon=True)
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
                log.error("voix : %s", e)
                return
            except Exception as e:
                self.error = f"téléchargement impossible ({type(e).__name__}: {e}) ; nouvel essai dans {int(delay)} s"
                log.warning("voix : %s", self.error)
                time.sleep(delay)
                delay = min(delay * 2, 900.0)

    def prepare(self) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        for mf in self.files():
            dest = self.dir / mf.name
            if dest.exists():
                got = sha256_of(dest)
                if got != mf.sha256:
                    raise ModelError(f"{mf.name} ne correspond pas à l'empreinte attendue ({got[:12]}… au lieu de "
                                     f"{mf.sha256[:12]}…) ; supprimer ce fichier pour qu'il soit retéléchargé")
                continue
            last: Exception | None = None
            for url in mf.urls:
                self.state = f"téléchargement de {mf.name}"
                log.info("voix : téléchargement de %s", url)
                tmp = dest.with_name(dest.name + ".dl")
                try:
                    _download(url, tmp)
                    got = sha256_of(tmp)
                    if got != mf.sha256:
                        raise RuntimeError(f"{mf.name} téléchargé : empreinte inattendue ({got[:12]}…)")
                    tmp.chmod(0o644)
                    tmp.replace(dest)
                    last = None
                    break
                except Exception as e:
                    tmp.unlink(missing_ok=True)
                    last = e
            if last is not None:
                raise last
        self.state = "prêt"
        self.error = None
        self.ready = True
        log.info("voix : %s prêt (%s), Silero VAD (MIT)", self.name, self.license)

    def status(self) -> dict:
        return {"enabled": self.enabled, "name": self.name, "label": self.spec["label"], "ready": bool(self.ready),
                "license": self.license, "error": self.error, "vad": {"name": "silero_vad", "version": "6.2", "license": "mit"}}

    def load_engine(self, threads: int) -> "VoiceEngine":
        return VoiceEngine(self.dir / VAD_FILE.name, self.dir / self.spec["file"].name, self.spec["window"], threads)


# ---- 80 bandes de Mel à la Kaldi (25 ms / 10 ms), en numpy — le calcul du banc ---------------------

def _mel_banks(n_fft: int = 512, n_mels: int = 80, lo: float = 20.0, hi: float = 8000.0) -> np.ndarray:
    def mel(f):
        return 1127.0 * np.log(1.0 + f / 700.0)

    centers = np.linspace(mel(lo), mel(hi), n_mels + 2)
    mf = mel(np.arange(n_fft // 2 + 1) * SR / n_fft)
    banks = np.zeros((n_mels, n_fft // 2 + 1), np.float64)
    for m in range(n_mels):
        left, c, right = centers[m], centers[m + 1], centers[m + 2]
        banks[m] = np.maximum(0, np.minimum((mf - left) / (c - left), (right - mf) / (right - c)))
    return banks


_BANKS = _mel_banks()
_WINDOWS = {
    "hamming": 0.54 - 0.46 * np.cos(2 * np.pi * np.arange(400) / 399),
    "povey": (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(400) / 399)) ** 0.85,
}


def fbank(x: np.ndarray, window: str = "hamming") -> np.ndarray:
    """x : float32 dans [−1, 1]. Rend (trames, 80)."""
    x = x.astype(np.float64) * 32768.0
    flen, fsh = 400, 160
    n = 1 + (len(x) - flen) // fsh
    if n <= 0:
        return np.zeros((0, 80), np.float32)
    idx = np.arange(flen)[None, :] + fsh * np.arange(n)[:, None]
    fr = x[idx]
    fr -= fr.mean(axis=1, keepdims=True)
    fr = np.concatenate([fr[:, :1] - 0.97 * fr[:, :1], fr[:, 1:] - 0.97 * fr[:, :-1]], axis=1)
    fr *= _WINDOWS[window]
    spec = np.abs(np.fft.rfft(fr, n=512)) ** 2
    return np.log(np.maximum(spec @ _BANKS.T, np.finfo(np.float32).eps)).astype(np.float32)


def speech_regions(prob: np.ndarray, thr: float = 0.5, min_sil: float = 0.25, min_speech: float = 0.2) -> list[tuple[float, float]]:
    hop = 512 / SR
    regs: list[list[float]] = []
    start = None
    for i, v in enumerate(prob >= thr):
        if v and start is None:
            start = i
        if not v and start is not None:
            regs.append([start * hop, i * hop])
            start = None
    if start is not None:
        regs.append([start * hop, len(prob) * hop])
    merged: list[list[float]] = []
    for s, e in regs:
        if merged and s - merged[-1][1] < min_sil:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged if e - s >= min_speech]


def windows_in(regions: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Fenêtres de 1,5 s tous les 0,5 s dans chaque zone ; une zone plus courte : une fenêtre ; la fin
    d'une zone pas couverte (plus de 0,2 s) : une dernière fenêtre calée sur elle."""
    out: list[tuple[float, float]] = []
    for s, e in regions:
        if e - s <= WIN_S:
            out.append((s, e))
            continue
        t = s
        first = len(out)
        while t + WIN_S <= e + 1e-6:
            out.append((t, t + WIN_S))
            t += HOP_S
        if len(out) > first and out[-1][1] < e - 0.2:
            out.append((e - WIN_S, e))
    return out


@dataclass
class ChunkVoice:
    regions: list[tuple[float, float]]
    wins: np.ndarray       # (n, 2), secondes absolues
    embs: np.ndarray       # (n, d) float32
    speech_s: float
    vad_s: float
    embed_s: float


class VoiceEngine:
    def __init__(self, vad_path: Path, emb_path: Path, window: str, threads: int):
        import onnxruntime as ort

        try:
            ort.set_default_logger_severity(3)
            ort.disable_telemetry_events()
        except AttributeError:
            pass
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = max(1, threads)
        opts.inter_op_num_threads = 1
        opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        # Silero est un petit réseau récurrent : un fil suffit, plus coûte plus qu'il ne rapporte.
        vopts = ort.SessionOptions()
        vopts.intra_op_num_threads = 1
        vopts.inter_op_num_threads = 1
        self.vad = ort.InferenceSession(str(vad_path), sess_options=vopts, providers=["CPUExecutionProvider"])
        self.emb = ort.InferenceSession(str(emb_path), sess_options=opts, providers=["CPUExecutionProvider"])
        self.emb_input = self.emb.get_inputs()[0].name
        self.window = window
        self.lock = threading.Lock()

    def vad_probs(self, x: np.ndarray) -> np.ndarray:
        """Silero v5/v6 : 512 échantillons + 64 de contexte, état [2, 1, 128]. Une probabilité par 32 ms."""
        n = len(x) // 512
        state = np.zeros((2, 1, 128), np.float32)
        ctx = np.zeros(64, np.float32)
        sr = np.array(SR, dtype=np.int64)
        out = np.zeros(n, np.float32)
        for i in range(n):
            chunk = x[i * 512:(i + 1) * 512]
            p, state = self.vad.run(None, {"input": np.concatenate([ctx, chunk])[None, :], "state": state, "sr": sr})
            out[i] = p[0, 0]
            ctx = chunk[-64:]
        return out

    def analyse(self, pcm: np.ndarray, t0: float, cancel: threading.Event | None = None) -> ChunkVoice:
        """Un morceau de son (int16, 16 kHz, mono) commençant à `t0` secondes : zones de parole, fenêtres,
        empreintes — en temps absolus."""
        with self.lock:
            x = pcm.astype(np.float32) / 32768.0
            a = time.process_time()
            prob = self.vad_probs(x)
            regions = speech_regions(prob)
            b = time.process_time()
            wins = windows_in(regions)
            feats_parts = []
            # Les bandes de Mel d'un seul tenant (trames de 10 ms), par blocs de 60 s pour borner la mémoire.
            for c in range(0, len(x), 60 * SR):
                feats_parts.append(fbank(x[c:c + 60 * SR + 240], self.window)[:6000])
            feats = np.concatenate(feats_parts) if feats_parts else np.zeros((0, 80), np.float32)
            embs = []
            kept = []
            for s, e in wins:
                if cancel is not None and cancel.is_set():
                    break
                i0 = int(s * 100)
                i1 = max(i0 + 50, int(e * 100))
                f = feats[i0:i1]
                if len(f) < 20:
                    continue
                f = f - f.mean(axis=0, keepdims=True)
                embs.append(self.emb.run(None, {self.emb_input: f[None].astype(np.float32)})[0][0])
                kept.append((s + t0, e + t0))
            c_ = time.process_time()
        d = self.emb.get_outputs()[0].shape[-1]
        return ChunkVoice(
            regions=[(s + t0, e + t0) for s, e in regions],
            wins=np.array(kept, dtype=np.float64).reshape(-1, 2),
            embs=np.array(embs, dtype=np.float32).reshape(len(embs), -1) if embs else np.zeros((0, d if isinstance(d, int) else 256), np.float32),
            speech_s=float(sum(e - s for s, e in regions)),
            vad_s=b - a,
            embed_s=c_ - b,
        )
