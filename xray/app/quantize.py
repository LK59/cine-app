"""Détecteur SCRFD quantifié en INT8, produit sur place, au premier démarrage.

Pourquoi sur place : l'IR quantifié dérive des poids de `buffalo_l`, publiés pour un usage non
commercial. Comme les poids eux-mêmes, il n'est ni dans le dépôt ni dans l'image : le conteneur
le fabrique chez l'installateur, à partir des poids qu'il a téléchargés (vérifiés par leur
SHA-256, `models.py`) et d'images de *sa* médiathèque, et le garde dans le volume de données.

Comment (NNCF, quantification post-entraînement d'OpenVINO, préréglage « mixed ») :

1. **Calibrage** — `CALIB_TITLES` titres pris dans la médiathèque (un par dossier de film ou de
   série, tirés au sort avec une graine fixe), `FRAMES_PER_TITLE` images chacun, réparties de 12 à
   88 % de la durée et décodées comme en production (640 px de large, HDR adapté), posées sur le
   canevas de 640×384 du détecteur. C'est la recette du banc du 09/11/2026 (224 images de 16
   titres, films et séries, SDR et HDR).
2. **Quantification** — `nncf.quantize` sur `det_10g.onnx`, lot 1, taille d'image libre.
3. **Vérification** — l'IR INT8 et le réseau d'origine détectent les mêmes images : parmi les
   visages identifiables du second (36 px et plus, score ≥ 0,6), l'INT8 doit en retrouver au
   moins `MIN_RECALL` (recouvrement ≥ 0,5). Mesuré au banc : 72/72, 136/137, 73/74 (les deux
   perdus sous 36 px), pour 40 % de temps de détection en moins.
4. **Inventaire** — `manifest.json` : recette, SHA-256 du réseau d'origine, versions d'OpenVINO et
   de NNCF, titres et images de calibrage, vérification, SHA-256 des fichiers produits. Au
   démarrage suivant, l'IR n'est repris que si tout concorde (sinon il est refait).

Le travail tourne dans un processus à part (`python -m app.quantize`) : NNCF n'est importé que
là, et sa mémoire (les images, les statistiques) est rendue au système à la fin. En cas d'échec
le service reste en float32 et le dit dans `/health`. Un échec de la quantification ou de la
vérification est noté (`int8.failed.json`) et n'est pas retenté tant que la recette et le réseau
d'origine sont les mêmes (supprimer ce fichier pour réessayer) ; une médiathèque vide ou illisible
(trop peu d'images) n'est pas notée : l'essai est refait au démarrage suivant.

Seul le détecteur est quantifié : l'empreinte en INT8 a été mesurée inutilisable (banc du
09/11/2026) et reste en float32.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

log = logging.getLogger("xray.quantize")

# Version de la recette : la monter refait l'IR chez tout le monde au démarrage suivant.
RECIPE = 1
CALIB_TITLES = 16
FRAMES_PER_TITLE = 14
CANVAS = (640, 384)  # largeur, hauteur : le canevas du détecteur pour une image 16/9 de 640 px
MIN_RECALL = 0.95
MIN_REF_FACES = 20
MAX_EXTRA = 0.05
IR_NAME = "det_10g_int8.xml"
VIDEO_EXT = {".mkv", ".mp4", ".m4v", ".avi", ".mov", ".ts", ".m2ts", ".webm", ".wmv", ".mpg", ".mpeg"}
TIMEOUT = 3600.0


class CalibrationShort(RuntimeError):
    """Trop peu d'images : médiathèque vide, illisible, ou pas encore montée. Retenté plus tard."""


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


# --- 1. calibrage -------------------------------------------------------------------------------


def _first_video(folder: Path, depth: int = 3) -> Path | None:
    """Le premier fichier vidéo (ordre alphabétique) d'un dossier de titre, sous-dossiers compris."""
    try:
        entries = sorted(os.scandir(folder), key=lambda e: e.name)
    except OSError:
        return None
    for e in entries:
        try:
            if e.is_file() and Path(e.name).suffix.lower() in VIDEO_EXT and not e.name.startswith("."):
                return Path(e.path)
        except OSError:
            continue
    if depth <= 0:
        return None
    for e in entries:
        try:
            if e.is_dir() and not e.name.startswith("."):
                got = _first_video(Path(e.path), depth - 1)
                if got is not None:
                    return got
        except OSError:
            continue
    return None


