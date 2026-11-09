"""Des visages détectés aux pistes d'un plan : quels visages empreinter, par lots.

Avant (jusqu'au 09/11/2026), chaque bon visage était empreinté dès sa détection, un appel du
réseau par image. Désormais, pour chaque plan :

1. les pistes se forment sans empreinte (recouvrement des cadres, `tracks.link`) ;
2. un plan où ce lien sans empreinte serait douteux (`tracks.needs_full`) passe par la règle
   d'avant : tous ses bons visages empreintés, pistes refaites avec leurs empreintes ;
3. ailleurs, seuls les `faces_per_track` meilleurs visages de chaque piste sont empreintés ;
4. **mémoire de la série** : le meilleur visage d'une piste est empreinté d'abord ; s'il
   ressemble très nettement à une personne déjà nommée dans la série (`EARLY_SIM`) et nettement
   plus qu'à toute autre (`EARLY_MARGIN`), les autres visages de la piste ne sont pas empreintés.
   La piste suit ensuite le même chemin que les autres (regroupement, noms) : seule son
   empreinte repose sur un visage au lieu de deux.

Les images attendent que plusieurs plans soient prêts : la détection part par lots de
`DETECT_BATCH` images (si le moteur le permet), les empreintes par lots de `embed_batch` visages —
un appel du réseau pour 32 visages coûte moins que 32 appels.
"""

from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np

from .faces import Face
import os

from .tracking import TRACK_QUALITY, propagate, roi_redetect

TRACK_MODE = os.environ.get("XRAY_TRACK_MODE", "roi")
from .tracks import Track, TrackSummary, accepted_faces, best_faces, link, needs_full, summarize

# Sortie anticipée par la mémoire de la série : similarité au plus ressemblant, et avance sur le
# deuxième. Mesuré le 09/11/2026 sur MacGyver S01E06 (mémoire de S01E05) et The Pitt S02E01
# (mémoire de S01E01), 588 pistes comparées à leur sort avec deux empreintes : dès 0,60, la
# personne désignée par la mémoire était toujours le nom final de la piste (430 cas) ; le seul
# désaccord au-dessus de 0,50 était à 0,585 (Lucas Till, dans un groupe resté anonyme). L'avance
# n'y descendait jamais sous 0,39 : 0,25 ne joue que pour deux personnages très proches. Rejoué
# hors ligne avec ces seuils, chaque épisode rend des scènes identiques à l'octet près.
EARLY_SIM = 0.60
EARLY_MARGIN = 0.25
# Images détectées par appel (OpenVINO) : par 8, une image coûte 25 à 30 % de moins qu'une à une
# (mesuré le 09/11/2026 sur 48 images de The Pitt, 8 fils), pour des sorties identiques.
DETECT_BATCH = 8


def memory_match(emb: np.ndarray, memory: np.ndarray | None) -> bool:
    """Le visage désigne-t-il sans ambiguïté une personne de la mémoire de la série ?"""
    if memory is None or len(memory) == 0:
        return False
    sims = memory @ emb
    if len(sims) == 1:
        best, second = float(sims[0]), 0.0
    else:
        top = np.partition(sims, -2)[-2:]
        best, second = float(top[1]), max(float(top[0]), 0.0)
    return best >= EARLY_SIM and best - second >= EARLY_MARGIN


@dataclass
class PendingShot:
    start: float
    end: float
    frames: list[list[Face]]
    tracks: list[Track]
    full: bool


