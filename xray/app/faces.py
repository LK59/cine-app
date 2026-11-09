"""Détection, alignement et empreinte des visages, sur le processeur (ONNX Runtime).

Deux jeux de modèles, au choix de l'installateur (`XRAY_MODEL`) :

- `buffalo_l` (InsightFace) : détecteur SCRFD-10G + ArcFace R50 entraîné sur WebFace600K.
  Le meilleur des deux ici, mais ses poids sont réservés à un usage non commercial.
- `auraface` : détecteur YuNet (OpenCV, MIT) + AuraFace v1 (Apache-2.0).

Le décodage des sorties de SCRFD est écrit ici plutôt que pris au paquet `insightface` :
il tient en quarante lignes, et le paquet tire une compilation Cython, `onnx`, `scikit-image`
et `matplotlib` pour deux fonctions.

L'iGPU n'est pas utilisé pour l'inférence : le pilote de calcul des Gen9 (Coffee Lake) n'est
plus qu'en maintenance, et l'iGPU sert déjà au décodage — ici et chez Jellyfin.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from .timing import StageClock

# Gabarit d'ArcFace : où tombent les yeux, le nez et les coins de la bouche dans l'image
# 112×112 que le réseau d'empreinte attend. Tout visage y est ramené par une similitude.
ARCFACE_TEMPLATE = np.array(
    [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]],
    dtype=np.float32,
)

# Seuils par défaut, propres à chaque réseau d'empreinte : deux réseaux ne placent pas leurs
# similarités au même endroit. `cluster` : deux pistes d'un même épisode sont la même personne ;
# `label` : un groupe ressemble assez aux photos d'un acteur pour porter son nom. Les photos
# (portraits posés) et l'image d'une série (éclairage, profil, flou) diffèrent : `label` est
# donc nettement plus bas que `cluster`.
MODEL_DEFAULTS = {
    "buffalo_l": {"cluster": 0.42, "label": 0.30},
    "auraface": {"cluster": 0.40, "label": 0.28},
}


@dataclass
class Face:
    box: np.ndarray  # x1, y1, x2, y2
    score: float
    kps: np.ndarray  # 5×2 : œil gauche (à l'image), œil droit, nez, bouche gauche, bouche droite
    emb: np.ndarray | None = None
    quality: float = 0.0
    accepted: bool = False
    extra: dict = field(default_factory=dict)
    # Visage aligné 112×112, gardé entre le tri et l'empreinte (qui peut venir plus tard, par lot).
    crop: np.ndarray | None = None

    @property
    def min_side(self) -> float:
        return float(min(self.box[2] - self.box[0], self.box[3] - self.box[1]))


def _session(path: Path, threads: int):
    from .config import settings
    from .inference import open_session

    return open_session(path, threads, settings.inference)


def nms(boxes: np.ndarray, scores: np.ndarray, thresh: float) -> list[int]:
    x1, y1, x2, y2 = boxes[:, 0], boxes[:, 1], boxes[:, 2], boxes[:, 3]
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep: list[int] = []
    while order.size > 0:
        i = int(order[0])
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        w = np.maximum(0.0, xx2 - xx1 + 1)
        h = np.maximum(0.0, yy2 - yy1 + 1)
        ovr = (w * h) / (areas[i] + areas[order[1:]] - w * h)
        order = order[np.where(ovr <= thresh)[0] + 1]
    return keep


class Scrfd:
    """SCRFD (InsightFace) : sorties par pas (8, 16, 32), deux ancres par point, distances aux
    bords de la boîte et aux cinq points relatives au centre de l'ancre."""

    def __init__(self, path: Path, threads: int, score_thresh: float = 0.5, nms_thresh: float = 0.4):
        self.session = _session(path, threads)
        self.input_name = self.session.input_name
        shape = self.session.input_shape
        # det_10g accepte une taille quelconque (multiple de 32) : on évite de remplir un carré
        # 640×640 pour une image 640×360 — près de deux fois moins de calcul.
        self.fixed = (int(shape[3]), int(shape[2])) if isinstance(shape[2], int) and isinstance(shape[3], int) else None
        self.output_names = list(self.session.output_names)
        n = len(self.output_names)
        self.fmc, self.strides, self.anchors = {6: (3, [8, 16, 32], 2), 9: (3, [8, 16, 32], 2),
                                                10: (5, [8, 16, 32, 64, 128], 1), 15: (5, [8, 16, 32, 64, 128], 1)}[n]
        self.use_kps = n in (9, 15)
        self.score_thresh = score_thresh
        self.nms_thresh = nms_thresh
        self._centers: dict[tuple[int, int, int], np.ndarray] = {}

    def _canvas(self, img: np.ndarray) -> tuple[np.ndarray, float, int, int]:
        h, w = img.shape[:2]
        if self.fixed:
            tw, th = self.fixed
        else:
            tw, th = (w + 31) // 32 * 32, (h + 31) // 32 * 32
        scale = min(tw / w, th / h)
        nw, nh = int(round(w * scale)), int(round(h * scale))
        canvas = np.zeros((th, tw, 3), dtype=np.uint8)
        canvas[:nh, :nw] = img if (nw, nh) == (w, h) else cv2.resize(img, (nw, nh))
        return canvas, scale, tw, th

    def detect(self, img: np.ndarray) -> list[Face]:
        canvas, scale, tw, th = self._canvas(img)
        blob = cv2.dnn.blobFromImage(canvas, 1.0 / 128.0, (tw, th), (127.5, 127.5, 127.5), swapRB=True)
        outs = self.session.run(self.output_names, {self.input_name: blob})
        return self._decode(outs, scale, tw, th, img.shape[1], img.shape[0])

    def detect_batch(self, imgs: list[np.ndarray]) -> list[list[Face]]:
        """Plusieurs images de même taille en un appel du réseau, quand le moteur sait changer
        la taille du lot (OpenVINO ; le fichier `det_10g.onnx` fixe un lot de 1, qu'ONNX Runtime
        respecte).

        Les sorties d'un lot de N ne sont pas N blocs à la suite : la tête de SCRFD range ses
        prédictions en (hauteur, largeur, lot, ancre) — mesuré le 09/11/2026, la seule
        permutation qui redonne exactement les sorties image par image (`split_batched`)."""
        if len(imgs) <= 1 or not getattr(self.session, "batchable", False) or self.anchors < 1:
            return [self.detect(im) for im in imgs]
        if len({im.shape for im in imgs}) != 1:
            return [self.detect(im) for im in imgs]
        n = len(imgs)
        prepared = [self._canvas(im) for im in imgs]
        _, scale, tw, th = prepared[0]
        canvases = [p[0] for p in prepared]
        blob = cv2.dnn.blobFromImages(canvases, 1.0 / 128.0, (tw, th), (127.5, 127.5, 127.5), swapRB=True)
        outs = self.session.run(self.output_names, {self.input_name: blob})
        per = split_batched(outs, n, self.strides, self.fmc, self.anchors, tw, th)
        h, w = imgs[0].shape[:2]
        return [self._decode(per[k], scale, tw, th, w, h) for k in range(n)]

    def _decode(self, outs, scale: float, tw: int, th: int, w: int, h: int) -> list[Face]:
        all_scores, all_boxes, all_kps = [], [], []
        for i, stride in enumerate(self.strides):
            scores = outs[i]
            bbox = outs[i + self.fmc]
            if scores.ndim == 3:  # sorties avec dimension de lot
                scores, bbox = scores[0], bbox[0]
            scores = scores.reshape(-1)
            bbox = bbox.reshape(-1, 4) * stride
            gh, gw = th // stride, tw // stride
            key = (gh, gw, stride)
            centers = self._centers.get(key)
            if centers is None:
                centers = np.stack(np.mgrid[:gh, :gw][::-1], axis=-1).astype(np.float32)
                centers = (centers * stride).reshape(-1, 2)
                if self.anchors > 1:
                    centers = np.stack([centers] * self.anchors, axis=1).reshape(-1, 2)
                self._centers[key] = centers
            pos = np.where(scores >= self.score_thresh)[0]
            if pos.size == 0:
                continue
            c = centers[pos]
            d = bbox[pos]
            boxes = np.stack([c[:, 0] - d[:, 0], c[:, 1] - d[:, 1], c[:, 0] + d[:, 2], c[:, 1] + d[:, 3]], axis=-1)
            all_scores.append(scores[pos])
            all_boxes.append(boxes)
            if self.use_kps:
                k = outs[i + 2 * self.fmc]
                if k.ndim == 3:
                    k = k[0]
                k = k.reshape(-1, 10)[pos] * stride
                kp = np.empty((pos.size, 5, 2), dtype=np.float32)
                kp[:, :, 0] = c[:, None, 0] + k[:, 0::2]
                kp[:, :, 1] = c[:, None, 1] + k[:, 1::2]
                all_kps.append(kp)
        if not all_scores:
            return []
        scores = np.concatenate(all_scores)
        boxes = np.concatenate(all_boxes) / scale
        kps = np.concatenate(all_kps) / scale if all_kps else np.zeros((len(scores), 5, 2), np.float32)
        keep = nms(boxes, scores, self.nms_thresh)
        out = []
        for i in keep:
            b = boxes[i].copy()
            b[[0, 2]] = b[[0, 2]].clip(0, w)
            b[[1, 3]] = b[[1, 3]].clip(0, h)
            out.append(Face(box=b, score=float(scores[i]), kps=kps[i]))
        return out


