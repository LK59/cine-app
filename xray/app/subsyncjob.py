"""« Synchro des sous-titres » dans le service : les ordres, la lecture du fichier, les résultats.

**Seulement à la demande.** Rien n'est mesuré de soi-même : un ordre arrive de Laterna (`POST /subsync/jobs`)
quand un administrateur clique « Scanner » dans Configuration → Synchro des sous-titres, jamais du
planificateur de la bibliothèque. Le résultat (décalage, échelle, verdict par piste) part en base et attend que
Laterna le lise (`GET /subsync/results`) ; le service ne corrige rien, et n'écrit jamais dans la médiathèque.

**Une file à elle** (`subsync_jobs`), servie par la voie A (`worker.py`) quand aucun ordre d'analyse `high` ou
`normal` n'attend — comme les voix par le son seul —, avant les ordres `low` du fond (elle est courte : moins de
deux minutes pour un film), et qui rend la main entre deux blocs de son dès qu'un spectateur commande une
analyse. Elle ne touche pas à l'iGPU (son et sous-titres seulement, un fil de ffmpeg) : la garde de Jellyfin n'a
rien à lui retirer. Un ordre interrompu revient en file et repart du début (sa parole déjà écoutée gardée).

**La parole.** Celle de « qui parle » quand l'élément est analysé au même fichier, voix complètes
(`voice_regions` ; la zone écoutée : les tronçons faits, moins les plages sautées). Sinon une passe « parole
seule » : la détection de parole de « qui parle » (Silero, canal central à 16 kHz, seuil 0,5, jointure 0,25 s,
au moins 0,2 s), sur tout le son, **dans la même lecture du fichier que les pistes de sous-titres du conteneur**
(un ffmpeg, une sortie de son, une sortie par piste texte). Gardée en base (`subsync_speech`) : une nouvelle
mesure au même fichier ne réécoute rien.

**Les sous-titres.** Ceux du conteneur, texte seulement (SubRip, ASS/SSA, WebVTT, mov_text — convertis en
SubRip par ffmpeg) ; ceux posés à côté du film, dont Laterna donne les chemins (`.srt`, `.ass`, `.ssa`, `.vtt`,
lus ici). Les pistes en images (PGS, VobSub) sont rendues avec le verdict `image`, sans mesure.
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from . import audio as audiomod
from . import segments
from . import subsync
from .config import settings
from .db import Database
from .jobs import HEX32, PRIORITIES, InvalidJob, check_media_path
from .logs import event

log = logging.getLogger("xray.subsync")

EXTERNAL_EXT = {".srt", ".ass", ".ssa", ".vtt"}
MAX_EXTERNALS = 64
MAX_EXTERNAL_BYTES = 20 * 1024 * 1024
# Un bloc de son lu d'un coup : 256 trames de Silero (8,2 s) — entre deux, l'ordre peut rendre la main.
BLOCK_FRAMES = 256
FRAME = 512


# ---- l'ordre ----------------------------------------------------------------------------------------------

@dataclass
class External:
    path: str            # tel que Laterna l'a donné (clé de la piste)
    real: str            # résolu, vérifié dans la médiathèque
    language: str | None
    title: str | None
    forced: bool
    hi: bool

    def as_dict(self) -> dict:
        return {"path": self.path, "real": self.real, "language": self.language, "title": self.title,
                "forced": self.forced, "hi": self.hi}


@dataclass
class SubsyncSpec:
    item_id: str
    path: str
    etag: str
    priority: int
    externals: list[External] = field(default_factory=list)
    original_language: str | None = None
    force: bool = False


def check_external_path(raw: object, media_root: Path) -> str:
    """Comme un fichier vidéo (`check_media_path`) : dans la médiathèque montée, liens résolus — mais une
    extension de sous-titre texte."""
    if not isinstance(raw, str) or not raw or len(raw) > 4096 or "\x00" in raw or not raw.startswith("/"):
        raise InvalidJob("externals.path : chemin absolu attendu")
    root = os.path.realpath(str(media_root))
    real = os.path.realpath(raw)
    if real != root and not real.startswith(root.rstrip("/") + "/"):
        raise InvalidJob("externals.path : hors de la médiathèque montée")
    if Path(real).suffix.lower() not in EXTERNAL_EXT:
        raise InvalidJob("externals.path : .srt, .ass, .ssa ou .vtt attendu")
    return real


def _opt_str(v: object, name: str, limit: int = 300) -> str | None:
    if v is None:
        return None
    if not isinstance(v, str) or len(v) > limit:
        raise InvalidJob(f"{name} : chaîne attendue")
    return v.strip() or None


def validate(body: object, media_root: Path) -> SubsyncSpec:
    if not isinstance(body, dict):
        raise InvalidJob("corps JSON attendu")
    item_id = body.get("itemId")
    if not isinstance(item_id, str) or not HEX32.match(item_id):
        raise InvalidJob("itemId : 32 caractères hexadécimaux attendus")
    etag = body.get("etag")
    if not isinstance(etag, str) or not etag.strip() or len(etag) > 256:
        raise InvalidJob("etag : chaîne non vide attendue")
    priority = body.get("priority", "low")
    if priority not in PRIORITIES:
        raise InvalidJob("priority : high, normal ou low")
    force = body.get("force", False)
    if not isinstance(force, bool):
        raise InvalidJob("force : booléen attendu")
    lang = body.get("originalLanguage")
    if lang is not None and (not isinstance(lang, str) or not re.fullmatch(r"[A-Za-z]{2,3}(-[A-Za-z]{2})?", lang.strip())):
        raise InvalidJob("originalLanguage : code de langue (ISO 639) ou null")
    raw_ext = body.get("externals", [])
    if not isinstance(raw_ext, list) or len(raw_ext) > MAX_EXTERNALS:
        raise InvalidJob(f"externals : liste de {MAX_EXTERNALS} fichiers au plus")
    externals: list[External] = []
    seen: set[str] = set()
    for e in raw_ext:
        if not isinstance(e, dict):
            raise InvalidJob("externals : objets attendus")
        path = e.get("path")
        real = check_external_path(path, media_root)
        if path in seen:
            continue
        seen.add(path)
        forced, hi = e.get("forced", False), e.get("hi", False)
        if not isinstance(forced, bool) or not isinstance(hi, bool):
            raise InvalidJob("externals.forced / externals.hi : booléens attendus")
        externals.append(External(path, real, _opt_str(e.get("language"), "externals.language", 32),
                                  _opt_str(e.get("title"), "externals.title"), forced, hi))
    path = check_media_path(body.get("path"), media_root)
    return SubsyncSpec(item_id.lower(), path, etag, PRIORITIES[priority], externals,
                       lang.strip().lower() if isinstance(lang, str) else None, force)


def _ext_signature(externals: list[External]) -> str:
    """Ce qui fait la version des fichiers à côté du film : chemin, taille, date — un fichier remplacé (Bazarr
    qui en trouve un meilleur) n'est plus celui qui a été mesuré."""
    out = []
    for e in sorted(externals, key=lambda x: x.path):
        try:
            st = os.stat(e.real)
            out.append([e.path, st.st_size, int(st.st_mtime)])
        except OSError:
            out.append([e.path, None, None])
    return json.dumps(out, ensure_ascii=False)


