"""« Synchro des sous-titres » : un sous-titre texte est-il calé sur la parole du fichier, et sinon de combien.

**Le modèle.** `t_parole = a + s · t_sous-titre` — `a` un décalage (secondes), `s` une échelle (une dérive :
un sous-titre fait pour une autre cadence d'image, 25 i/s au lieu de 23,976, s'écarte d'une seconde toutes les
vingt-quatre). Laterna applique la correction à l'affichage ; aucun fichier n'est jamais réécrit.

**La mesure** (portée du prototype de R&D, mesurée sur huit titres et dix-sept sous-titres, 11/2026) :

1. deux masques binaires à 10 ms sur toute la durée : la parole (zones de la détection de parole, Silero, mêmes
   réglages que « qui parle ») et les répliques (sans celles qui ne sont que bruits : crochets, parenthèses, ♪) ;
2. **le décalage global** : la corrélation croisée des deux masques par FFT, à ±120 s, pour chacune des sept
   échelles connues (1, 25→23,976 et l'inverse, 24→23,976 et l'inverse, 25→24 et l'inverse) — la meilleure
   couverture gagne, sa netteté (`z`) est la hauteur du pic au-dessus du bruit de fond, en écarts types ;
3. **l'affinage local** : des fenêtres de 5 min du sous-titre, toutes les 2 min 30, chacune recorrélée à ±3 s
   autour de la prédiction globale (au moins 15 répliques, une zone dont la parole a été écoutée à 80 %) ;
   une fenêtre n'est gardée que si son pic est net (`z ≥ 3`) ;
4. **la droite** : Theil-Sen sur les fenêtres gardées (pente médiane des paires distantes de plus de 5 min,
   ordonnée médiane) → `a`, `s`, l'écart médian des fenêtres à la droite (`madMs`) et la part des fenêtres à
   moins de 0,3 s d'elle (`inliers`) ; l'échelle est ramenée au rapport connu le plus proche à 60 ppm près, à 1
   à 30 ppm près, et `a` recalculé avec elle.

**Fiable** si `z ≥ 5`, au moins 6 fenêtres, 80 % d'entre elles sur la droite, `madMs ≤ 150` et au moins 100
répliques de parole. **Verdicts** : `ok` (l'erreur ne dépasse jamais 0,5 s sur la durée du sous-titre),
`décalé` (échelle 1), `dérive` (une autre échelle), `incertain` (pas de mesure fiable), `montage` (des
fenêtres nettes qui ne tombent pas sur une droite : un autre montage, des coupures publicitaires…),
`peu-de-répliques` (moins de 100), et `image` pour une piste en images (PGS, VobSub), qu'on ne mesure pas.

Rien ici ne lit de fichier vidéo ni la base : des listes en entrée, un dictionnaire en sortie. La lecture du
son et des pistes est dans `subsyncjob.py`.
"""

from __future__ import annotations

import math
import re
from dataclasses import dataclass

import numpy as np

# Version de l'algorithme (gardée avec chaque résultat, rendue par l'API) : à monter quand un changement rend
# les mesures d'avant incomparables ; Laterna tient alors une mesure plus ancienne pour à refaire.
#   1 — (11/2026) première version, portée du prototype de R&D.
ALGO_VERSION = 1

RES = 0.01  # 10 ms par case de masque
MAX_LAG_S = 120.0
LOCAL_LAG_S = 3.0
WINDOW_S = 300.0
WINDOW_STEP_S = 150.0
MIN_WINDOW_CUES = 15
MIN_WINDOW_COVER = 0.8
MIN_WINDOW_Z = 3.0
PAIR_MIN_DX_S = 300.0
INLIER_S = 0.3
SNAP_ONE_PPM = 30e-6
SNAP_RATIO_PPM = 60e-6
SNAP_SPAN_S = 0.15
# « montage » : des fenêtres nettes qui ne tombent pas sur une droite — mais la plupart des fenêtres possibles
# (un sous-titre sans rapport avec le film en sort aussi un tiers de nettes, par hasard, sur le banc) et un pic
# global qui existe.
MONTAGE_WINDOW_SHARE = 0.6
MONTAGE_MIN_Z = 3.0
OK_MAX_ERROR_S = 0.5
# Les seuils de « fiable ».
RELIABLE_Z = 5.0
RELIABLE_WINDOWS = 6
RELIABLE_INLIERS = 0.8
RELIABLE_MAD_MS = 150.0
MIN_SPEECH_CUES = 100

