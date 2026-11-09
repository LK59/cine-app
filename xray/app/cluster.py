"""Regroupement des pistes en personnes, puis nom de chaque personne.

1. **Regroupement** — classification hiérarchique ascendante, lien moyen, distance cosinus,
   coupée à un seuil : deux groupes fusionnent tant que leurs pistes se ressemblent *en
   moyenne*. Le lien moyen résiste mieux que le lien simple à l'effet de chaîne (A ressemble à
   B qui ressemble à C) et ne demande pas, comme les k-moyennes, de connaître le nombre de
   personnes à l'avance.
2. **Nom** — chaque groupe est comparé aux photos de chaque acteur de la distribution
   fournie (et à lui seul : un visage n'est jamais nommé d'après quelqu'un qui ne joue pas
   dans l'épisode). Note d'un couple groupe × acteur : moyenne des *k* meilleures similarités
   avec ses photos — une photo ratée ne compte pas, une seule photo flatteuse ne suffit pas.
   Les visages déjà nommés dans les épisodes précédents de la série comptent aussi.
3. **Un à un** — l'algorithme hongrois attribue au plus un groupe par acteur en maximisant
   la somme des notes (légèrement pondérées par le temps de présence du groupe). Sous le seuil
   de rejet, le groupe reste anonyme et n'est jamais montré.
4. **Seconde passe** — un acteur filmé sous deux jours très différents (lunettes, nuit) peut
   former deux groupes ; le second, resté anonyme, rejoint l'acteur déjà nommé s'il lui
   ressemble nettement (et ressemble au groupe déjà nommé), ou s'il lui ressemble assez *et*
   ne ressemble à aucun autre acteur de la distribution.

Trois bandes de note, relatives au seuil de rejet `T` (0,30 pour `buffalo_l`) :

- **sûre**, `T + 0,10` et au-delà (0,40) : nommé, comme avant ;
- **à confirmer**, de `T + 0,045` à `T + 0,10` (0,345 – 0,40) : nommé seulement si le deuxième
  acteur le plus ressemblant est loin derrière (écart ≥ 0,15) *et* si le groupe a été vu assez
  (2 s ou 2 pistes). Mesuré le 09/11/2026 sur trois titres (MacGyver S01E06, The Pitt S02E01,
  Bullet Train) : chaque groupe jugeable de cette bande était le bon acteur — couché, masqué,
  chapeau et lunettes —, et le deuxième acteur n'y dépassait jamais 0,25 ;
- **douteuse**, sous `T + 0,045` : anonyme. Les deux seuls noms donnés dans cette bande par
  l'ancienne règle (0,31 pour une seconde de présence, 0,33) n'étaient pas confirmés à l'image.

La seconde passe ne nomme pas non plus un groupe de moins d'une seconde : il n'ajouterait rien
de visible à l'acteur, et c'est là que se logeaient ses erreurs (un quatrième « même acteur »
d'une demi-seconde).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .faces import normalize

TOP_K = 3
# Bandes de note, en écart au seuil de rejet (voir l'en-tête).
SURE_MARGIN = 0.10
DOUBT_MARGIN = 0.045       # 0,345 : le chapeau et les lunettes de Bullet Train notent 0,349
DOUBT_GAP = 0.15            # écart minimal au deuxième acteur dans la bande « à confirmer »
DOUBT_MIN_TIME = 2.0        # … et présence minimale : 2 s, ou 2 pistes
DOUBT_MIN_TRACKS = 2
SECOND_PASS_MIN_TIME = 1.0
# Ressemblance minimale au groupe déjà nommé, en écart au seuil de regroupement (note sûre).
TWIN_MARGIN = 0.10


def cluster_embeddings(embs: np.ndarray, threshold: float) -> np.ndarray:
    """Étiquette de groupe (0..k-1) de chaque empreinte ; `threshold` en similarité cosinus."""
    n = len(embs)
    if n == 0:
        return np.zeros(0, dtype=np.int64)
    if n == 1:
        return np.zeros(1, dtype=np.int64)
    from scipy.cluster.hierarchy import fcluster, linkage
    from scipy.spatial.distance import pdist

    d = np.clip(pdist(normalize(embs.astype(np.float64)), metric="cosine"), 0.0, 2.0)
    z = linkage(d, method="average")
    labels = fcluster(z, t=1.0 - threshold, criterion="distance")
    # Renumérotation stable : par ordre de première apparition.
    order: dict[int, int] = {}
    out = np.empty(n, dtype=np.int64)
    for i, l in enumerate(labels):
        out[i] = order.setdefault(int(l), len(order))
    return out


@dataclass
class PersonRefs:
    person_id: int
    photos: np.ndarray            # (m, d), peut être vide
    series: np.ndarray | None = None  # (d,) empreinte apprise dans les épisodes précédents


@dataclass
class Assignment:
    person_id: int
    score: float
    confidence: float
    photo_score: float


def person_score(centroid: np.ndarray, ref: PersonRefs) -> tuple[float, float]:
    """(note retenue, note par les seules photos)."""
    photo = -1.0
    if len(ref.photos):
        sims = np.sort(ref.photos @ centroid)[::-1]
        photo = float(sims[: min(TOP_K, len(sims))].mean())
    series = float(ref.series @ centroid) if ref.series is not None else -1.0
    return max(photo, series), photo


def confidence(score: float, threshold: float) -> float:
    """Logistique centrée sur le seuil : 0,5 au seuil, ~0,9 à +0,18, ~0,99 à +0,38."""
    return 1.0 / (1.0 + math.exp(-(score - threshold) * 12.0))


def acceptable(score: float, runner_up: float, seen: float, tracks: int, threshold: float) -> bool:
    """Une note suffit-elle à nommer ? `runner_up` : meilleure note d'un *autre* acteur ;
    `seen` : temps de présence du groupe (s) ; `tracks` : son nombre de pistes."""
    if score >= threshold + SURE_MARGIN:
        return True
    if score < threshold + DOUBT_MARGIN:
        return False
    return score - max(runner_up, 0.0) >= DOUBT_GAP and (seen >= DOUBT_MIN_TIME or tracks >= DOUBT_MIN_TRACKS)


def _runner_up(row: np.ndarray, j: int) -> float:
    """Meilleure note de la ligne hors de la colonne `j` (0 s'il n'y a qu'un acteur)."""
    if len(row) < 2:
        return 0.0
    rest = np.delete(row, j)
    return float(rest.max())


def label_clusters(
    centroids: np.ndarray,
    weights: np.ndarray,
    refs: list[PersonRefs],
    threshold: float,
    cluster_threshold: float,
    tracks: np.ndarray | None = None,
) -> dict[int, Assignment]:
    """Rend {rang du groupe: attribution} pour les groupes nommés ; les autres sont anonymes.
    `weights` : temps de présence de chaque groupe ; `tracks` : son nombre de pistes (inconnu :
    la présence seule compte)."""
    k = len(centroids)
    p = len(refs)
    if k == 0 or p == 0:
        return {}
    from scipy.optimize import linear_sum_assignment

    if tracks is None:
        tracks = np.zeros(k, dtype=np.int64)
    centroids = normalize(centroids.astype(np.float32))
    score = np.full((k, p), -1.0, dtype=np.float64)
    photo = np.full((k, p), -1.0, dtype=np.float64)
    for j, ref in enumerate(refs):
        for i in range(k):
            score[i, j], photo[i, j] = person_score(centroids[i], ref)
    ok = np.zeros((k, p), dtype=bool)
    for i in range(k):
        for j in range(p):
            ok[i, j] = acceptable(score[i, j], _runner_up(score[i], j), float(weights[i]), int(tracks[i]), threshold)
    # Légère préférence aux groupes les plus présents : à notes voisines, le personnage vu
    # trois minutes l'emporte sur un groupe de deux secondes.
    w = 1.0 + 0.05 * np.log1p(np.maximum(weights, 0.0))[:, None]
    gain = np.where(ok, score * w, 0.0)
    rows, cols = linear_sum_assignment(-gain)
    out: dict[int, Assignment] = {}
    for i, j in zip(rows, cols):
        if ok[i, j]:
            out[int(i)] = Assignment(refs[j].person_id, float(score[i, j]), confidence(score[i, j], threshold),
                                     float(photo[i, j]))
    # Seconde passe (voir l'en-tête) : groupes scindés d'un même acteur.
    named = {a.person_id: i for i, a in out.items()}
    for i in range(k):
        if i in out or float(weights[i]) < SECOND_PASS_MIN_TIME:
            continue
        j = int(np.argmax(score[i]))
        pid = refs[j].person_id
        if pid not in named:
            continue
        s = float(score[i, j])
        if s >= threshold + SURE_MARGIN:
            # Note sûre : il suffit qu'il ressemble aussi au groupe déjà nommé.
            if float(centroids[i] @ centroids[named[pid]]) < cluster_threshold - TWIN_MARGIN:
                continue
        elif not ok[i, j]:
            continue
        out[i] = Assignment(pid, s, confidence(s, threshold), float(photo[i, j]))
    return out