def submit(db: Database, spec: SubsyncSpec) -> tuple[int, dict]:
    """Dépose l'ordre. Déjà mesuré au même fichier, mêmes fichiers à côté, même algorithme (et sans `force`) :
    200 `done`, rien n'est relancé. En file ou en cours : la priorité peut seulement monter."""
    now = time.time()
    sig = _ext_signature(spec.externals)
    with db.tx() as c:
        row = c.execute("SELECT * FROM subsync_jobs WHERE item_id=?", (spec.item_id,)).fetchone()
        res = c.execute("SELECT etag, version, ext_sig FROM subsync_results WHERE item_id=?", (spec.item_id,)).fetchone()
        if (not spec.force and row is not None and row["status"] == "done" and res is not None and res["etag"] == spec.etag
                and res["version"] == subsync.ALGO_VERSION and res["ext_sig"] == sig):
            return 200, {"itemId": spec.item_id, "status": "done", "position": 0}
        if row is not None and row["status"] in ("queued", "running") and row["etag"] == spec.etag and row["ext_sig"] == sig:
            if spec.priority < row["priority"]:
                c.execute("UPDATE subsync_jobs SET priority=?, updated=? WHERE item_id=?", (spec.priority, now, spec.item_id))
            status = row["status"]
        else:
            seq = c.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM subsync_jobs").fetchone()[0]
            c.execute(
                """INSERT INTO subsync_jobs (item_id, etag, path, externals_json, ext_sig, original_language, priority,
                                             status, error, seq, attempts, created, updated)
                   VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, 0, ?, ?)
                   ON CONFLICT(item_id) DO UPDATE SET etag=excluded.etag, path=excluded.path,
                     externals_json=excluded.externals_json, ext_sig=excluded.ext_sig,
                     original_language=excluded.original_language, priority=excluded.priority, status='queued',
                     error=NULL, seq=excluded.seq, attempts=0, updated=excluded.updated""",
                (spec.item_id, spec.etag, spec.path, json.dumps([e.as_dict() for e in spec.externals], ensure_ascii=False),
                 sig, spec.original_language, spec.priority, seq, now, now))
            status = "queued"
    return 202, {"itemId": spec.item_id, "status": status, "position": position(db, spec.item_id)}