FILM = 24000 / 1001  # 23,976 i/s
# Les échelles connues, et le nom de chacune dans le sens du modèle : `25→23.976` veut dire un sous-titre fait
# pour une copie à 25 i/s (accélérée de 4 %), posé sur un fichier à 23,976 — sa parole tombe plus tard que lui.
SCALES: tuple[tuple[str, float], ...] = (
    ("1", 1.0),
    ("25→23.976", 25 / FILM),
    ("23.976→25", FILM / 25),
    ("24→23.976", 24 / FILM),
    ("23.976→24", FILM / 24),
    ("25→24", 25 / 24),
    ("24→25", 24 / 25),
)

IMAGE_CODECS = {"hdmv_pgs_subtitle", "pgssub", "pgs", "dvd_subtitle", "dvdsub", "vobsub", "dvb_subtitle", "dvbsub",
                "xsub"}
TEXT_CODECS = {"subrip", "srt", "ass", "ssa", "webvtt", "vtt", "mov_text", "text"}

Cue = tuple[float, float]


# ---- lecture des sous-titres --------------------------------------------------------------------------

# Une ligne qui n'est qu'un bruit, une musique ou une indication (sous-titres pour sourds et malentendants) :
# « [rires] », « (soupir) », « ♪ … », « # … ». Le tiret de dialogue devant ne change rien.
_SOUND_LINE = re.compile(r"^\s*-?\s*(\[[^\]]*\]|\([^)]*\)|[♪♫].*|#.*)\s*$")
_TAGS = re.compile(r"<[^>]+>|\{[^}]*\}")
_TIMING = re.compile(r"(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})")
_TIMING_SHORT = re.compile(r"(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})")


def _secs(h: str | None, m: str, s: str, frac: str) -> float:
    # « ,5 » vaut une demi-seconde, pas cinq millièmes : la fraction est rapportée à sa propre longueur.
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(frac) / 10 ** len(frac)


def is_sound_line(line: str) -> bool:
    return bool(_SOUND_LINE.match(line))


def _keep(lines: list[str]) -> bool | None:
    """`True` : une réplique parlée ; `False` : rien que des bruits ; `None` : vide."""
    lines = [l.strip() for l in lines if l.strip()]
    if not lines:
        return None
    return any(not is_sound_line(l) for l in lines)


@dataclass
class ParsedCues:
    speech: list[Cue]
    sound: int
    total: int


def parse_srt(text: str) -> ParsedCues:
    """SubRip et WebVTT : un bloc par réplique, la ligne des temps puis le texte."""
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    speech: list[Cue] = []
    sound = total = 0
    for block in re.split(r"\n\s*\n", text):
        m = _TIMING.search(block) or _TIMING_SHORT.search(block)
        if not m:
            continue
        g = m.groups()
        start, end = _secs(g[0], g[1], g[2], g[3]), _secs(g[4], g[5], g[6], g[7])
        body = block[m.end():].split("\n")[1:] if "\n" in block[m.end():] else []
        keep = _keep([_TAGS.sub("", l) for l in body])
        if keep is None or end <= start:
            continue
        total += 1
        if keep:
            speech.append((start, end))
        else:
            sound += 1
    return ParsedCues(sorted(speech), sound, total)


_ASS_TIME = re.compile(r"^\s*(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})\s*$")


