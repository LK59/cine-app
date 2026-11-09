"""Expérience « qui parle » : VAD Silero + empreintes de voix (WeSpeaker / CAM++) par fenêtre.

Sortie : un .npz par (titre, modèle) avec la probabilité de parole par trame de 32 ms et les
empreintes de fenêtres de 1,5 s (pas de 0,5 s) dans les zones de parole. Tout le reste (repliques,
regroupement, visages) se fait dans analyse.py, à partir de ces fichiers.

Usage : python voice.py <wav 16 kHz mono> <out.npz> <modèle onnx> [threads]
"""
import sys, time, wave
import numpy as np
import onnxruntime as ort

SR = 16000


def load(path):
    with wave.open(path) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    return x


def vad(x, sess):
    """Silero v5 : 512 échantillons + 64 de contexte, état [2,1,128]. Une proba par 32 ms."""
    n = len(x) // 512
    state = np.zeros((2, 1, 128), np.float32)
    ctx = np.zeros(64, np.float32)
    sr = np.array(SR, dtype=np.int64)
    out = np.zeros(n, np.float32)
    for i in range(n):
        chunk = x[i * 512:(i + 1) * 512]
        inp = np.concatenate([ctx, chunk])[None, :]
        p, state = sess.run(None, {"input": inp, "state": state, "sr": sr})
        out[i] = p[0, 0]
        ctx = chunk[-64:]
    return out


# ---- fbank façon Kaldi (25 ms / 10 ms, 80 bandes, fenêtre de Povey/Hamming), en numpy ----
def mel_banks(n_fft=512, n_mels=80, lo=20.0, hi=8000.0):
    def mel(f):
        return 1127.0 * np.log(1.0 + f / 700.0)
    m_lo, m_hi = mel(lo), mel(hi)
    centers = np.linspace(m_lo, m_hi, n_mels + 2)
    freqs = np.arange(n_fft // 2 + 1) * SR / n_fft
    mf = mel(freqs)
    banks = np.zeros((n_mels, n_fft // 2 + 1), np.float32)
    for m in range(n_mels):
        l, c, r = centers[m], centers[m + 1], centers[m + 2]
        up = (mf - l) / (c - l)
        down = (r - mf) / (r - c)
        banks[m] = np.maximum(0, np.minimum(up, down))
    return banks


BANKS = mel_banks()


def fbank(x, window="hamming"):
    x = x * 32768.0
    flen, fsh = 400, 160
    n = 1 + (len(x) - flen) // fsh
    if n <= 0:
        return np.zeros((0, 80), np.float32)
    idx = np.arange(flen)[None, :] + fsh * np.arange(n)[:, None]
    fr = x[idx].astype(np.float64)
    fr -= fr.mean(axis=1, keepdims=True)
    fr = np.concatenate([fr[:, :1] - 0.97 * fr[:, :1], fr[:, 1:] - 0.97 * fr[:, :-1]], axis=1)
    if window == "hann":
        w = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(flen) / flen)
    elif window == "povey":
        w = (0.5 - 0.5 * np.cos(2 * np.pi * np.arange(flen) / (flen - 1))) ** 0.85
    else:
        w = 0.54 - 0.46 * np.cos(2 * np.pi * np.arange(flen) / (flen - 1))
    fr *= w
    spec = np.abs(np.fft.rfft(fr, n=512)) ** 2
    feats = np.log(np.maximum(spec @ BANKS.T.astype(np.float64), np.finfo(np.float32).eps))
    return feats.astype(np.float32)


def speech_regions(prob, thr=0.5, min_sil=0.25, min_speech=0.2):
    hop = 512 / SR
    on = prob >= thr
    regs, start = [], None
    for i, v in enumerate(on):
        if v and start is None:
            start = i
        if not v and start is not None:
            regs.append([start * hop, i * hop]); start = None
    if start is not None:
        regs.append([start * hop, len(on) * hop])
    merged = []
    for s, e in regs:
        if merged and s - merged[-1][1] < min_sil:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged if e - s >= min_speech]


def main():
    wav, out, model = sys.argv[1], sys.argv[2], sys.argv[3]
    threads = int(sys.argv[4]) if len(sys.argv) > 4 else 2
    so = ort.SessionOptions(); so.intra_op_num_threads = threads; so.inter_op_num_threads = 1
    t0 = time.process_time(); w0 = time.time()
    x = load(wav)
    dur = len(x) / SR
    vsess = ort.InferenceSession("/w/models/silero_vad.onnx", so, providers=["CPUExecutionProvider"])
    import os
    cache = out.replace(".npz", "") .rsplit("_", 1)[0] + "_vad.npy"
    if os.path.exists(cache):
        prob = np.load(cache); t_vad = 0.0
    else:
        prob = vad(x, vsess); np.save(cache, prob)
        t_vad = time.process_time() - t0
    regs = speech_regions(prob)
    t1 = time.process_time()
    esess = ort.InferenceSession(model, so, providers=["CPUExecutionProvider"])
    inp = esess.get_inputs()[0].name
    window = "povey" if "3dspeaker" in model or "campplus" in model or "eres2net" in model else "hamming"
    nemo = "titanet" in model
    if nemo:
        window = "hann"  # NeMo : fenêtre de Hann, normalisation par bande (moyenne et écart-type)
    # Fenêtres de 1,5 s, pas de 0,5 s, dans chaque zone de parole (une zone plus courte : une fenêtre).
    win, hop = 1.5, 0.5
    starts = []
    for s, e in regs:
        if e - s <= win:
            starts.append((s, e))
        else:
            t = s
            while t + win <= e + 1e-6:
                starts.append((t, t + win)); t += hop
            if starts[-1][1] < e - 0.2:
                starts.append((e - win, e))
    embs = []
    # une fois pour tout le fichier (trames de 10 ms), par blocs de 60 s pour borner la mémoire
    parts = []
    for c in range(0, len(x), 60 * SR):
        seg = x[c:c + 60 * SR + 240]
        f = fbank(seg, window)
        parts.append(f[:6000])
    feats_all = np.concatenate(parts)
    for s, e in starts:
        a, b = int(s * 100), max(int(s * 100) + 50, int(e * 100))
        f = feats_all[a:b]
        if nemo:
            f = (f - f.mean(axis=0, keepdims=True)) / (f.std(axis=0, keepdims=True) + 1e-5)
            out_ = esess.run(["embs"], {"audio_signal": f.T[None].astype(np.float32), "length": np.array([f.shape[0]], np.int64)})
            embs.append(out_[0][0])
        else:
            f = f - f.mean(axis=0, keepdims=True)
            embs.append(esess.run(None, {inp: f[None]})[0][0])
    embs = np.array(embs, np.float32)
    t_emb = time.process_time() - t1
    np.savez(out, prob=prob, regions=np.array(regs, np.float32), wins=np.array(starts, np.float32), embs=embs,
             t_vad=t_vad, t_emb=t_emb, dur=dur)
    print(f"{out}: {dur:.0f} s audio, {len(regs)} zones, {sum(e-s for s,e in regs):.0f} s de parole, "
          f"{len(starts)} fenêtres ; CPU vad {t_vad:.1f} s, emb {t_emb:.1f} s ; mur {time.time()-w0:.0f} s")


if __name__ == "__main__":
    main()