def position(db: Database, item_id: str) -> int:
    row = db.one("SELECT priority, seq, status FROM subsync_jobs WHERE item_id=?", (item_id,))
    if row is None or row["status"] != "queued":
        return 0
    return int(db.one("SELECT COUNT(*) FROM subsync_jobs WHERE status IN ('queued', 'running') AND "
                      "(status='running' OR priority < ? OR (priority = ? AND seq < ?))",
                      (row["priority"], row["priority"], row["seq"]))[0])


def pending_count(db: Database) -> int:
    return int(db.one("SELECT COUNT(*) FROM subsync_jobs WHERE status IN ('queued', 'running')")[0])


def next_job(db: Database):
    return db.one("SELECT * FROM subsync_jobs WHERE status='queued' ORDER BY priority, seq LIMIT 1")


def reset_running(db: Database) -> None:
    """Au démarrage : un ordre resté « running » a été interrompu, il repart en file."""
    db.run("UPDATE subsync_jobs SET status='queued' WHERE status='running'")


# ---- les résultats -----------------------------------------------------------------------------------------

def _payload(db: Database, job, res) -> dict:
    status = job["status"] if job is not None else "done"
    first = job if job is not None else res
    out: dict = {"itemId": first["item_id"], "etag": first["etag"], "status": status,
                 "error": job["error"] if job is not None else None, "position": 0,
                 "version": None, "speechSource": None, "durationS": None, "tracks": []}
    if status == "queued":
        out["position"] = position(db, first["item_id"])
    if res is not None:
        stats = json.loads(res["stats_json"]) if res["stats_json"] else {}
        # `resultEtag` : le fichier que dit la mesure — pendant qu'un nouvel ordre attend, celle d'avant reste lisible.
        out.update(resultEtag=res["etag"], version=int(res["version"]), speechSource=res["speech_source"],
                   durationS=stats.get("durationS"), speechSeconds=stats.get("speechSeconds"),
                   audioTrack=stats.get("audioTrack"), tracks=json.loads(res["tracks_json"]))
    out["updated"] = max(float(job["updated"]) if job is not None else 0.0, float(res["updated"]) if res is not None else 0.0)
    return out