def parse_ass(text: str) -> ParsedCues:
    """ASS / SSA : les lignes `Dialogue:` de `[Events]`, champs nommés par la ligne `Format:`. Un dessin
    (`\\p1`) n'est pas une réplique ; `\\N` est un saut de ligne."""
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    fields: list[str] | None = None
    in_events = False
    speech: list[Cue] = []
    sound = total = 0
    for raw in text.split("\n"):
        line = raw.strip()
        if line.startswith("["):
            in_events = line.lower() == "[events]"
            continue
        if not in_events:
            continue
        if line.lower().startswith("format:"):
            fields = [f.strip().lower() for f in line.split(":", 1)[1].split(",")]
            continue
        if not line.lower().startswith("dialogue:"):
            continue
        names = fields or ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"]
        parts = line.split(":", 1)[1].split(",", len(names) - 1)
        if len(parts) < len(names):
            continue
        row = dict(zip(names, parts))
        ms, me = _ASS_TIME.match(row.get("start", "")), _ASS_TIME.match(row.get("end", ""))
        if not ms or not me:
            continue
        start, end = _secs(*ms.groups()), _secs(*me.groups())
        body = row.get("text", "")
        if re.search(r"\\p[1-9]", body):
            continue
        keep = _keep(_TAGS.sub("", body.replace("\\N", "\n").replace("\\n", "\n")).split("\n"))
        if keep is None or end <= start:
            continue
        total += 1
        if keep:
            speech.append((start, end))
        else:
            sound += 1
    return ParsedCues(sorted(speech), sound, total)


def parse_subtitle(text: str, kind: str) -> ParsedCues:
    """`kind` : l'extension ou le codec — ass/ssa, sinon SubRip/WebVTT."""
    k = kind.lower().lstrip(".")
    if k in ("ass", "ssa"):
        return parse_ass(text)
    return parse_srt(text)


# ---- masques et corrélations -----------------------------------------------------------------------------

def mask(intervals, n: int, a: float = 0.0, s: float = 1.0, origin: int = 0) -> np.ndarray:
    """Un masque binaire de `n` cases à partir de la case `origin`, chaque intervalle porté en `a + s·t`."""
    m = np.zeros(n, np.float32)
    for x, y in intervals:
        i = int(round((a + s * x) / RES)) - origin
        j = int(round((a + s * y) / RES)) - origin
        if j <= 0 or i >= n:
            continue
        m[max(i, 0):min(j, n)] = 1
    return m


def _nfft(n: int) -> int:
    return 1 << int(math.ceil(math.log2(max(2, n))))


def _peak(c: np.ndarray, maxlag: int, far_s: float) -> tuple[int, float, float]:
    """(décalage du pic en cases, hauteur, netteté z) — z : hauteur au-dessus de la médiane des décalages
    éloignés du pic de plus de `far_s`, en écarts types."""
    k = int(np.argmax(c))
    lags = np.arange(-maxlag, maxlag + 1)
    far = np.abs(lags - (k - maxlag)) > int(round(far_s / RES))
    rest = c[far]
    if rest.size < 2:
        return k - maxlag, float(c[k]), 0.0
    base, spread = float(np.median(rest)), float(np.std(rest))
    return k - maxlag, float(c[k]), (float(c[k]) - base) / max(spread, 1e-6)


@dataclass
class GlobalFit:
    name: str
    scale: float
    offset: float
    cover: float
    z: float


def global_offsets(speech_fft: np.ndarray, nfft: int, cues: list[Cue], n: int, maxlag: int) -> list[GlobalFit]:
    """Le décalage global pour chaque échelle connue ; la FFT de la parole est faite une fois pour toutes."""
    out = []
    for name, s in SCALES:
        sb = mask(cues, n, 0.0, s)
        total = float(sb.sum())
        if total <= 0:
            continue
        c = np.fft.irfft(speech_fft * np.conj(np.fft.rfft(sb, nfft)), nfft)
        # c[k] = Σ parole[t + k] · sous-titre[t] : le décalage qui pose le sous-titre sur la parole.
        cc = np.concatenate([c[-maxlag:], c[:maxlag + 1]]) / total
        lag, peak, z = _peak(cc, maxlag, 2.0)
        out.append(GlobalFit(name, s, lag * RES, peak, z))
    return out