def split_batched(outs: list[np.ndarray], n: int, strides: list[int], fmc: int, anchors: int,
                  tw: int, th: int) -> list[list[np.ndarray]]:
    """Sorties de SCRFD pour un lot de `n` images → sorties image par image, chacune rangée comme
    pour un lot de 1 (hauteur, largeur, ancre). Le lot arrive en (hauteur, largeur, lot, ancre)."""
    per: list[list[np.ndarray]] = [[None] * len(outs) for _ in range(n)]  # type: ignore[list-item]
    for j, o in enumerate(outs):
        stride = strides[j % fmc]
        gh, gw = th // stride, tw // stride
        c = o.shape[-1]
        z = np.asarray(o).reshape(gh, gw, n, anchors, c).transpose(2, 0, 1, 3, 4)
        for k in range(n):
            per[k][j] = z[k].reshape(-1, c)
    return per


class YuNet:
    """YuNet (OpenCV zoo) par `cv2.FaceDetectorYN` : x, y, l, h, cinq points, score.
    Ses points suivent le même ordre que ceux d'ArcFace (œil de gauche à l'image d'abord)."""

    def __init__(self, path: Path, threads: int, score_thresh: float = 0.6, nms_thresh: float = 0.3):
        cv2.setNumThreads(threads)
        self.det = cv2.FaceDetectorYN.create(str(path), "", (320, 320), score_thresh, nms_thresh, 5000)
        self._size = (320, 320)

    def detect(self, img: np.ndarray) -> list[Face]:
        h, w = img.shape[:2]
        if (w, h) != self._size:
            self.det.setInputSize((w, h))
            self._size = (w, h)
        _, faces = self.det.detect(img)
        if faces is None:
            return []
        out = []
        for f in faces:
            x, y, bw, bh = f[:4]
            box = np.array([max(0, x), max(0, y), min(w, x + bw), min(h, y + bh)], dtype=np.float32)
            out.append(Face(box=box, score=float(f[14]), kps=f[4:14].reshape(5, 2).astype(np.float32)))
        return out