def results(db: Database, item_ids: list[str] | None = None, since: float | None = None, limit: int = 500) -> dict:
    """Les ordres et leurs mesures : ceux des éléments demandés, ou ceux qui ont bougé depuis `since`."""
    if item_ids is not None:
        ids = list(dict.fromkeys(i.lower() for i in item_ids))
    else:
        ts = since or 0.0
        ids = [r["item_id"] for r in db.q(
            """SELECT item_id FROM subsync_jobs WHERE updated > ?
               UNION SELECT item_id FROM subsync_results WHERE updated > ? LIMIT ?""", (ts, ts, limit))]
    items = []
    for iid in ids:
        job = db.one("SELECT * FROM subsync_jobs WHERE item_id=?", (iid,))
        res = db.one("SELECT * FROM subsync_results WHERE item_id=?", (iid,))
        if job is None and res is None:
            items.append({"itemId": iid, "status": "unknown", "tracks": []})
            continue
        items.append(_payload(db, job, res))
    return {"now": time.time(), "version": subsync.ALGO_VERSION, "items": items}


# ---- la lecture du fichier ---------------------------------------------------------------------------------

@dataclass
class SubStream:
    index: int
    codec: str
    language: str | None
    title: str | None
    default: bool
    forced: bool
    hi: bool

    @property
    def image(self) -> bool:
        return self.codec in subsync.IMAGE_CODECS

    @property
    def text(self) -> bool:
        return self.codec in subsync.TEXT_CODECS


def probe_subtitles(path: str) -> tuple[list[SubStream], float]:
    out = subprocess.run(
        [settings.ffprobe, "-v", "error", "-select_streams", "s", "-show_entries",
         "stream=index,codec_name:stream_tags=language,title:stream_disposition=default,forced,hearing_impaired"
         ":format=duration", "-of", "json", path],
        capture_output=True, text=True, timeout=120,
    )
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe (sous-titres) : {out.stderr.strip()[-300:]}")
    data = json.loads(out.stdout or "{}")
    return parse_subtitle_streams(data), float((data.get("format") or {}).get("duration") or 0.0)


def parse_subtitle_streams(data: dict) -> list[SubStream]:
    subs = []
    for s in data.get("streams") or []:
        tags = {k.lower(): v for k, v in (s.get("tags") or {}).items()}
        disp = s.get("disposition") or {}
        title = str(tags.get("title") or "") or None
        subs.append(SubStream(int(s.get("index", 0)), str(s.get("codec_name") or "").lower(),
                              str(tags.get("language") or "").lower() or None, title,
                              bool(disp.get("default")), bool(disp.get("forced")),
                              bool(disp.get("hearing_impaired")) or bool(title and re.search(r"\b(sdh|hi|cc)\b|malentend", title, re.I))))
    return subs


def speech_filter(t: audiomod.AudioTrack) -> list[str]:
    """Le filtre de « qui parle » (`audio_filter` : canal central, 16 kHz), plus `aresample=async=1:first_pts=0` :
    une piste son qui commence après le début du fichier (un retard de quelques dizaines de millisecondes, parfois
    d'une seconde) est complétée de silence, pour que l'échantillon 0 soit l'instant 0 du fichier — sans quoi
    toute la parole serait mesurée en avance d'autant, et le décalage avec."""
    args = list(audiomod.audio_filter(t))
    pad = "aresample=async=1:first_pts=0"
    if "-af" in args:
        i = args.index("-af")
        args[i + 1] = f"{args[i + 1]},{pad}"
    else:
        args = ["-af", pad, *args]
    return args