def local_offset(speech: np.ndarray, valid: np.ndarray, cues: list[Cue], a: float, s: float) -> tuple[float, float] | None:
    """Le décalage d'une fenêtre autour de la prédiction `a + s·t`, à ±3 s : `(décalage, z)` ou `None`. Calculé
    sur la seule portion du film qu'elle touche — jamais une FFT de toute la durée par fenêtre."""
    lag = int(round(LOCAL_LAG_S / RES))
    lo = int(round((a + s * cues[0][0]) / RES)) - lag
    hi = int(round((a + s * max(e for _, e in cues)) / RES)) + lag + 1
    lo_c, hi_c = max(lo, 0), min(hi, len(speech))
    if hi_c - lo_c <= 2 * lag:
        return None
    seg = speech[lo_c:hi_c]
    sb = mask(cues, hi_c - lo_c, a, s, origin=lo_c)
    total = float(sb.sum())
    if total <= 0:
        return None
    # Zone dont la parole n'a pas été écoutée (tronçon pas fait, générique sauté) : la fenêtre ne dit rien.
    if float((sb * valid[lo_c:hi_c]).sum()) < MIN_WINDOW_COVER * total:
        return None
    nfft = _nfft(2 * len(seg))
    c = np.fft.irfft(np.fft.rfft(seg, nfft) * np.conj(np.fft.rfft(sb, nfft)), nfft)
    cc = np.concatenate([c[-lag:], c[:lag + 1]]) / total
    k, _, z = _peak(cc, lag, 0.6)
    return k * RES, z


def theil_sen(points: list[tuple[float, float]], fallback_slope: float) -> tuple[float, float]:
    xs = np.array([p[0] for p in points])
    ys = np.array([p[1] for p in points])
    slopes = [(ys[j] - ys[i]) / (xs[j] - xs[i]) for i in range(len(xs)) for j in range(i + 1, len(xs))
              if xs[j] - xs[i] > PAIR_MIN_DX_S]
    slope = float(np.median(slopes)) if slopes else fallback_slope
    return slope, float(np.median(ys - slope * xs))


def snap_scale(s: float, span: float | None = None) -> tuple[float, str | None]:
    """L'échelle ramenée à 1 (30 ppm) ou au rapport connu le plus proche (60 ppm) ; sinon telle quelle, sans nom.

    Et aussi quand l'écart ne déplace aucune réplique de plus de 0,15 s sur toute la piste (`span`, la fin de
    la dernière réplique) : sur un épisode de 40 min, la pente de Theil-Sen ne se tient qu'à 50 ou 100 ppm
    près — mesuré sur les fichiers du banc, un simple décalage de 2,5 s y sortait « dérive » de 0,13 s."""
    span = span or 0.0
    if abs(s - 1.0) <= SNAP_ONE_PPM or (span > 0 and abs(s - 1.0) * span <= SNAP_SPAN_S):
        return 1.0, "1"
    best = min(SCALES[1:], key=lambda r: abs(s / r[1] - 1.0))
    if abs(s / best[1] - 1.0) <= SNAP_RATIO_PPM or (span > 0 and abs(s - best[1]) * span <= SNAP_SPAN_S):
        return best[1], best[0]
    return s, None


def _mad(points: list[tuple[float, float]], s: float, a: float) -> float:
    return float(np.median([abs(y - (a + s * x)) for x, y in points]))


