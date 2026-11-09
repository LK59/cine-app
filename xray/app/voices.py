"""« Qui parle » : des fenêtres de voix aux voix nommées (assemblage, sans réseau ni modèle).

Entrées, toutes en base tronçon par tronçon (`voice.py` les produit) : les zones de parole que
Silero trouve, et une empreinte de voix par fenêtre de 1,5 s (pas de 0,5 s) dans ces zones. Le
reste se refait ici à chaque point d'étape, comme les scènes (`results.py`) :

1. **Morceaux.** Chaque zone de parole est coupée en morceaux de 3 s au plus, de longueurs égales :
   l'unité qui reçoit une voix. L'empreinte d'un morceau est la moyenne des fenêtres qui tombent
   pour moitié au moins dedans (sinon la fenêtre la plus centrée qui le recouvre). C'est l'unité du
   banc de R&D (une réplique de sous-titre), retrouvée sans sous-titres : Laterna aligne ensuite
   ses répliques, dans n'importe quelle langue, par les temps.
2. **Voix.** Les morceaux sont regroupés par lien moyen sur la distance cosinus.
3. **Noms, par contraste local** avec les visages d'« À l'écran » : pour une voix et une personne,
   sa présence à l'image pendant les morceaux de cette voix, moins sa présence pendant ceux des
   autres voix des mêmes scènes. Un champ-contrechamp montre les deux interlocuteurs ; seul celui
   qui parle est plus souvent à l'image quand *sa* voix parle. Puis la seconde chance (une personne
   déjà prise par une autre voix nettement différente est écartée), « une personne, une voix » (une
   seconde grosse voix nettement différente de la principale reste sans nom : une voix au téléphone
   ne reçoit pas le nom du seul visage à l'écran), et une seconde passe morceau par morceau contre
   le profil de chaque personne nommée.
4. **Stabilité** (le défaut du banc : un seuil qui scinde ou fusionne une voix change tout) : le
   regroupement est fait à trois seuils, et un morceau ne garde un nom que si deux avis au moins le
   donnent, et aucun autre nom (`consensus`). La **mémoire de la série** (`series_voices`, comme
   `series_faces`) : la voix moyenne de chaque personne nommée avec assurance dans les épisodes
   précédents ; elle nomme une voix que les visages laissent sans nom, et retire le nom d'une voix
   qu'elle attribue nettement à quelqu'un d'autre.

Les sorties sont des segments `{start, end, voiceId, personId|null, confidence, conflict?}` : des morceaux
voisins de la même voix sont joints. `confidence` (0..1) est la part des avis qui donnent ce nom,
réduite quand le morceau ressemble peu à la voix de la personne. Laterna ne préfixe une réplique
que d'un nom donné avec assez de confiance.
"""

from __future__ import annotations

import collections
from dataclasses import dataclass, field

import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage

# Fenêtres d'empreinte (voice.py) : partagées pour que l'assemblage sache leur longueur.
WIN_S = 1.5
HOP_S = 0.5


@dataclass(frozen=True)
class VoiceParams:
    # Morceaux (banc du 09/11/2026 : 2 s et la coupe aux changements de voix à 0,5 donnent la meilleure
    # précision ; 3 s sans coupe mêlait deux voix dans un morceau sur dix)
    max_piece: float = 2.0
    # Changement de voix dans une zone : distance cosinus entre deux fenêtres voisines sans recouvrement
    # (1,5 s d'écart) au-delà de laquelle la zone est coupée (0 : jamais).
    change: float = 0.5
    min_speech_share: float = 0.15
    # Regroupement : distances cosinus (1 − similarité), lien moyen. Plusieurs : consensus.
    thresholds: tuple[float, ...] = (0.65, 0.70, 0.75)
    need: int = 2
    # Contraste local (banc de R&D, 09/11/2026)
    min_lines: int = 3
    min_score: float = 0.10
    min_margin: float = 0.06
    min_presence: float = 0.3
    # Seconde chance : une personne prise par une autre voix moins semblable que ceci est écartée.
    exclusive_cos: float = 0.5
    # Une personne, une voix
    onevoice_cos: float = 0.6
    bigvoice: int = 20
    # Seconde passe, morceau par morceau
    tau: float = 0.5
    tau_margin: float = 0.1
    # Mémoire de la série
    memory_tau: float = 0.55
    memory_margin: float = 0.1
    # Ce qui nourrit la mémoire : une voix nommée par les visages, assez fournie et nette.
    memory_min_lines: int = 8
    # Deux personnes dont les voix se ressemblent plus que ceci (cosinus) : aucune n'est retenue.
    memory_distinct_cos: float = 0.6