class Vad:
    """Silero seul (sans l'empreinte de voix), un fil, en flux : un état et un contexte qui suivent le son."""

    def __init__(self, path: Path):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        self.sess = ort.InferenceSession(str(path), sess_options=opts, providers=["CPUExecutionProvider"])

    def stream(self):
        state = np.zeros((2, 1, 128), np.float32)
        ctx = np.zeros(64, np.float32)
        sr = np.array(audiomod.SR, dtype=np.int64)
        probs: list[float] = []

        def feed(x: np.ndarray) -> None:
            nonlocal state, ctx
            for i in range(len(x) // FRAME):
                chunk = x[i * FRAME:(i + 1) * FRAME]
                p, state = self.sess.run(None, {"input": np.concatenate([ctx, chunk])[None, :], "state": state, "sr": sr})
                probs.append(float(p[0, 0]))
                ctx = chunk[-64:]

        return feed, probs


class Yielded(Exception):
    """Un ordre d'analyse plus pressé attend : l'ordre revient en file."""


def read_file(path: str, track: audiomod.AudioTrack | None, subs: list[SubStream], tmpdir: str, vad: Vad | None,
              should_stop) -> tuple[list[tuple[float, float]] | None, float, dict[int, str], float]:
    """Une lecture du fichier : le son (s'il faut écouter la parole) et chaque piste texte du conteneur en SubRip.
    Rend `(zones de parole ou None, secondes de son lues, {index: fichier .srt}, secondes de processeur)`."""
    from .voice import speech_regions

    cmd = [settings.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "1", "-i", path]
    if track is not None:
        cmd += ["-map", f"0:a:{track.rel}", "-vn", "-sn", "-dn", *speech_filter(track), "-f", "s16le", "-acodec",
                "pcm_s16le", "pipe:1"]
    files: dict[int, str] = {}
    for s in subs:
        out = os.path.join(tmpdir, f"s{s.index}.srt")
        files[s.index] = out
        cmd += ["-map", f"0:{s.index}", "-c:s", "srt", "-f", "srt", "-y", out]
    t0 = time.process_time()
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE if track is not None else subprocess.DEVNULL,
                            stderr=subprocess.PIPE)
    err_buf = bytearray()

    def drain() -> None:
        try:
            while True:
                b = proc.stderr.read(4096)  # type: ignore[union-attr]
                if not b:
                    break
                if len(err_buf) < 16384:
                    err_buf.extend(b)
        except (OSError, ValueError):
            pass

    t_err = threading.Thread(target=drain, daemon=True)
    t_err.start()
    regions = None
    samples = 0
    try:
        if track is not None and vad is not None:
            feed, probs = vad.stream()
            block = BLOCK_FRAMES * FRAME * 2
            rest = b""
            while True:
                if should_stop():
                    raise Yielded()
                data = proc.stdout.read(block)  # type: ignore[union-attr]
                if not data:
                    break
                data = rest + data
                usable = len(data) - len(data) % (FRAME * 2)
                rest = data[usable:]
                if usable:
                    x = np.frombuffer(data[:usable], dtype=np.int16).astype(np.float32) / 32768.0
                    samples += len(x)
                    feed(x)
            regions = speech_regions(np.array(probs, np.float32))
        else:
            while proc.poll() is None:
                if should_stop():
                    raise Yielded()
                time.sleep(0.5)
        proc.wait()
    except BaseException:
        proc.kill()
        proc.wait()
        raise
    finally:
        t_err.join(5)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg (sous-titres et son) code {proc.returncode} : "
                           f"{err_buf.decode('utf-8', 'replace').strip()[-300:]}")
    return regions, samples / audiomod.SR, files, time.process_time() - t0


def voice_speech(db: Database, item_id: str, etag: str) -> tuple[list[tuple[float, float]], list[tuple[float, float]]] | None:
    """La parole de « qui parle », si l'élément est analysé au même fichier avec ses voix complètes : les zones,
    et là où le son a été écouté (les tronçons faits, moins les plages sautées)."""
    item = db.one("SELECT etag, skip_json FROM items WHERE item_id=?", (item_id,))
    voice = db.one("SELECT etag, complete FROM voice_results WHERE item_id=?", (item_id,))
    if item is None or voice is None or item["etag"] != etag or voice["etag"] != etag or not voice["complete"]:
        return None
    regions = [(float(r["start"]), float(r["end"])) for r in
               db.q("SELECT start, end FROM voice_regions WHERE item_id=? ORDER BY start", (item_id,))]
    skips = segments.merge([(float(a), float(b)) for a, b in json.loads(item["skip_json"])]) if item["skip_json"] else []
    valid: list[tuple[float, float]] = []
    for c in db.q("SELECT start, end FROM chunks WHERE item_id=? AND voice=1 ORDER BY idx", (item_id,)):
        valid += segments.pieces(float(c["start"]), float(c["end"]), skips)
    if not regions or not valid:
        return None
    return regions, valid