def snap_by_residuals(points: list[tuple[float, float]], slope: float, icpt: float) -> tuple[float, str | None]:
    """Le rapport connu qui explique les fenêtres presque aussi bien que la pente libre (écart médian au plus
    25 % ou 20 ms de plus) : une cadence d'image est un rapport exact, la pente libre n'en est qu'une estimation
    bruitée. Sur un épisode court du banc, la pente de Theil-Sen tombait à 0,6 % de 1 pour un simple décalage
    de 7 s — que la droite d'échelle 1 expliquait à 55 ms près."""
    free = _mad(points, slope, icpt)
    best: tuple[float, float, str] | None = None
    for name, r in SCALES:
        a = float(np.median([y - r * x for x, y in points]))
        m = _mad(points, r, a)
        if best is None or m < best[0]:
            best = (m, r, name)
    if best is not None and best[0] <= max(free * 1.25, free + 0.02):
        return best[1], best[2]
    return slope, None


def _cover(speech: np.ndarray, cues: list[Cue], a: float, s: float) -> float:
    sb = mask(cues, len(speech), a, s)
    total = float(sb.sum())
    return float((sb * speech).sum()) / total if total > 0 else 0.0


# ---- la mesure d'une piste -------------------------------------------------------------------------------

def measure(speech_regions: list[Cue], cues: list[Cue], valid_ranges: list[Cue] | None = None,
            sound_cues: int = 0, speech_fft_cache: dict | None = None, duration: float | None = None) -> dict:
    """Mesure une piste. `speech_regions` : la parole (secondes, horloge du fichier) ; `cues` : les répliques
    parlées ; `valid_ranges` : là où la parole a été écoutée (`None` : partout). `speech_fft_cache` : partagé
    entre les pistes d'un même élément, la parole n'est transformée qu'une fois ; `duration` (la durée du fichier)
    fixe la longueur des masques, la même pour toutes ses pistes.

    Rend un dictionnaire prêt pour l'API (`offset`, `scale`, `scaleLabel`, `z`, `madMs`, `windows`, `inliers`,
    `cover`, `maxErrorS`, `reliable`, `confidence`, `verdict`, …)."""
    cues = sorted((float(x), float(y)) for x, y in cues if y > x)
    out: dict = {"cues": len(cues) + sound_cues, "speechCues": len(cues), "soundCues": sound_cues,
                 "offset": None, "scale": None, "scaleLabel": None, "z": None, "madMs": None, "windows": 0,
                 "candidateWindows": 0,
                 "inliers": None, "cover": None, "maxErrorS": None, "reliable": False, "confidence": "low",
                 "verdict": "peu-de-répliques", "global": None}
    if len(cues) < MIN_WINDOW_CUES or not speech_regions:
        return out
    end = max(duration or 0.0, max(e for _, e in speech_regions)) if duration else \
        max(max(e for _, e in speech_regions), max(e for _, e in cues))
    n = int((end * 1.1 + MAX_LAG_S) / RES)
    maxlag = int(round(MAX_LAG_S / RES))
    cache = speech_fft_cache if speech_fft_cache is not None else {}
    if cache.get("n") != n:
        nfft = _nfft(2 * n)
        speech = mask(speech_regions, n)
        valid = mask(valid_ranges, n) if valid_ranges is not None else np.ones(n, np.float32)
        cache.clear()
        cache.update(n=n, nfft=nfft, speech=speech, valid=valid, fft=np.fft.rfft(speech, nfft))
    speech, valid, nfft = cache["speech"], cache["valid"], cache["nfft"]
    fits = global_offsets(cache["fft"], nfft, cues, n, maxlag)
    if not fits:
        return out
    best = max(fits, key=lambda f: f.cover)
    out["global"] = {"scaleLabel": best.name, "scale": best.scale, "offset": round(best.offset, 3),
                     "cover": round(best.cover, 4), "z": round(best.z, 2)}
    out["z"] = round(best.z, 2)
    s0, a0 = best.scale, best.offset
    points: list[tuple[float, float]] = []
    candidates = 0
    last = cues[-1][0]
    w0 = 0.0
    i0 = 0
    while w0 < last + 1e-9:
        # Les répliques qui commencent dans [w0, w0 + 5 min) : un balayage, les répliques étant triées.
        while i0 < len(cues) and cues[i0][0] < w0:
            i0 += 1
        j = i0
        while j < len(cues) and cues[j][0] < w0 + WINDOW_S:
            j += 1
        win = cues[i0:j]
        if len(win) >= MIN_WINDOW_CUES:
            candidates += 1
            got = local_offset(speech, valid, win, a0, s0)
            if got is not None and got[1] >= MIN_WINDOW_Z:
                mid = float(np.mean([(x + y) / 2 for x, y in win]))
                points.append((mid, a0 + s0 * mid + got[0]))
        w0 += WINDOW_STEP_S
    out["windows"] = len(points)
    out["candidateWindows"] = candidates
    if len(points) >= 4:
        slope, icpt = theil_sen(points, s0)
        s, label = snap_scale(slope, cues[-1][1])
        if label is None:
            s, label = snap_by_residuals(points, slope, icpt)
        if label is not None:
            icpt = float(np.median([y - s * x for x, y in points]))
        res = np.array([y - (icpt + s * x) for x, y in points])
        out.update(offset=round(icpt, 3), scale=s, scaleLabel=label, madMs=round(float(np.median(np.abs(res))) * 1000, 1),
                   inliers=round(float(np.mean(np.abs(res) < INLIER_S)), 3), cover=round(_cover(speech, cues, icpt, s), 4))
    else:
        # Trop peu de fenêtres pour une droite : la mesure globale, qui ne sera pas dite fiable.
        s, label = snap_scale(s0, cues[-1][1])
        out.update(offset=round(a0, 3), scale=s, scaleLabel=label, cover=round(best.cover, 4))
    t_first, t_last = cues[0][0], max(e for _, e in cues)
    a, s = out["offset"], out["scale"]
    out["maxErrorS"] = round(max(abs(a + (s - 1.0) * t_first), abs(a + (s - 1.0) * t_last)), 3)
    out.update(verdict_of(out))
    return out