def similarity_transform(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Similitude (rotation, échelle uniforme, translation) aux moindres carrés — Umeyama.
    C'est ce que fait `skimage.transform.SimilarityTransform` dans InsightFace."""
    n = src.shape[0]
    mu_s, mu_d = src.mean(0), dst.mean(0)
    sc, dc = src - mu_s, dst - mu_d
    cov = dc.T @ sc / n
    u, s, vt = np.linalg.svd(cov)
    d = np.ones(2)
    if np.linalg.det(cov) < 0:
        d[1] = -1
    r = u @ np.diag(d) @ vt
    var_s = (sc ** 2).sum() / n
    scale = (s * d).sum() / var_s if var_s > 0 else 1.0
    t = mu_d - scale * r @ mu_s
    m = np.zeros((2, 3), dtype=np.float32)
    m[:, :2] = scale * r
    m[:, 2] = t
    return m


def align(img: np.ndarray, kps: np.ndarray, size: int = 112) -> np.ndarray:
    m = similarity_transform(kps.astype(np.float64), ARCFACE_TEMPLATE.astype(np.float64) * (size / 112.0))
    return cv2.warpAffine(img, m, (size, size), borderValue=0.0)


def sharpness(aligned: np.ndarray) -> float:
    gray = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray[16:104, 16:96], cv2.CV_64F).var())


