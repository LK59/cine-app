"""Suivi des visages entre deux images analysées d'un même plan, sans le détecteur (essai 11/2026).

Le détecteur ne passe que sur une image choisie sur `every` (`XRAY_DETECT_EVERY`) ; sur les
autres, les visages de l'image précédente sont *portés* par le flot optique (Lucas-Kanade
pyramidal, sur la luminance des images à 4 par seconde qui les séparent) : une grille de points
dans le cadre et les cinq points du visage avancent d'image en image ; un point n'est gardé que
si l'aller-retour le ramène à moins d'un pixel (contrôle avant-arrière). Si moins de 40 % des
points de la grille survivent, le visage est perdu (sorti du cadre, masqué).

Un visage porté garde la confiance de son origine ; il compte comme présence, et, s'il passe
le tri (taille, netteté, frontalité, avec ses points portés), peut servir à l'identification,
une qualité diminuée (`TRACK_QUALITY`) le faisant passer après les visages détectés.
Ce qu'il ne peut pas faire : voir un visage qui *entre* dans le plan après la dernière image
détectée.
"""

from __future__ import annotations

import cv2
import numpy as np

from .faces import Face

LK = dict(winSize=(21, 21), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 20, 0.03))
FB_MAX = 1.0
MIN_SURVIVE = 0.4
GRID = 5
TRACK_QUALITY = 0.8


def _grid(box: np.ndarray) -> np.ndarray:
    x1, y1, x2, y2 = box
    w, h = x2 - x1, y2 - y1
    xs = np.linspace(x1 + 0.2 * w, x2 - 0.2 * w, GRID)
    ys = np.linspace(y1 + 0.2 * h, y2 - 0.2 * h, GRID)
    return np.stack(np.meshgrid(xs, ys), -1).reshape(-1, 2).astype(np.float32)