def _read_text(path: str) -> str:
    size = os.path.getsize(path)
    if size > MAX_EXTERNAL_BYTES:
        raise RuntimeError(f"fichier trop gros ({size} octets)")
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "utf-16"):
        try:
            text = raw.decode(enc)
            if enc == "utf-16" and not raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
                continue
            return text
        except UnicodeDecodeError:
            continue
    # Les vieux SubRip en Windows-1252 / Latin-1 : les temps sont en ASCII, le texte ne sert qu'à trier les bruits.
    return raw.decode("latin-1")


# ---- l'exécution d'un ordre --------------------------------------------------------------------------------

def run_job(db: Database, row, vad_factory, should_stop) -> str:
    """Mesure toutes les pistes de sous-titres d'un élément. Rend `done`, `yield` ou `failed`. `vad_factory()` :
    le Silero de la passe « parole seule », ou None s'il n'est pas prêt."""
    item_id, etag, path = row["item_id"], row["etag"], row["path"]
    externals = [External(**e) for e in json.loads(row["externals_json"] or "[]")]
    db.run("UPDATE subsync_jobs SET status='running', attempts=attempts+1, updated=? WHERE item_id=?", (time.time(), item_id))
    t0 = time.monotonic()
    event(log, "[xray] %s : synchro des sous-titres commencée (%d fichiers à côté)", item_id, len(externals),
          item=item_id, action="subsync_start", path=path, etag=etag, externals=len(externals),
          attempt=row["attempts"] + 1)
    tmpdir = tempfile.mkdtemp(prefix="subsync-")
    try:
        subs, duration = probe_subtitles(path)
        text_subs = [s for s in subs if s.text]
        # La parole : gardée d'une mesure précédente au même fichier, celle de « qui parle », ou à écouter.
        speech_row = db.one("SELECT * FROM subsync_speech WHERE item_id=? AND etag=?", (item_id, etag))
        valid: list[tuple[float, float]] | None
        audio_info = None
        if speech_row is not None:
            regions = [tuple(r) for r in json.loads(speech_row["regions_json"])]
            valid = [tuple(r) for r in json.loads(speech_row["valid_json"])]
            source = speech_row["source"]
            audio_info = json.loads(speech_row["track_json"]) if speech_row["track_json"] else None
        else:
            got = voice_speech(db, item_id, etag)
            if got is not None:
                regions, valid = got
                source = "voix"
            else:
                regions, valid, source = None, None, "parole-seule"
        track = None
        vad = None
        if regions is None:
            tracks = audiomod.probe_tracks(path)
            track, why = audiomod.choose_track(tracks, row["original_language"], settings.voice_track)
            if track is None:
                raise RuntimeError("aucune piste son utilisable")
            vad = vad_factory()
            if vad is None:
                raise RuntimeError("détection de parole indisponible (modèles de la voix pas encore prêts, ou XRAY_VOICE=0)")
            audio_info = dict(audiomod.describe(track), reason=why)
        cpu = 0.0
        files: dict[int, str] = {}
        if track is not None or text_subs:
            got_regions, seconds, files, cpu = read_file(path, track, text_subs, tmpdir, vad, should_stop)
            if track is not None:
                regions = got_regions or []
                valid = [(0.0, seconds)] if seconds > 0 else []
                duration = duration or seconds
                with db.tx() as c:
                    c.execute("INSERT OR REPLACE INTO subsync_speech (item_id, etag, source, regions_json, valid_json, "
                              "track_json, updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
                              (item_id, etag, source, json.dumps([[round(a, 3), round(b, 3)] for a, b in regions]),
                               json.dumps(valid), json.dumps(audio_info, ensure_ascii=False) if audio_info else None,
                               time.time()))
        regions = regions or []
        cache: dict = {}
        out_tracks: list[dict] = []
        t_measure = time.process_time()
        for s in subs:
            base = {"trackKey": f"emb:{s.index}", "kind": "embedded", "streamIndex": s.index, "path": None,
                    "codec": s.codec, "language": s.language, "title": s.title, "default": s.default,
                    "forced": s.forced, "hi": s.hi}
            if s.image:
                out_tracks.append({**base, **subsync.image_result()})
                continue
            if not s.text:
                continue
            try:
                parsed = subsync.parse_srt(_read_text(files[s.index])) if s.index in files and os.path.exists(files[s.index]) \
                    else subsync.ParsedCues([], 0, 0)
                out_tracks.append({**base, **subsync.measure(regions, parsed.speech, valid, parsed.sound, cache, duration)})
            except Exception as e:  # une piste illisible ne fait pas échouer les autres
                out_tracks.append({**base, **subsync.image_result(), "verdict": "erreur", "error": f"{type(e).__name__}: {e}"[:300]})
        for e in externals:
            base = {"trackKey": f"ext:{e.path}", "kind": "external", "streamIndex": None, "path": e.path,
                    "codec": Path(e.real).suffix.lower().lstrip("."), "language": e.language, "title": e.title,
                    "default": False, "forced": e.forced, "hi": e.hi}
            try:
                st = os.stat(e.real)
                base.update(size=st.st_size, mtime=int(st.st_mtime))
                parsed = subsync.parse_subtitle(_read_text(e.real), Path(e.real).suffix)
                out_tracks.append({**base, **subsync.measure(regions, parsed.speech, valid, parsed.sound, cache, duration)})
            except Exception as ex:
                out_tracks.append({**base, **subsync.image_result(), "verdict": "erreur", "error": f"{type(ex).__name__}: {ex}"[:300]})
        cpu += time.process_time() - t_measure
        stats = {"durationS": round(duration, 3) if duration else None,
                 "speechSeconds": round(sum(b - a for a, b in regions), 1), "audioTrack": audio_info,
                 "cpuSeconds": round(cpu, 2), "seconds": round(time.monotonic() - t0, 1)}
        with db.tx() as c:
            cur = c.execute("SELECT etag FROM subsync_jobs WHERE item_id=?", (item_id,)).fetchone()
            if cur is None or cur["etag"] != etag:
                return "yield"
            c.execute("INSERT OR REPLACE INTO subsync_results (item_id, etag, version, speech_source, tracks_json, "
                      "stats_json, ext_sig, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                      (item_id, etag, subsync.ALGO_VERSION, source, json.dumps(out_tracks, ensure_ascii=False),
                       json.dumps(stats, ensure_ascii=False), row["ext_sig"], time.time()))
            c.execute("UPDATE subsync_jobs SET status='done', error=NULL, updated=? WHERE item_id=?", (time.time(), item_id))
        verdicts: dict[str, int] = {}
        for t in out_tracks:
            verdicts[t["verdict"]] = verdicts.get(t["verdict"], 0) + 1
        event(log, "[xray] %s : synchro des sous-titres faite — %d pistes (%s), parole : %s, %.0f s", item_id,
              len(out_tracks), ", ".join(f"{k} {v}" for k, v in sorted(verdicts.items())) or "aucune", source,
              time.monotonic() - t0, item=item_id, action="subsync_done", tracks=len(out_tracks), verdicts=verdicts,
              speechSource=source, **stats)
        return "done"
    except Yielded:
        db.run("UPDATE subsync_jobs SET status='queued', updated=? WHERE item_id=?", (time.time(), item_id))
        event(log, "[xray] %s : synchro des sous-titres — cède la place à un ordre plus pressé", item_id, item=item_id,
              action="subsync_yield", seconds=round(time.monotonic() - t0, 1))
        return "yield"
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"[:500]
        db.run("UPDATE subsync_jobs SET status='failed', error=?, updated=? WHERE item_id=?", (msg, time.time(), item_id))
        event(log, "[xray] %s : synchro des sous-titres en échec", item_id, level=logging.ERROR, item=item_id,
              action="subsync_failed", exc_info=True, error=msg, path=path, seconds=round(time.monotonic() - t0, 1))
        return "failed"
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