def pick_titles(root: Path, n: int = CALIB_TITLES, seed: int = 7) -> list[Path]:
    """`n` fichiers vidéo, un par dossier de titre : les dossiers de deuxième niveau
    (`/media/movies/<film>`, `/media/tv/<série>`), tirés au sort avec une graine fixe. Les
    vidéos posées directement au premier niveau comptent chacune pour un titre."""
    titles: list[Path] = []
    try:
        top = sorted(os.scandir(root), key=lambda e: e.name)
    except OSError:
        return []
    for e in top:
        if e.name.startswith("."):
            continue
        try:
            if e.is_dir():
                for sub in sorted(os.scandir(e.path), key=lambda x: x.name):
                    if not sub.name.startswith("."):
                        titles.append(Path(sub.path))
            elif Path(e.name).suffix.lower() in VIDEO_EXT:
                titles.append(Path(e.path))
        except OSError:
            continue
    random.Random(seed).shuffle(titles)
    out: list[Path] = []
    for t in titles:
        f = t if t.is_file() else _first_video(t)
        if f is not None:
            out.append(f)
            if len(out) >= n:
                break
    return out


def canvas(img: np.ndarray) -> np.ndarray:
    """L'image (640 px de large) en haut à gauche d'un canevas noir de 640×384, comme `Scrfd`."""
    w, h = CANVAS
    out = np.zeros((h, w, 3), dtype=np.uint8)
    ih, iw = min(img.shape[0], h), min(img.shape[1], w)
    out[:ih, :iw] = img[:ih, :iw]
    return out


def collect_frames(files: list[Path], per_title: int = FRAMES_PER_TITLE) -> tuple[list[np.ndarray], list[dict]]:
    import cv2

    from . import decode

    frames: list[np.ndarray] = []
    used: list[dict] = []
    for f in files:
        try:
            info = decode.probe(str(f))
        except Exception as e:
            log.info("calibrage : %s écarté (%s)", f.name, e)
            continue
        n = 0
        for t in np.linspace(0.12, 0.88, per_title) * info.duration:
            stats = decode.DecodeStats("cpu")
            try:
                fr = next(iter(decode.read_frames(str(f), float(t), 1.0, info, False, stats)), None)
            except Exception:
                fr = None
            if fr is None:
                continue
            frames.append(canvas(cv2.cvtColor(fr[1], cv2.COLOR_YUV2BGR_NV12)))
            n += 1
        if n:
            used.append({"file": str(f), "frames": n, "codec": info.codec, "hdr": info.hdr})
            log.info("calibrage : %s — %d images (%s%s)", f.name, n, info.codec, ", HDR" if info.hdr else "")
    return frames, used


def blob(img: np.ndarray) -> np.ndarray:
    """Le prétraitement de `Scrfd.detect` : (x − 127,5) / 128, RVB, NCHW."""
    import cv2

    return cv2.dnn.blobFromImage(img, 1.0 / 128.0, (img.shape[1], img.shape[0]), (127.5, 127.5, 127.5), swapRB=True)


# --- 2. quantification --------------------------------------------------------------------------


def quantize(source: Path, frames: list[np.ndarray], dest: Path) -> None:
    import nncf
    import openvino as ov

    core = ov.Core()
    model = core.read_model(str(source))
    model.reshape({model.inputs[0]: [1, 3, -1, -1]})
    q = nncf.quantize(model, nncf.Dataset(frames, blob), preset=nncf.QuantizationPreset.MIXED,
                      subset_size=len(frames))
    ov.save_model(q, str(dest), compress_to_fp16=False)


# --- 3. vérification ----------------------------------------------------------------------------


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return float(inter / ua) if ua > 0 else 0.0