def verdict_of(m: dict) -> dict:
    """`reliable`, `confidence` (`high` / `medium` / `low`) et `verdict` d'une mesure (voir l'en-tête)."""
    z = m.get("z") or 0.0
    windows = m.get("windows") or 0
    inliers = m.get("inliers")
    mad = m.get("madMs")
    speech_cues = m.get("speechCues") or 0
    reliable = (z >= RELIABLE_Z and windows >= RELIABLE_WINDOWS and inliers is not None and inliers >= RELIABLE_INLIERS
                and mad is not None and mad <= RELIABLE_MAD_MS and speech_cues >= MIN_SPEECH_CUES)
    if reliable:
        if (m.get("maxErrorS") or 0.0) < OK_MAX_ERROR_S:
            verdict = "ok"
        elif m.get("scale") == 1.0:
            verdict = "décalé"
        else:
            verdict = "dérive"
        confidence = "high"
    else:
        if speech_cues < MIN_SPEECH_CUES:
            verdict = "peu-de-répliques"
        elif (windows >= RELIABLE_WINDOWS and inliers is not None and (inliers < RELIABLE_INLIERS or (mad or 0) > RELIABLE_MAD_MS)
              and z >= MONTAGE_MIN_Z and windows >= MONTAGE_WINDOW_SHARE * (m.get("candidateWindows") or windows)):
            verdict = "montage"
        else:
            verdict = "incertain"
        confidence = "medium" if z >= RELIABLE_Z and windows >= 3 else "low"
    return {"reliable": reliable, "confidence": confidence, "verdict": verdict}


def image_result() -> dict:
    """Une piste en images : rien à lire, donc rien à mesurer."""
    return {"cues": None, "speechCues": None, "soundCues": None, "offset": None, "scale": None, "scaleLabel": None,
            "z": None, "madMs": None, "windows": 0, "candidateWindows": 0, "inliers": None, "cover": None, "maxErrorS": None,
            "reliable": False, "confidence": "low", "verdict": "image", "global": None}