def frontal_ratio(kps: np.ndarray) -> float:
    """Où tombe le nez entre les deux yeux (0,5 = de face). Un profil marqué donne une
    empreinte peu fiable : on le compte comme présence mais pas comme identification."""
    le, re, nose = kps[0], kps[1], kps[2]
    span = re[0] - le[0]
    if span <= 1e-3:
        return 0.0
    return float((nose[0] - le[0]) / span)


class Embedder:
    """Réseau d'empreinte façon ArcFace : 112×112 RVB, (x − 127,5) / 127,5, sortie normalisée.
    w600k_r50 et glintr100 sont tous deux issus d'`arcface_torch` et attendent cette
    normalisation (InsightFace ne retombe sur 0/1 que pour les vieux modèles MXNet convertis)."""

    def __init__(self, path: Path, threads: int, batch: int = 32):
        self.session = _session(path, threads)
        self.input_name = self.session.input_name
        self.output_name = self.session.output_names[0]
        shape = self.session.input_shape
        self.fixed_batch = shape[0] if isinstance(shape[0], int) else None
        self.batch = max(1, batch)

    def embed(self, crops: list[np.ndarray]) -> np.ndarray:
        """Par lots de `batch` visages : un appel par lot plutôt qu'un par visage. Le réseau
        calcule chaque image d'un lot à part (normalisation par lot figée à l'inférence) : le
        résultat est le même qu'un par un, aux arrondis près (`test_faces_batch.py`)."""
        if not crops:
            return np.zeros((0, 512), dtype=np.float32)
        step = 1 if self.fixed_batch == 1 else self.batch
        return np.concatenate([self._run(crops[i:i + step]) for i in range(0, len(crops), step)])

    def _run(self, crops: list[np.ndarray]) -> np.ndarray:
        blob = cv2.dnn.blobFromImages(crops, 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        out = self.session.run([self.output_name], {self.input_name: blob})[0].astype(np.float32)
        return normalize(out)


def normalize(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x, axis=-1, keepdims=True)
    return x / np.maximum(n, 1e-9)


@dataclass
class QualityRules:
    min_face: int = 36
    min_score: float = 0.6
    min_sharpness: float = 12.0
    frontal: tuple[float, float] = (0.18, 0.82)


class FaceEngine:
    """Détecteur + empreinte, et la règle qui décide quels visages valent une empreinte."""

    def __init__(self, name: str, detector, embedder: Embedder, rules: QualityRules | None = None):
        self.name = name
        self.detector = detector
        self.embedder = embedder
        self.rules = rules or QualityRules()
        # Chronomètre du tronçon en cours (`timing.StageClock`), posé par l'ouvrier.
        self.clock = StageClock()

    def detect_grade_batch(self, imgs: list[np.ndarray]) -> list[list[Face]]:
        """`detect_grade` de plusieurs images, la détection par lot quand le détecteur le permet."""
        if not imgs:
            return []
        clock = self.clock
        t0 = time.perf_counter()
        batch = getattr(self.detector, "detect_batch", None)
        found = batch(imgs) if batch is not None else [self.detector.detect(im) for im in imgs]
        clock.add("detect", time.perf_counter() - t0)
        clock.count("images", len(imgs))
        out = []
        for im, faces in zip(imgs, found):
            clock.count("faces", len(faces))
            t1 = time.perf_counter()
            self._grade(im, faces)
            clock.add("grade", time.perf_counter() - t1)
            out.append(faces)
        return out

    def detect_grade(self, img: np.ndarray) -> list[Face]:
        """Détecte tous les visages et décide lesquels méritent une empreinte (taille, netteté,
        orientation) — sans la calculer : l'empreinte vient ensuite, par lot, et seulement pour
        les meilleurs visages de chaque piste. Les autres restent des présences, utiles pour
        suivre une piste."""
        clock = self.clock
        t0 = time.perf_counter()
        faces = self.detector.detect(img)
        t1 = time.perf_counter()
        clock.add("detect", t1 - t0)
        clock.count("images")
        clock.count("faces", len(faces))
        self._grade(img, faces)
        clock.add("grade", time.perf_counter() - t1)
        return faces

    def _grade(self, img: np.ndarray, faces: list[Face]) -> None:
        for f in faces:
            if f.min_side < self.rules.min_face or f.score < self.rules.min_score:
                continue
            fr = frontal_ratio(f.kps)
            if not (self.rules.frontal[0] <= fr <= self.rules.frontal[1]):
                continue
            crop = align(img, f.kps)
            sh = sharpness(crop)
            if sh < self.rules.min_sharpness:
                continue
            # Qualité ∈ ]0, 1] : confiance du détecteur × taille (saturée à 96 px) × netteté
            # (saturée) × frontalité. Elle choisit les visages à empreinter (les meilleurs d'une
            # piste) et pondère la moyenne de leurs empreintes.
            f.quality = (
                f.score
                * min(1.0, f.min_side / 96.0)
                * min(1.0, sh / 80.0) ** 0.5
                * (1.0 - abs(fr - 0.5))
            )
            f.accepted = True
            f.crop = crop

    def embed_faces(self, faces: list[Face]) -> None:
        """Empreinte des visages donnés (déjà triés, `crop` posé), par lots."""
        todo = [f for f in faces if f.emb is None and f.crop is not None]
        if not todo:
            return
        t0 = time.perf_counter()
        embs = self.embedder.embed([f.crop for f in todo])
        self.clock.add("embed", time.perf_counter() - t0)
        self.clock.count("embedded", len(todo))
        for f, e in zip(todo, embs):
            f.emb = e

    def analyse(self, img: np.ndarray) -> list[Face]:
        """Tout d'un coup : détection, tri, empreinte de chaque bon visage."""
        faces = self.detect_grade(img)
        self.embed_faces([f for f in faces if f.accepted])
        return faces

    def best_face_embedding(self, img: np.ndarray) -> np.ndarray | None:
        """Pour une photo de référence : le plus grand visage net, s'il y en a un."""
        h, w = img.shape[:2]
        # Les portraits TMDB font 185 à 300 px de large : on les agrandit un peu pour que
        # le détecteur, réglé pour des images de 640, les voie à leur échelle habituelle.
        if max(h, w) < 480:
            f = 480 / max(h, w)
            img = cv2.resize(img, (int(w * f), int(h * f)), interpolation=cv2.INTER_CUBIC)
        faces = [f for f in self.detector.detect(img) if f.score >= 0.5]
        if not faces:
            return None
        face = max(faces, key=lambda f: (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]))
        crop = align(img, face.kps)
        return self.embedder.embed([crop])[0]