def compare(ref: list[list], cand: list[list], min_face: float = 36.0, min_score: float = 0.6) -> dict:
    """Visages identifiables de la référence retrouvés par le candidat (recouvrement ≥ 0,5), et
    visages identifiables du candidat absents de la référence."""
    def keep(faces):
        return [f for f in faces if f.score >= min_score and f.min_side >= min_face]

    total = found = extra = cand_total = 0
    for r, c in zip(ref, cand):
        r, c = keep(r), keep(c)
        total += len(r)
        cand_total += len(c)
        found += sum(1 for f in r if any(_iou(f.box, g.box) >= 0.5 for g in c))
        extra += sum(1 for g in c if not any(_iou(f.box, g.box) >= 0.5 for f in r))
    return {"faces": total, "found": found, "extra": extra, "candFaces": cand_total,
            "recall": round(found / total, 4) if total else None}


def verify(source: Path, ir: Path, frames: list[np.ndarray], threads: int) -> dict:
    from .faces import Scrfd
    from .inference import OvSession

    ref = Scrfd(source, threads, session=OvSession(source, threads))
    cand = Scrfd(ir, threads, session=OvSession(ir, threads))
    t0 = time.perf_counter()
    a = [ref.detect(f) for f in frames]
    t1 = time.perf_counter()
    b = [cand.detect(f) for f in frames]
    t2 = time.perf_counter()
    out = compare(a, b)
    out["fp32MsPerImage"] = round(1000 * (t1 - t0) / max(len(frames), 1), 1)
    out["int8MsPerImage"] = round(1000 * (t2 - t1) / max(len(frames), 1), 1)
    return out


def accept(check: dict) -> str | None:
    """Rend la raison d'un refus, ou None."""
    if check["faces"] < MIN_REF_FACES:
        return f"vérification impossible : {check['faces']} visages identifiables (il en faut {MIN_REF_FACES})"
    if check["recall"] < MIN_RECALL:
        return f"INT8 ne retrouve que {check['found']} visages sur {check['faces']} (minimum {MIN_RECALL:.0%})"
    if check["extra"] > MAX_EXTRA * check["faces"]:
        return f"INT8 trouve {check['extra']} visages de trop sur {check['faces']}"
    return None


# --- 4. inventaire, et le travail complet -------------------------------------------------------


def _versions() -> dict:
    out = {}
    for mod in ("openvino", "nncf"):
        try:
            out[mod] = __import__(mod).__version__
        except Exception:
            out[mod] = None
    return out


