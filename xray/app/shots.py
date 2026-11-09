"""Plans et scènes.

Un *plan* va d'une coupe à la suivante ; une *scène* regroupe des plans voisins qui se passent
au même endroit, avec les mêmes personnes. Les deux se décident sur le flux réduit (4 images
par seconde), sans modèle :

- coupe : l'histogramme des couleurs (Y, U, V) change d'un coup entre deux images, ou il change
  moins mais l'image elle-même aussi (vignette 32×18). Le mouvement de caméra déplace l'image
  sans changer ses couleurs ; une coupe change les deux.
- scène : un plan rejoint la scène en cours s'il ressemble (couleurs) à l'un de ses quatre
  derniers plans — le champ-contrechamp d'un dialogue alterne A, B, A, B — ou s'il montre
  quelqu'un qu'on vient d'y voir dans un décor encore voisin (le héros est de presque toutes
  les scènes : seul, son visage enchaînerait l'épisode entier en une scène). Une scène de moins de 10 s est fondue dans sa voisine la plus
  proche : un plan de coupe isolé n'est pas une scène.

Couper trop souvent ne coûte presque rien (une piste coupée en deux se recolle au regroupement) ;
ne pas couper mélangerait deux plans dans une piste. Les seuils penchent donc vers la coupe.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

HIST_BINS = (32, 16, 16)
CUT_HIST = 0.30
CUT_HIST_WITH_PIXELS = 0.15
CUT_PIXELS = 0.12
SCENE_SIMILARITY = 0.72
SCENE_SIMILARITY_WITH_FACE = 0.45
SCENE_LOOKBACK = 4
MIN_SCENE = 10.0
MAX_SHOT_FRAMES = 120


@dataclass
class Signature:
    hist: np.ndarray   # 64 valeurs, trois blocs normalisés chacun à 1
    thumb: np.ndarray  # luminance 32×18, 0..1


def signature(nv12: np.ndarray, width: int, height: int) -> Signature:
    y = nv12[:height]
    uv = nv12[height:].reshape(height // 2, width // 2, 2)
    # Un pixel sur deux suffit pour un histogramme ; on divise le travail par quatre.
    hy = np.bincount((y[::2, ::2] >> 3).ravel(), minlength=32).astype(np.float32)
    hu = np.bincount((uv[::2, ::2, 0] >> 4).ravel(), minlength=16).astype(np.float32)
    hv = np.bincount((uv[::2, ::2, 1] >> 4).ravel(), minlength=16).astype(np.float32)
    hist = np.concatenate([hy / max(hy.sum(), 1), hu / max(hu.sum(), 1), hv / max(hv.sum(), 1)])
    thumb = cv2.resize(y, (32, 18), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    return Signature(hist, thumb)


def hist_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Distance en variation totale, moyennée sur les trois blocs : 0 identiques, 1 disjoints."""
    return float(0.5 * np.abs(a - b).sum() / 3.0)


def is_cut(prev: Signature, cur: Signature) -> bool:
    hd = hist_distance(prev.hist, cur.hist)
    if hd >= CUT_HIST:
        return True
    if hd >= CUT_HIST_WITH_PIXELS:
        return float(np.abs(prev.thumb - cur.thumb).mean()) >= CUT_PIXELS
    return False