def propagate(faces: list[Face], lumas: list[np.ndarray]) -> list[Face]:
    """Porte `faces` (posés sur lumas[0]) jusqu'à lumas[-1], image par image."""
    if not faces or len(lumas) < 2:
        return []
    pts, owner, n_grid = [], [], []
    for i, f in enumerate(faces):
        g = _grid(f.box)
        p = np.concatenate([g, f.kps.astype(np.float32)])
        pts.append(p)
        owner.append(np.full(len(p), i))
        n_grid.append(len(g))
    p0 = np.concatenate(pts).reshape(-1, 1, 2)
    owner = np.concatenate(owner)
    is_grid = np.concatenate([np.r_[np.ones(n, bool), np.zeros(5, bool)] for n in n_grid])
    alive = np.ones(len(p0), bool)
    cur = p0.copy()
    for a, b in zip(lumas[:-1], lumas[1:]):
        p1, st, _ = cv2.calcOpticalFlowPyrLK(a, b, cur, None, **LK)
        pb, stb, _ = cv2.calcOpticalFlowPyrLK(b, a, p1, None, **LK)
        fb = np.linalg.norm((pb - cur).reshape(-1, 2), axis=1)
        ok = (st.reshape(-1) == 1) & (stb.reshape(-1) == 1) & (fb < FB_MAX)
        alive &= ok
        cur = p1
    out = []
    src_all = p0.reshape(-1, 2)
    dst_all = cur.reshape(-1, 2)
    for i, f in enumerate(faces):
        sel = (owner == i) & is_grid
        good = sel & alive
        if good.sum() < max(4, MIN_SURVIVE * sel.sum()):
            continue
        s, d = src_all[good], dst_all[good]
        # Similitude (échelle uniforme + translation) estimée sur la grille survivante.
        cs, cd = s.mean(0), d.mean(0)
        ds = np.linalg.norm(s - cs, axis=1).mean()
        dd = np.linalg.norm(d - cd, axis=1).mean()
        scale = float(dd / ds) if ds > 1e-3 else 1.0
        box = f.box.astype(np.float32).copy()
        c = np.array([(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], np.float32)
        half = np.array([(box[2] - box[0]) / 2, (box[3] - box[1]) / 2], np.float32) * scale
        nc = cd + (c - cs) * scale
        nb = np.array([nc[0] - half[0], nc[1] - half[1], nc[0] + half[0], nc[1] + half[1]], np.float32)
        h, w = lumas[-1].shape[:2]
        if nb[2] <= 0 or nb[3] <= 0 or nb[0] >= w or nb[1] >= h:
            continue
        nb[[0, 2]] = nb[[0, 2]].clip(0, w)
        nb[[1, 3]] = nb[[1, 3]].clip(0, h)
        # Points du visage : portés s'ils ont survécu, sinon déplacés avec la grille.
        kmask = (owner == i) & ~is_grid
        kps = np.where(alive[kmask][:, None], dst_all[kmask], cd + (src_all[kmask] - cs) * scale).astype(np.float32)
        out.append(Face(box=nb, score=f.score, kps=kps, extra={"tracked": True}))
    return out


# --- variante : re-détection dans une fenêtre autour du visage précédent ----------------------
# Le flot optique sur 1 à 4 s d'écart perd un visage sur trois (mesuré sur MacGyver S01E06) et
# ses points dérivent (p90 ≈ 0,5 écart des yeux) : trop pour aligner une empreinte. Ici, le
# détecteur ne voit qu'une fenêtre carrée de ROI_SCALE fois le visage précédent, réduite à
# ROI_SIZE px : ~10 fois moins de pixels qu'une image entière, et de vrais points.
ROI_SCALE = 2.5
ROI_SIZE = 160
ROI_MIN_IOU = 0.2


def roi_redetect(faces: list[Face], img: np.ndarray, detector) -> list[Face]:
    if not faces:
        return []
    H, W = img.shape[:2]
    crops, geo = [], []
    for f in faces:
        cx, cy = (f.box[0] + f.box[2]) / 2, (f.box[1] + f.box[3]) / 2
        side = max(48.0, ROI_SCALE * max(f.box[2] - f.box[0], f.box[3] - f.box[1]))
        x0, y0 = int(round(cx - side / 2)), int(round(cy - side / 2))
        s = int(round(side))
        # Fenêtre hors de l'image : bordée de noir, pour garder une échelle unique.
        canvas = np.zeros((s, s, 3), np.uint8)
        ax0, ay0, ax1, ay1 = max(0, x0), max(0, y0), min(W, x0 + s), min(H, y0 + s)
        if ax1 <= ax0 or ay1 <= ay0:
            continue
        canvas[ay0 - y0:ay1 - y0, ax0 - x0:ax1 - x0] = img[ay0:ay1, ax0:ax1]
        crops.append(cv2.resize(canvas, (ROI_SIZE, ROI_SIZE), interpolation=cv2.INTER_AREA if s > ROI_SIZE else cv2.INTER_LINEAR))
        geo.append((f, x0, y0, s / ROI_SIZE))
    if not crops:
        return []
    found = detector.detect_batch(crops) if hasattr(detector, "detect_batch") else [detector.detect(c) for c in crops]
    out: list[Face] = []
    for (f, x0, y0, k), dets in zip(geo, found):
        best, bo = None, ROI_MIN_IOU
        for d in dets:
            box = d.box * k + np.array([x0, y0, x0, y0], np.float32)
            from .tracks import iou
            o = iou(box, f.box)
            if o > bo:
                best, bo = (box, d), o
        if best is None:
            continue
        box, d = best
        box[[0, 2]] = box[[0, 2]].clip(0, W)
        box[[1, 3]] = box[[1, 3]].clip(0, H)
        kps = d.kps * k + np.array([x0, y0], np.float32)
        nf = Face(box=box.astype(np.float32), score=d.score, kps=kps.astype(np.float32), extra={"tracked": True})
        # Deux visages d'origine qui retrouvent le même : un seul.
        if any(iou(nf.box, g.box) > 0.5 for g in out):
            continue
        out.append(nf)
    return out