class ShotFaces:
    """Reçoit les plans détectés, rend leurs pistes résumées — par lots d'empreintes."""

    def __init__(self, engine, clock, faces_per_track: int = 2, batch: int = 32,
                 memory: np.ndarray | None = None, every: int = 1):
        self.engine = engine
        # Essai 11/2026 : le détecteur sur une image analysée sur `every`, les autres portées
        # par le flot optique (`tracking.propagate`).
        self.every = max(1, every)
        self.clock = clock
        self.k = max(1, faces_per_track)
        self.batch = max(1, batch)
        self.memory = memory
        self.pending: list[PendingShot] = []
        self._waiting = 0  # visages de première passe en attente
        self.to_detect: list[tuple[float, float, list[np.ndarray], list, list[bool]]] = []
        self._images = 0
        self._found: list[list[Face]] = []  # détections des premières images en attente

    def add_images(self, start: float, end: float, images: list[np.ndarray], lumas: list | None = None) -> list[tuple[float, float, int, TrackSummary]]:
        """Un plan, par ses images choisies (BGR) : la détection part par lots pleins de
        `DETECT_BATCH` images, à cheval sur plusieurs plans ; le reste attend le plan suivant.
        `lumas[k]` : luminances des images décodées de l'image choisie k−1 à k (suivi)."""
        if self.every > 1 and lumas is not None:
            det = [k % self.every == 0 for k in range(len(images))]
        else:
            det = [True] * len(images)
        self.to_detect.append((start, end, images, lumas, det))
        self._images += len(images)
        return self._detect(final=False)

    def _detect(self, final: bool = True) -> list[tuple[float, float, int, TrackSummary]]:
        flat = [im for _, _, ims, _, det in self.to_detect for im, d in zip(ims, det) if d]
        done = len(self._found)
        todo = len(flat) - done
        n = todo if final else todo - todo % DETECT_BATCH
        for i in range(done, done + n, DETECT_BATCH):
            self._found += self.engine.detect_grade_batch(flat[i:min(i + DETECT_BATCH, done + n)])
        out = []
        # Les plans entièrement détectés passent aux pistes, dans l'ordre.
        while self.to_detect and len(self._found) >= sum(self.to_detect[0][4]):
            start, end, ims, lumas, det = self.to_detect.pop(0)
            nd = sum(det)
            found, self._found = self._found[:nd], self._found[nd:]
            frames: list[list[Face]] = []
            it = iter(found)
            for k, d in enumerate(det):
                if d:
                    frames.append(next(it))
                    continue
                t0 = time.perf_counter()
                if TRACK_MODE == "roi":
                    carried = roi_redetect(frames[-1], ims[k], self.engine.detector)
                else:
                    carried = propagate(frames[-1], lumas[k])
                self.clock.add("tracker", time.perf_counter() - t0)
                self.clock.count("tracked_images")
                self.clock.count("tracked_faces", len(carried))
                t0 = time.perf_counter()
                self.engine._grade(ims[k], carried)
                if TRACK_MODE != "roi":
                    for f in carried:
                        f.quality *= TRACK_QUALITY
                self.clock.add("grade", time.perf_counter() - t0)
                frames.append(carried)
            self._images -= len(ims)
            out += self.add(start, end, frames)
        return out

    def add(self, start: float, end: float, frames: list[list[Face]]) -> list[tuple[float, float, int, TrackSummary]]:
        t0 = time.perf_counter()
        tracks = link(frames)
        full = needs_full(tracks)
        self.pending.append(PendingShot(start, end, frames, tracks, full))
        if full:
            self._waiting += sum(len(accepted_faces(t)) for t in tracks)
        else:
            self._waiting += sum(1 for t in tracks if accepted_faces(t))
        self.clock.add("track", time.perf_counter() - t0)
        if self._waiting >= self.batch:
            return self._embed()
        return []

    def flush(self) -> list[tuple[float, float, int, TrackSummary]]:
        """Détecte et empreinte tout ce qui attend ; rend (début, fin du plan, images analysées,
        résumé) par piste."""
        return self._detect() + self._embed()

    def _embed(self) -> list[tuple[float, float, int, TrackSummary]]:
        if not self.pending:
            return []
        shots, self.pending, self._waiting = self.pending, [], 0
        clock = self.clock
        # 1. Première passe : tous les bons visages des plans « complets », le meilleur de chaque
        #    piste ailleurs.
        first: list[Face] = []
        rest: list[tuple[Track, list[Face]]] = []
        for sh in shots:
            if sh.full:
                for t in sh.tracks:
                    first.extend(accepted_faces(t))
            else:
                for t in sh.tracks:
                    best = best_faces(t, self.k)
                    if best:
                        first.append(best[0])
                        rest.append((t, best[1:]))
        self.engine.embed_faces(first)
        # 2. Seconde passe : les autres meilleurs visages, sauf piste reconnue par la mémoire.
        t0 = time.perf_counter()
        second: list[Face] = []
        for t, others in rest:
            if not others:
                continue
            head = best_faces(t, 1)[0]
            if memory_match(head.emb, self.memory):
                clock.count("early_exit")
                continue
            second.extend(others)
        clock.add("track", time.perf_counter() - t0)
        self.engine.embed_faces(second)
        # 3. Pistes : refaites avec les empreintes là où la règle complète s'applique.
        t0 = time.perf_counter()
        out = []
        for sh in shots:
            clock.count("full_shots" if sh.full else "lean_shots")
            tracks = link(sh.frames) if sh.full else sh.tracks
            for tr in tracks:
                summ = summarize(tr, len(sh.frames))
                if summ is not None:
                    out.append((sh.start, sh.end, len(sh.frames), summ))
            # Les visages alignés ne servent plus : la mémoire suit le plan, pas le tronçon.
            for frame in sh.frames:
                for f in frame:
                    f.crop = None
        clock.add("track", time.perf_counter() - t0)
        return out
