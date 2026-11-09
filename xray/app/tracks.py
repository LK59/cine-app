"""Pistes : un même visage suivi d'une image échantillonnée à l'autre, à l'intérieur d'un plan.

Dans un plan la caméra ne saute pas : deux détections qui se recouvrent (IoU) ou dont les
empreintes se ressemblent, sur deux images successives, sont la même personne. Une piste porte
une seule empreinte — la moyenne de ses bons visages, pondérée par leur qualité — ce qui lisse
un visage flou ou tourné, et divise d'autant le travail du regroupement.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .faces import Face, normalize

LINK_IOU = 0.25
LINK_SIM = 0.45
LINK_SIM_WEAK = 0.20
STRONG_IOU = 0.5


def iou(a: np.ndarray, b: np.ndarray) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return float(inter / union) if union > 0 else 0.0


@dataclass
class Track:
    faces: list[tuple[int, Face]] = field(default_factory=list)  # (rang de l'image, visage)

    @property
    def last(self) -> Face:
        return self.faces[-1][1]

    def last_emb(self) -> np.ndarray | None:
        for _, f in reversed(self.faces):
            if f.emb is not None:
                return f.emb
        return None


def link(frames: list[list[Face]]) -> list[Track]:
    """Appariement glouton image par image : les meilleures paires d'abord.

    Un lien exige un recouvrement franc, ou un recouvrement moindre confirmé par l'empreinte,
    ou — le visage a bougé entre deux images espacées — une empreinte nettement semblable."""
    tracks: list[Track] = []
    for fi, faces in enumerate(frames):
        # Une image manquée (visage tourné, flou) n'interrompt pas la piste.
        open_tracks = [t for t in tracks if t.faces[-1][0] >= fi - 2]
        pairs = []
        for ti, t in enumerate(open_tracks):
            temb = t.last_emb()
            for di, f in enumerate(faces):
                ov = iou(t.last.box, f.box)
                sim = float(temb @ f.emb) if (temb is not None and f.emb is not None) else None
                ok = (
                    ov >= STRONG_IOU
                    or (ov >= LINK_IOU and (sim is None or sim >= LINK_SIM_WEAK))
                    or (sim is not None and sim >= LINK_SIM)
                )
                if ok:
                    pairs.append((ov + (sim or 0.0), ti, di))
        pairs.sort(reverse=True)
        used_t, used_d = set(), set()
        for _, ti, di in pairs:
            if ti in used_t or di in used_d:
                continue
            open_tracks[ti].faces.append((fi, faces[di]))
            used_t.add(ti)
            used_d.add(di)
        for di, f in enumerate(faces):
            if di not in used_d:
                tracks.append(Track(faces=[(fi, f)]))
    return tracks


@dataclass
class TrackSummary:
    emb: np.ndarray
    quality: float
    faces: int
    presence: float  # part des images échantillonnées du plan où la piste apparaît


def summarize(track: Track, n_frames: int) -> TrackSummary | None:
    """Rien si aucun visage de la piste n'est assez bon pour être identifié : elle ne pourrait
    porter aucun nom, et l'inclure dans un groupe ne ferait que le brouiller."""
    good = [f for _, f in track.faces if f.accepted and f.emb is not None]
    if not good:
        return None
    w = np.array([max(f.quality, 1e-3) for f in good], dtype=np.float32)
    embs = np.stack([f.emb for f in good])
    emb = normalize((embs * w[:, None]).sum(0))
    frames = len({fi for fi, _ in track.faces})
    return TrackSummary(emb=emb.astype(np.float32), quality=float(w.mean()), faces=len(good),
                        presence=min(1.0, frames / max(n_frames, 1)))