DEFAULT_PARAMS = VoiceParams()


@dataclass
class VoiceResult:
    segments: list[dict]
    # Profils de voix des personnes nommées par les visages (pour la mémoire de la série) :
    # {personId: (empreinte normalisée, nombre de morceaux)}.
    profiles: dict[int, tuple[np.ndarray, int]] = field(default_factory=dict)
    stats: dict = field(default_factory=dict)
    # Par morceau (pour les bancs) : bornes, voix, personne, confiance.
    pieces: list[tuple[float, float, int, int | None, float]] = field(default_factory=list)


def normalize_rows(x: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(x, axis=1, keepdims=True)
    return x / np.maximum(n, 1e-9)


def make_pieces(regions: list[tuple[float, float]], max_piece: float) -> list[tuple[float, float]]:
    """Chaque zone en morceaux égaux de `max_piece` au plus."""
    out = []
    for s, e in sorted(regions):
        d = e - s
        if d <= 0:
            continue
        n = max(1, int(np.ceil(d / max_piece - 1e-9)))
        step = d / n
        for k in range(n):
            out.append((s + k * step, s + (k + 1) * step))
    return out


def split_on_change(regions: list[tuple[float, float]], wins: np.ndarray, unit: np.ndarray, thr: float) -> list[tuple[float, float]]:
    """Coupe une zone de parole là où la voix change : entre deux fenêtres qui se suivent sans se
    recouvrir (la fenêtre i et la fenêtre i+3, 1,5 s plus loin), une distance cosinus au-dessus de
    `thr` et plus haute que ses deux voisines marque une coupe à leur jointure. Deux répliques
    enchaînées sans silence (un échange rapide) ne forment plus un seul morceau."""
    if thr <= 0 or len(wins) == 0:
        return regions
    step = int(round(WIN_S / HOP_S))
    out = []
    order = np.argsort(wins[:, 0])
    ws = wins[order]
    for s, e in regions:
        lo = np.searchsorted(ws[:, 0], s - 1e-6)
        hi = np.searchsorted(ws[:, 0], e + 1e-6)
        idx = [order[k] for k in range(lo, hi) if ws[k, 1] <= e + 1e-6]
        cuts = []
        if len(idx) > step:
            d = np.array([1.0 - float(unit[idx[k]] @ unit[idx[k + step]]) for k in range(len(idx) - step)])
            # Une suite de distances au-dessus du seuil autour d'un même changement : une seule coupe, au
            # plus haut de la suite.
            k = 0
            while k < len(d):
                if d[k] < thr:
                    k += 1
                    continue
                j = k
                while j + 1 < len(d) and d[j + 1] >= thr:
                    j += 1
                best = k + int(np.argmax(d[k:j + 1]))
                t = float(wins[idx[best], 1])
                if t - (cuts[-1] if cuts else s) >= 0.75 and e - t >= 0.75:
                    cuts.append(t)
                k = j + 1
        a = s
        for t in cuts:
            out.append((a, t))
            a = t
        out.append((a, e))
    return out


def piece_embeddings(pieces: list[tuple[float, float]], wins: np.ndarray, embs: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(empreintes normalisées, morceau utilisable). Une fenêtre compte si la moitié d'elle au moins
    tombe dans le morceau ; sinon, la plus centrée qui le recouvre de 0,3 s au moins."""
    d = embs.shape[1] if embs.ndim == 2 and len(embs) else 256
    out = np.zeros((len(pieces), d), dtype=np.float32)
    ok = np.zeros(len(pieces), dtype=bool)
    if len(wins) == 0:
        return out, ok
    unit = normalize_rows(embs.astype(np.float32))
    ws, we = wins[:, 0], wins[:, 1]
    centers = (ws + we) / 2
    order = np.argsort(ws)
    ws_sorted = ws[order]
    for i, (s, e) in enumerate(pieces):
        # Fenêtres candidates : celles qui commencent avant la fin du morceau et finissent après son début.
        lo = np.searchsorted(ws_sorted, s - WIN_S - 1e-6)
        hi = np.searchsorted(ws_sorted, e + 1e-6)
        idx = order[lo:hi]
        if len(idx) == 0:
            continue
        ov = np.minimum(we[idx], e) - np.maximum(ws[idx], s)
        sel = idx[ov >= 0.5 * (we[idx] - ws[idx])]
        if len(sel) == 0:
            near = idx[ov > 0.3]
            if len(near) == 0:
                continue
            sel = near[[int(np.argmin(np.abs(centers[near] - (s + e) / 2)))]]
        v = unit[sel].mean(0)
        nv = np.linalg.norm(v)
        if nv > 1e-6:
            out[i] = v / nv
            ok[i] = True
    return out, ok


def presence_matrix(pieces: list[tuple[float, float]], presence: list[tuple[float, float, int, float]]) -> tuple[np.ndarray, list[int]]:
    """Part de chaque morceau où chaque personne est à l'image (plans × part visible), bornée à 1."""
    pids = sorted({p for _, _, p, _ in presence})
    col = {p: k for k, p in enumerate(pids)}
    pres = np.zeros((len(pieces), len(pids)), dtype=np.float64)
    if not pids or not pieces:
        return pres, pids
    shots = sorted(presence, key=lambda r: r[0])
    starts = np.array([r[0] for r in shots])
    max_len = max(r[1] - r[0] for r in shots)
    for i, (s, e) in enumerate(pieces):
        dur = max(e - s, 1e-3)
        lo = np.searchsorted(starts, s - max_len - 1e-6)
        hi = np.searchsorted(starts, e + 1e-6)
        for a, b, p, frac in shots[lo:hi]:
            ov = min(e, b) - max(s, a)
            if ov > 0:
                pres[i, col[p]] += ov / dur * frac
    return np.minimum(pres, 1.0), pids


def scene_index(pieces: list[tuple[float, float]], scenes: list[dict]) -> np.ndarray:
    starts = np.array([float(s["start"]) for s in scenes]) if scenes else np.zeros(0)
    ends = np.array([float(s["end"]) for s in scenes]) if scenes else np.zeros(0)
    out = -np.ones(len(pieces), dtype=np.int64)
    for i, (s, e) in enumerate(pieces):
        t = (s + e) / 2
        k = int(np.searchsorted(starts, t, side="right")) - 1
        if 0 <= k < len(starts) and t < ends[k]:
            out[i] = k
    return out


def cluster_pieces(E: np.ndarray, ok: np.ndarray, thr: float) -> np.ndarray:
    """Rang de voix par morceau (1…), −1 pour un morceau sans empreinte."""
    labels = -np.ones(len(E), dtype=np.int64)
    idx = np.where(ok)[0]
    if len(idx) == 1:
        labels[idx] = 1
    elif len(idx) > 1:
        sims = E[idx] @ E[idx].T
        iu = np.triu_indices(len(idx), 1)
        dist = np.clip(1.0 - sims[iu], 0.0, 2.0)
        labels[idx] = fcluster(linkage(dist, "average"), thr, "distance")
    return labels


def _unit(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v)
    return v / n if n > 1e-9 else v


def name_once(E: np.ndarray, ok: np.ndarray, pres: np.ndarray, scene_of: np.ndarray, pids: list[int],
              thr: float, p: VoiceParams, memory: dict[int, np.ndarray] | None = None):
    """Un avis : regroupement à `thr`, noms par contraste, seconde chance, une personne une voix,
    mémoire de la série, seconde passe. Rend (voix par morceau, personne par morceau ou None,
    personnes nommées par les visages seuls → leurs morceaux)."""
    labels = cluster_pieces(E, ok, thr)
    voices = sorted(int(v) for v in set(labels.tolist()) if v > 0)
    n = len(E)
    pred: list[int | None] = [None] * n
    face_named: dict[int, list[int]] = {}
    conflict: set[int] = set()
    if not voices:
        return labels, pred, face_named, conflict
    members = {v: np.where(labels == v)[0] for v in voices}
    cent = {v: _unit(E[members[v]].mean(0)) for v in voices}
    M: dict[int, dict] = {}
    for v in voices:
        mine = members[v]
        entry = {"n": len(mine), "pid": None, "score": -1.0, "margin": 0.0, "present": 0.0, "scores": None, "pres": None}
        if pids:
            sc = set(scene_of[mine].tolist()) - {-1}
            other = np.where((labels != v) & (labels > 0) & np.isin(scene_of, list(sc)))[0] if sc else np.zeros(0, int)
            a = pres[mine].mean(0)
            b = pres[other].mean(0) if len(other) else np.zeros(len(pids))
            score = a - b
            o = np.argsort(-score)
            best, second = int(o[0]), int(o[1] if len(o) > 1 else o[0])
            entry.update(pid=pids[best], score=float(score[best]),
                         margin=float(score[best] - score[second]) if len(o) > 1 else float(score[best]),
                         present=float(a[best]), scores=score, pres=a)
        M[v] = entry

    def accepted(m) -> bool:
        return (m["pid"] is not None and m["n"] >= p.min_lines and m["score"] >= p.min_score
                and m["margin"] >= p.min_margin and m["present"] >= p.min_presence)

    # Seconde chance : deux personnes toujours ensemble à l'image (un couple) — celle qu'une autre
    # voix, nettement différente, a déjà prise est écartée, la marge recalculée sur les autres.
    for _ in range(3):
        owners = {v: M[v]["pid"] for v in voices if accepted(M[v])}
        for v in voices:
            m = M[v]
            if accepted(m) or m["n"] < p.min_lines or m["scores"] is None:
                continue
            taken = {pid for w, pid in owners.items() if w != v and float(cent[w] @ cent[v]) < p.exclusive_cos}
            keep = [k for k, pid in enumerate(pids) if pid not in taken]
            if not keep or len(keep) == len(pids):
                continue
            sc = m["scores"]
            o = sorted(keep, key=lambda k: -sc[k])
            b, s2 = o[0], (o[1] if len(o) > 1 else o[0])
            m2 = dict(m, pid=pids[b], score=float(sc[b]), margin=float(sc[b] - sc[s2]) if len(o) > 1 else float(sc[b]),
                      present=float(m["pres"][b]))
            if accepted(m2):
                M[v] = m2

    # Une personne, une voix : la plus fournie garde le nom ; une autre, nettement différente et
    # grosse, est presque toujours une voix hors champ (téléphone, narration).
    acc = [v for v in voices if accepted(M[v])]
    for pid in {M[v]["pid"] for v in acc}:
        vs = sorted([v for v in acc if M[v]["pid"] == pid], key=lambda v: -M[v]["n"])
        for w in vs[1:]:
            if float(cent[w] @ cent[vs[0]]) < p.onevoice_cos and M[w]["n"] >= p.bigvoice:
                M[w] = dict(M[w], score=-1.0)

    named = {v: M[v]["pid"] for v in voices if accepted(M[v])}
    for v, pid in named.items():
        face_named.setdefault(pid, []).extend(members[v].tolist())

    # Mémoire de la série : une voix qui ressemble nettement à une personne retenue (de cette
    # distribution) la nomme si les visages ne l'ont pas fait ; si les visages en nomment une autre,
    # le désaccord la laisse sans nom.
    if memory:
        mids = [pid for pid in memory]
        P = np.stack([memory[pid] for pid in mids])
        for v in voices:
            if M[v]["n"] < p.min_lines:
                continue
            s = P @ cent[v]
            o = np.argsort(-s)
            top = float(s[o[0]])
            second = float(s[o[1]]) if len(o) > 1 else -1.0
            if top >= p.memory_tau and top - second >= p.memory_margin:
                mem_pid = mids[int(o[0])]
                if v in named and named[v] != mem_pid:
                    # Les visages disent l'un, la mémoire l'autre : la voix reste sans nom, et le dit.
                    del named[v]
                    conflict.update(members[v].tolist())
                elif v not in named:
                    named[v] = mem_pid

    for v, pid in named.items():
        for i in members[v]:
            pred[i] = pid

    # Seconde passe : profil de voix par personne (moyenne de ses morceaux nommés), puis chaque morceau
    # encore anonyme rejoint le profil le plus proche s'il l'emporte nettement.
    prof_ids = sorted({pid for pid in pred if pid is not None})
    if prof_ids:
        prof = np.stack([_unit(E[[i for i in range(n) if pred[i] == pid]].mean(0)) for pid in prof_ids])
        rest = [i for i in range(n) if pred[i] is None and ok[i]]
        if rest:
            sims = E[rest] @ prof.T
            for j, i in enumerate(rest):
                o = np.argsort(-sims[j])
                b = float(sims[j, o[0]])
                s2 = float(sims[j, o[1]]) if len(o) > 1 else -1.0
                if b >= p.tau and b - s2 >= p.tau_margin:
                    if i not in conflict:
                        pred[i] = prof_ids[int(o[0])]
    return labels, pred, face_named, conflict


def build(regions: list[tuple[float, float]], wins: np.ndarray, embs: np.ndarray,
          presence: list[tuple[float, float, int, float]], scenes: list[dict],
          memory: dict[int, np.ndarray] | None = None, params: VoiceParams = DEFAULT_PARAMS) -> VoiceResult:
    p = params
    wins = np.asarray(wins, dtype=np.float64).reshape(-1, 2)
    embs = np.asarray(embs, dtype=np.float32)
    if p.change > 0 and len(wins):
        regions = split_on_change(sorted(regions), wins, normalize_rows(embs), p.change)
    pieces = make_pieces(regions, p.max_piece)
    if not pieces:
        return VoiceResult([], {}, {"pieces": 0, "voices": 0, "named": 0})
    E, ok = piece_embeddings(pieces, wins, embs)
    pres, pids = presence_matrix(pieces, presence)
    scene_of = scene_index(pieces, scenes)
    mem = {pid: v for pid, v in (memory or {}).items() if pid in set(pids)} if memory else None

    votes: list[collections.Counter] = [collections.Counter() for _ in pieces]
    conflicts = np.zeros(len(pieces), dtype=np.int64)
    ref_labels = None
    face_named_all: dict[int, list[int]] = {}
    mid = len(p.thresholds) // 2
    for k, thr in enumerate(p.thresholds):
        labels, pred, face_named, conflict = name_once(E, ok, pres, scene_of, pids, thr, p, mem)
        for i, who in enumerate(pred):
            votes[i][who] += 1
        for i in conflict:
            conflicts[i] += 1
        if k == mid:
            ref_labels, face_named_all = labels, face_named
    assert ref_labels is not None

    final: list[int | None] = [None] * len(pieces)
    agree = np.zeros(len(pieces))
    runs = len(p.thresholds)
    need = min(p.need, runs)
    # Mémoire de la série et visages en désaccord dans assez d'avis : pas de nom, jamais (consigne du
    # propriétaire, 09/11/2026) — le segment le dit (`conflict`).
    in_conflict = conflicts >= need
    for i, c in enumerate(votes):
        if in_conflict[i]:
            continue
        names = [(k, v) for k, v in c.most_common() if k is not None]
        if not names:
            continue
        who, count = names[0]
        if count >= need and (len(names) == 1 or names[1][1] < count) and c[None] < count:
            final[i] = who
            agree[i] = count / runs

    # Profil de voix final de chaque personne nommée, et ressemblance de chaque morceau à son profil :
    # un morceau qui ressemble peu à la voix qu'on lui donne perd de la confiance.
    named_ids = sorted({w for w in final if w is not None})
    conf = np.zeros(len(pieces))
    if named_ids:
        prof = {pid: _unit(E[[i for i in range(len(pieces)) if final[i] == pid]].mean(0)) for pid in named_ids}
        for i, who in enumerate(final):
            if who is None:
                continue
            sim = float(E[i] @ prof[who]) if ok[i] else 0.0
            # 0,6 de similarité au profil et plus : la confiance est la part des avis ; en dessous,
            # elle baisse jusqu'à moitié à 0,2.
            shrink = 1.0 if sim >= 0.6 else max(0.5, 0.5 + (sim - 0.2) * 1.25)
            conf[i] = round(float(agree[i] * shrink), 3)

    # Profils pour la mémoire : seulement des voix nommées par les visages, fournies et nettes, dont le
    # nom final est le même (le consensus ne l'a pas retiré).
    profiles: dict[int, tuple[np.ndarray, int]] = {}
    for pid, idx in face_named_all.items():
        idx = [i for i in idx if final[i] == pid and ok[i]]
        if len(idx) >= p.memory_min_lines:
            profiles[pid] = (_unit(E[idx].mean(0)), len(idx))
    # Une personne au profil trop proche d'une autre (deux voix confondues) ne nourrit pas la mémoire.
    ids = list(profiles)
    for a in ids:
        for b in ids:
            if a < b and a in profiles and b in profiles and float(profiles[a][0] @ profiles[b][0]) > p.memory_distinct_cos:
                profiles.pop(a, None)
                profiles.pop(b, None)

    # Segments : morceaux voisins (moins de 0,3 s d'écart) de la même voix, du même nom et de confiance
    # proche, joints.
    segs: list[dict] = []
    piece_rows = []
    for i, (s, e) in enumerate(pieces):
        v = int(ref_labels[i])
        who = final[i]
        c = float(conf[i]) if who is not None else 0.0
        cf = bool(in_conflict[i])
        piece_rows.append((s, e, v, who, c))
        if v <= 0:
            continue  # pas d'empreinte (morceau trop court) : rien à dire
        last = segs[-1] if segs else None
        if (last is not None and last["voiceId"] == v and last["personId"] == who and s - last["end"] < 0.3
                and abs(last["confidence"] - c) < 1e-6 and last.get("conflict", False) == cf):
            last["end"] = round(e, 3)
            continue
        seg = {"start": round(s, 3), "end": round(e, 3), "voiceId": v, "personId": who, "confidence": round(c, 3)}
        if cf:
            seg["conflict"] = True
        segs.append(seg)
    # Par voix (au seuil du milieu) : nommée (la plupart de ses morceaux ont un nom), en désaccord
    # (visages et mémoire), indécise, ou trop petite (moins de `min_lines` morceaux) — de quoi juger plus tard où une lecture des lèvres servirait.
    vstat = collections.Counter()
    for v in sorted(set(int(x) for x in ref_labels if x > 0)):
        idx = np.where(ref_labels == v)[0]
        if len(idx) < p.min_lines:
            vstat["small"] += 1
        elif in_conflict[idx].mean() >= 0.5:
            vstat["conflict"] += 1
        elif sum(1 for i in idx if final[i] is not None) >= 0.5 * len(idx):
            vstat["named"] += 1
        else:
            vstat["undecided"] += 1
    stats = {
        "pieces": len(pieces),
        "voiced": int(ok.sum()),
        "voices": int(len(set(int(x) for x in ref_labels if x > 0))),
        "named": int(sum(1 for w in final if w is not None)),
        "conflictPieces": int(in_conflict.sum()),
        # Part du temps de parole (morceaux avec empreinte) qui porte un nom.
        "speechNamed": round(sum(e - s for (s, e), w, k in zip(pieces, final, ok) if w is not None and k)
                             / max(sum(e - s for (s, e), k in zip(pieces, ok) if k), 1e-9), 4) if ok.any() else None,
        "people": len(named_ids),
        "memory": len(mem or {}),
        "voicesNamed": int(vstat["named"]),
        "voicesUndecided": int(vstat["undecided"]),
        "voicesConflict": int(vstat["conflict"]),
        "voicesSmall": int(vstat["small"]),
    }
    return VoiceResult(segs, profiles, stats, piece_rows)