def frames_to_sample(duration: float) -> int:
    """Deux ou trois images par plan, davantage pour un plan long (une de plus par 10 s, six au
    plus) : un plan long change de cadre et de personnes."""
    if duration < 0.75:
        return 1
    if duration < 2.0:
        return 2
    if duration < 12.0:
        return 3
    return min(6, 3 + int((duration - 12.0) // 10.0) + 1)


def pick_indices(n_frames: int, want: int) -> list[int]:
    want = max(1, min(want, n_frames))
    return sorted({min(n_frames - 1, int((k + 0.5) * n_frames / want)) for k in range(want)})


@dataclass
class Shot:
    start: float
    end: float
    frames: list[tuple[float, np.ndarray]] = field(default_factory=list)
    hist_sum: np.ndarray | None = None
    n_sig: int = 0

    @property
    def hist(self) -> np.ndarray:
        return self.hist_sum / max(self.n_sig, 1)


class ShotSplitter:
    """Reçoit les images une à une et rend chaque plan terminé, avec quelques images gardées.

    La mémoire est bornée : au-delà de `MAX_SHOT_FRAMES` images, on n'en garde plus qu'une sur
    deux (le choix des images à analyser se fait à la fin du plan, sur ce qui reste)."""

    def __init__(self, width: int, height: int, frame_step: float):
        self.w, self.h = width, height
        self.step = frame_step
        self.cur: Shot | None = None
        self.prev_sig: Signature | None = None
        self._keep_every = 1
        self._seen = 0

    def push(self, ts: float, frame: np.ndarray) -> Shot | None:
        sig = signature(frame, self.w, self.h)
        done = None
        if self.cur is not None and self.prev_sig is not None and is_cut(self.prev_sig, sig):
            done = self._close(ts)
        if self.cur is None:
            self.cur = Shot(start=ts, end=ts + self.step, hist_sum=np.zeros_like(sig.hist))
            self._keep_every, self._seen = 1, 0
        shot = self.cur
        shot.end = ts + self.step
        shot.hist_sum += sig.hist
        shot.n_sig += 1
        if self._seen % self._keep_every == 0:
            shot.frames.append((ts, frame.copy()))
            if len(shot.frames) > MAX_SHOT_FRAMES:
                shot.frames = shot.frames[::2]
                self._keep_every *= 2
        self._seen += 1
        self.prev_sig = sig
        return done

    def _close(self, end: float) -> Shot:
        shot = self.cur
        assert shot is not None
        shot.end = end
        self.cur = None
        return shot

    def flush(self, end: float | None = None) -> Shot | None:
        if self.cur is None:
            return None
        shot = self.cur
        if end is not None:
            shot.end = min(shot.end, end)
        self.cur = None
        self.prev_sig = None
        return shot


# --- scènes -------------------------------------------------------------------------------


@dataclass
class ShotInfo:
    start: float
    end: float
    hist: np.ndarray
    clusters: set[int] = field(default_factory=set)


def hist_similarity(a: np.ndarray, b: np.ndarray) -> float:
    return 1.0 - hist_distance(a, b)


def group_scenes(shots: list[ShotInfo], gap: float = 1.0) -> list[list[ShotInfo]]:
    """Regroupe des plans *triés et contigus* en scènes (voir l'en-tête du module)."""
    if not shots:
        return []
    scenes: list[list[ShotInfo]] = [[shots[0]]]
    for s in shots[1:]:
        cur = scenes[-1]
        if s.start - cur[-1].end > gap:
            scenes.append([s])
            continue
        recent = cur[-SCENE_LOOKBACK:]
        sim = max(hist_similarity(s.hist, r.hist) for r in recent)
        seen: set[int] = set().union(*(r.clusters for r in recent))
        if sim >= SCENE_SIMILARITY or (sim >= SCENE_SIMILARITY_WITH_FACE and s.clusters & seen):
            cur.append(s)
        else:
            scenes.append([s])
    return _merge_short(scenes, gap)


def _scene_hist(scene: list[ShotInfo]) -> np.ndarray:
    w = np.array([max(s.end - s.start, 1e-3) for s in scene])
    return (np.stack([s.hist for s in scene]) * w[:, None]).sum(0) / w.sum()


def _merge_short(scenes: list[list[ShotInfo]], gap: float) -> list[list[ShotInfo]]:
    changed = True
    while changed and len(scenes) > 1:
        changed = False
        for i, sc in enumerate(scenes):
            dur = sc[-1].end - sc[0].start
            if dur >= MIN_SCENE:
                continue
            cands = []
            if i > 0 and sc[0].start - scenes[i - 1][-1].end <= gap:
                cands.append((hist_similarity(_scene_hist(sc), _scene_hist(scenes[i - 1])), i - 1))
            if i + 1 < len(scenes) and scenes[i + 1][0].start - sc[-1].end <= gap:
                cands.append((hist_similarity(_scene_hist(sc), _scene_hist(scenes[i + 1])), i + 1))
            if not cands:
                continue
            _, j = max(cands)
            if j < i:
                scenes[j] = scenes[j] + sc
            else:
                scenes[j] = sc + scenes[j]
            del scenes[i]
            changed = True
            break
    return scenes