def build(source: Path, source_sha: str, out_dir: Path, media_root: Path, threads: int) -> dict:
    """Produit `out_dir` (IR + manifest) d'un bloc : écrit à côté, renommé une fois vérifié."""
    files = pick_titles(media_root)
    frames, used = collect_frames(files)
    if len(frames) < CALIB_TITLES * FRAMES_PER_TITLE // 4:
        raise CalibrationShort(f"{len(frames)} images de calibrage seulement ({len(files)} titres lisibles sous {media_root})")
    tmp = out_dir.with_name(out_dir.name + ".tmp")
    shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True)
    try:
        t0 = time.monotonic()
        quantize(source, frames, tmp / IR_NAME)
        took = time.monotonic() - t0
        check = verify(source, tmp / IR_NAME, frames, threads)
        reason = accept(check)
        if reason is not None:
            raise RuntimeError(reason)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    manifest = {
        "recipe": RECIPE,
        "source": source.name,
        "sourceSha256": source_sha,
        **_versions(),
        "titles": [dict(u, file=os.path.relpath(u["file"], media_root)) for u in used],
        "frames": len(frames),
        "quantizeSeconds": round(took, 1),
        "check": check,
        "files": {p.name: sha256_of(p) for p in sorted(tmp.iterdir())},
        "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    (tmp / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    for p in tmp.iterdir():
        os.chmod(p, 0o644)
    shutil.rmtree(out_dir, ignore_errors=True)
    tmp.replace(out_dir)
    return manifest


def load_manifest(out_dir: Path, source_sha: str) -> dict | None:
    """Le manifest d'un IR qui concorde (recette, réseau d'origine, fichiers intacts), ou None."""
    try:
        m = json.loads((out_dir / "manifest.json").read_text())
    except (OSError, ValueError):
        return None
    if m.get("recipe") != RECIPE or m.get("sourceSha256") != source_sha:
        return None
    files = m.get("files") or {}
    if IR_NAME not in files:
        return None
    for name, sha in files.items():
        p = out_dir / name
        if not p.is_file() or sha256_of(p) != sha:
            return None
    return m


def failed_marker(out_dir: Path) -> Path:
    return out_dir.with_name(out_dir.name + ".failed.json")


def read_failure(out_dir: Path, source_sha: str) -> str | None:
    """La raison d'un échec déjà noté pour cette recette et ce réseau, ou None."""
    try:
        f = json.loads(failed_marker(out_dir).read_text())
    except (OSError, ValueError):
        return None
    if f.get("recipe") == RECIPE and f.get("sourceSha256") == source_sha:
        return str(f.get("error") or "échec")
    return None


def ensure(source: Path, source_sha: str, out_dir: Path, media_root: Path, threads: int,
           timeout: float = TIMEOUT) -> tuple[Path | None, str | None]:
    """(chemin de l'IR INT8, None) s'il est prêt — repris ou produit dans un processus à part —,
    (None, raison) sinon. Ne lève pas : le service continue en float32."""
    if load_manifest(out_dir, source_sha) is not None:
        return out_dir / IR_NAME, None
    known = read_failure(out_dir, source_sha)
    if known is not None:
        return None, f"{known} (noté dans {failed_marker(out_dir).name} ; le supprimer pour réessayer)"
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-m", "app.quantize", "--source", str(source), "--sha256", source_sha,
           "--out", str(out_dir), "--media", str(media_root), "--threads", str(threads)]
    log.info("détecteur INT8 : calibrage sur la médiathèque et quantification (quelques minutes, une fois)")
    t0 = time.monotonic()
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                           cwd=str(Path(__file__).resolve().parent.parent))
    except subprocess.TimeoutExpired:
        return None, f"quantification interrompue après {int(timeout)} s"
    except Exception as e:
        return None, f"quantification impossible : {type(e).__name__}: {e}"
    for line in (r.stderr or "").splitlines()[-40:]:
        if line.strip() and "━" not in line:
            log.info("quantification | %s", line[:300])
    m = load_manifest(out_dir, source_sha)
    if r.returncode == 0 and m is not None:
        c = m["check"]
        log.info("détecteur INT8 prêt en %.0f s : %d images de %d titres, %d/%d visages retrouvés, "
                 "%.0f → %.0f ms par image", time.monotonic() - t0, m["frames"], len(m["titles"]),
                 c["found"], c["faces"], c["fp32MsPerImage"], c["int8MsPerImage"])
        return out_dir / IR_NAME, None
    known = read_failure(out_dir, source_sha)
    if known is not None:
        return None, known
    tail = (r.stdout or "").strip().splitlines()[-1:] or (r.stderr or "").strip().splitlines()[-1:] or ["?"]
    return None, f"quantification en échec (code {r.returncode}) : {tail[0][:300]}"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--source", required=True)
    ap.add_argument("--sha256", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--media", required=True)
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
    source, out = Path(a.source), Path(a.out)
    # Le réseau d'origine est relu et vérifié ici aussi : c'est lui qu'on quantifie.
    if sha256_of(source) != a.sha256:
        print(f"{source.name} ne correspond pas à l'empreinte attendue", flush=True)
        return 2
    try:
        import cv2

        cv2.setNumThreads(a.threads)
        build(source, a.sha256, out, Path(a.media), a.threads)
    except CalibrationShort as e:
        print(str(e), flush=True)
        return 3
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"[:500]
        failed_marker(out).write_text(json.dumps({"recipe": RECIPE, "sourceSha256": a.sha256, "error": msg,
                                                  "when": time.strftime("%Y-%m-%dT%H:%M:%S%z")}))
        print(msg, flush=True)
        return 1
    failed_marker(out).unlink(missing_ok=True)
    print("ok", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
