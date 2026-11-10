"""« Qui parle », lecture des lèvres : nommer les voix que les visages laissent indécises.

Le contraste local (`voices.py`) nomme une voix quand une personne est plus souvent à l'image pendant
cette voix que pendant les autres. Deux personnes toujours filmées ensemble (un couple, deux collègues
dans le même plan) restent indécises : leur présence est la même. Regarder **qui bouge les lèvres**
départage — mais c'est cher (25 images par seconde, un visage suivi image par image : 2,3 à 3,7 s de
calcul par seconde de vidéo au banc), donc **ciblé** :

1. **Quelles voix** (`plan`) : seulement les voix indécises (au seuil du milieu) d'au moins `min_pieces`
   morceaux, ni nommées, ni en désaccord ; leurs **candidats** sont les deux ou trois personnes les plus
   présentes pendant elles. Une voix sans candidat à l'image (hors champ : téléphone, narration) n'est pas
   lue ; un morceau où plus de `max_people` personnes sont à l'image (une foule) non plus.
2. **Quels instants** : une dizaine de ses morceaux où un candidat au moins est bien visible, étalés dans
   l'épisode, élargis de 0,4 s, voisins joints en fenêtres (`windows`).
3. **Chaque fenêtre** est décodée à 25 i/s avec son son, dans le même ffmpeg (sans sauter d'image ; sur
   l'iGPU quand le codec s'y prête et que Jellyfin ne s'en sert pas — `gpu_guard`). Visages détectés une
   image sur cinq par le détecteur de l'analyse, suivis par recouvrement, boîtes interpolées entre deux ;
   chaque piste reçoit le nom du groupe de visages nommé le plus proche (`id_sim`). Light-ASD
   (`asd.py`) note chaque image de chaque piste.
4. **Un vote par morceau** (`piece_votes`) : la piste la plus « parlante » pendant le morceau, sa note et
   celle de la suivante — gardé en base par instants (`asd_votes`), pas par voix.
5. **Les voix sont refaites** (`voicejob.assemble`) : `voices.build` donne à une voix indécise le nom que
   ses votes désignent nettement (`VoiceParams.asd_*`), sauf si la mémoire de la série préfère quelqu'un
   d'autre — alors la voix reste sans nom. Les segments ainsi nommés portent `via: "asd"`. Un renommage
   (`relabel.py`) relit les votes : rien n'est perdu.

**Plafond** : `XRAY_ASD_BUDGET_S` secondes de processeur par élément (ffmpeg compris, 600 par défaut) ;
au-delà, les voix lues jusque-là comptent, les autres restent indécises. Jamais devant un ordre `normal`
ou `high` : entre deux fenêtres, l'ouvrier rend la main et reprend plus tard où il en était.
"""

from __future__ import annotations

import json
import logging
import resource
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

from . import asd as asdmod
from . import audio as audiomod
from . import decode, voicejob
from .config import ASD_VERSION, settings
from .db import Database
from .faces import align
from .inference import device_calls
from .logs import event
from .voices import VoiceResult, build

log = logging.getLogger("xray.asdjob")

FPS = asdmod.FPS


@dataclass(frozen=True)
class AsdParams:
    # Voix lues
    min_pieces: int = 4
    candidates: int = 3
    cand_presence: float = 0.15   # présence moyenne d'un candidat pendant la voix
    piece_presence: float = 0.5   # un candidat bien visible pendant le morceau choisi
    max_people: int = 4           # au-delà, une foule : pas de vote
    lines: int = 10               # morceaux lus par voix, au plus
    min_lines: int = 3            # en dessous, la voix ne peut pas réunir assez de votes
    spread_s: float = 3.0         # écart entre deux morceaux choisis d'une même voix
    pad: float = 0.4
    merge_gap: float = 1.0
    max_window: float = 12.0      # 300 images de 640 px en niveaux de gris : ~70 Mo
    # Visages
    det_every: int = 5
    det_score: float = 0.6
    min_box: float = 32.0         # plus petit côté d'un visage lu (image de 640 px)
    link_iou: float = 0.3
    min_dets: int = 3             # 0,6 s de piste au moins
    id_sim: float = 0.30          # ressemblance au groupe de visages nommé
    min_frames: int = 5           # images d'une piste pendant le morceau pour qu'elle compte


DEFAULT = AsdParams()


@dataclass
class VoicePlan:
    voice: int
    size: int
    candidates: list[int]
    pieces: list[tuple[float, float]] = field(default_factory=list)


# ---- quelles voix, quels instants (pur) --------------------------------------------------------------

def plan(res: VoiceResult, p: AsdParams = DEFAULT) -> list[VoicePlan]:
    """Les voix indécises à lire et, pour chacune, ses candidats et les morceaux à lire ; les plus grosses
    voix d'abord (le plafond de calcul sert d'abord là où il nomme le plus de répliques)."""
    rows = res.pieces
    pres = res.presence
    pids = res.presence_ids
    if not rows or pres is None or not pids:
        return []
    by_voice: dict[int, list[int]] = {}
    for i, r in enumerate(rows):
        if r[2] > 0:
            by_voice.setdefault(int(r[2]), []).append(i)
    out = []
    conflict = res.piece_conflict or [False] * len(rows)
    for v, idx in by_voice.items():
        if len(idx) < p.min_pieces:
            continue
        if sum(1 for i in idx if rows[i][3] is not None) >= 0.5 * len(idx):
            continue  # déjà nommée
        if sum(1 for i in idx if conflict[i]) >= 0.5 * len(idx):
            continue  # visages et mémoire en désaccord : on n'y touche pas
        a = pres[idx].mean(0)
        order = [int(k) for k in np.argsort(-a) if a[k] >= p.cand_presence][: p.candidates]
        if not order:
            continue  # hors champ
        cands = [pids[k] for k in order]
        scored = []
        for i in idx:
            if rows[i][3] is not None:
                continue
            visible = sum(1 for k in order if pres[i, k] >= p.piece_presence)
            crowd = int((pres[i] >= 0.3).sum())
            if visible == 0 or crowd > p.max_people:
                continue
            s, e = rows[i][0], rows[i][1]
            scored.append((-visible, -(e - s), s, e))
        scored.sort()
        chosen: list[tuple[float, float]] = []
        for _, _, s, e in scored:
            c = (s + e) / 2
            if all(abs(c - (a0 + b0) / 2) >= p.spread_s for a0, b0 in chosen):
                chosen.append((s, e))
            if len(chosen) >= p.lines:
                break
        if len(chosen) < p.min_lines:
            continue
        out.append(VoicePlan(v, len(idx), cands, sorted(chosen)))
    out.sort(key=lambda vp: -vp.size)
    return out


def windows(plans: list[VoicePlan], p: AsdParams = DEFAULT) -> list[tuple[float, float, list[tuple[float, float]]]]:
    """Les morceaux élargis de `pad`, voisins (moins de `merge_gap`) joints, `max_window` au plus."""
    pieces = sorted({pc for vp in plans for pc in vp.pieces})
    out: list[list] = []
    for s, e in pieces:
        a, b = max(0.0, s - p.pad), e + p.pad
        if out and a - out[-1][1] < p.merge_gap and b - out[-1][0] <= p.max_window:
            out[-1][1] = max(out[-1][1], b)
            out[-1][2].append((s, e))
        else:
            out.append([a, b, [(s, e)]])
    return [(round(a, 3), round(b, 3), ps) for a, b, ps in out]


# ---- pistes, notes, votes ----------------------------------------------------------------------------------

def _iou(a, b) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-6)


def link_tracks(dets: dict[int, list], n: int, p: AsdParams = DEFAULT) -> list[dict]:
    """Pistes par recouvrement d'une détection à la suivante (`det_every` images plus loin) ; boîtes
    interpolées image par image entre deux détections. Rend [{frames, box (n×4), faces [(k, Face)]}]."""
    tracks: list[dict] = []
    for k in sorted(dets):
        for f in dets[k]:
            best, bi = None, p.link_iou
            for tr in tracks:
                if tr["last"] == k - p.det_every:
                    o = _iou(tr["faces"][-1][1].box, f.box)
                    if o > bi:
                        best, bi = tr, o
            if best is None:
                best = {"faces": [], "last": None}
                tracks.append(best)
            best["faces"].append((k, f))
            best["last"] = k
    out = []
    for tr in tracks:
        if len(tr["faces"]) < p.min_dets:
            continue
        ks = np.array([k for k, _ in tr["faces"]], dtype=np.float64)
        bx = np.array([f.box for _, f in tr["faces"]], dtype=np.float64)
        fr = np.arange(int(ks[0]), min(n, int(ks[-1]) + p.det_every))
        box = np.stack([np.interp(fr, ks, bx[:, j]) for j in range(4)], 1)
        out.append({"frames": fr, "box": box, "faces": tr["faces"]})
    return out


def piece_votes(tracks: list[dict], w0: float, pieces: list[tuple[float, float]], p: AsdParams = DEFAULT):
    """Un vote par morceau : (début, fin, personne ou None, note, note de la suivante, visages). Une piste
    compte si elle a `min_frames` images notées pendant le morceau ; plus de `max_people` pistes (une
    foule) ou aucune : un vote sans note, gardé pour dire que le morceau a été lu."""
    out = []
    for s, e in pieces:
        a, b = int(round((s - w0) * FPS)), int(round((e - w0) * FPS))
        cands = []
        for tr in tracks:
            sc = tr.get("scores")
            if sc is None:
                continue
            m = (tr["frames"] >= a) & (tr["frames"] < b)
            vals = sc[m]
            vals = vals[np.isfinite(vals)]
            if len(vals) < p.min_frames:
                continue
            cands.append((float(vals.mean()), tr.get("pid")))
        if not cands or len(cands) > p.max_people:
            out.append((s, e, None, None, None, len(cands)))
            continue
        cands.sort(key=lambda c: -c[0])
        second = cands[1][0] if len(cands) > 1 else None
        out.append((s, e, cands[0][1], round(cands[0][0], 4), None if second is None else round(second, 4), len(cands)))
    return out


def score_tracks(net, tracks: list[dict], grays: list[np.ndarray], pcm: np.ndarray) -> None:
    """Note Light-ASD de chaque image de chaque piste (`scores`, NaN au-delà du son)."""
    for tr in tracks:
        crops = np.stack([asdmod.face_crop(grays[fi], b) for fi, b in zip(tr["frames"], tr["box"])])
        t0 = tr["frames"][0] / FPS
        a0 = int(round(t0 * asdmod.SR))
        a1 = a0 + int(round(len(crops) / FPS * asdmod.SR))
        feats = asdmod.mfcc(pcm[a0:a1]) if a1 <= len(pcm) + asdmod.SR else asdmod.mfcc(pcm[a0:])
        sc = net.score(feats, crops) if len(feats) >= 4 else np.zeros(0, np.float32)
        full = np.full(len(crops), np.nan, dtype=np.float32)
        full[: len(sc)] = sc
        tr["scores"] = full


def identify(engine, bgrs: dict[int, np.ndarray], tracks: list[dict], cents: np.ndarray, ids: list[int], p: AsdParams) -> None:
    """Le nom de chaque piste : l'empreinte de son plus grand visage, contre les groupes de visages nommés
    de l'élément (ceux qui nomment « À l'écran »)."""
    if not tracks:
        return
    crops = []
    for tr in tracks:
        k, f = max(tr["faces"], key=lambda kf: kf[1].min_side)
        crops.append(align(bgrs[k], f.kps))
    embs = engine.embedder.embed(crops)
    for tr, v in zip(tracks, embs):
        tr["pid"] = None
        if len(cents):
            sims = cents @ (v / max(float(np.linalg.norm(v)), 1e-9))
            j = int(np.argmax(sims))
            if sims[j] >= p.id_sim:
                tr["pid"] = int(ids[j])


# ---- un élément ----------------------------------------------------------------------------------------

def cpu_now() -> float:
    """Processeur de ce processus et des ffmpeg déjà terminés."""
    ch = resource.getrusage(resource.RUSAGE_CHILDREN)
    return time.process_time() + ch.ru_utime + ch.ru_stime


def next_item(db: Database, voice_model: str):
    """Un élément fini dont les voix sont complètes et qui n'est pas passé par la lecture des lèvres (ou
    sous une version antérieure, un autre fichier, un autre modèle de voix), ou dont le passage a été
    interrompu ; le plus récemment touché d'abord."""
    return db.one(
        """SELECT i.* FROM items i JOIN voice_results v ON v.item_id = i.item_id
           LEFT JOIN asd_runs a ON a.item_id = i.item_id
           WHERE i.status='done' AND v.complete=1 AND v.etag = i.etag AND v.model = ?
             AND (a.item_id IS NULL OR a.status != 'done' OR a.etag != i.etag OR a.version < ?
                  OR COALESCE(a.voice_model, '') != ?)
           ORDER BY i.updated DESC LIMIT 1""",
        (voice_model, ASD_VERSION, voice_model),
    )


def _save_run(db: Database, row, voice_model: str, status: str, state: dict, stats: dict) -> None:
    """Le bilan du passage — seulement si l'élément est toujours là, au même fichier (un DELETE pendant
    la lecture ne laisse rien derrière lui)."""
    with db.tx() as c:
        cur = c.execute("SELECT etag FROM items WHERE item_id=?", (row["item_id"],)).fetchone()
        if cur is None or cur["etag"] != row["etag"]:
            return
        c.execute("""INSERT OR REPLACE INTO asd_runs (item_id, etag, voice_model, version, status, state_json, stats_json, updated)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                  (row["item_id"], row["etag"], voice_model, ASD_VERSION, status, json.dumps(state), json.dumps(stats), time.time()))


def _decode_window(path, info, a: float, b: float, track, guard, cancel):
    """(images NV12, son int16) de la fenêtre ; toutes les images, sur l'iGPU si possible."""
    want = (settings.hwaccel and decode.vaapi_suits(info) and decode.vaapi_available()
            and not (guard is not None and guard.busy()))
    for vaapi in ([True, False] if want else [False]):
        stats = decode.DecodeStats("vaapi" if vaapi else "cpu")
        audio_out: list = []
        frames = [f for _, f in decode.read_frames(path, a, b - a, info, vaapi, stats, cancel, fps=FPS,
                                                  width=settings.frame_width, audio=track,
                                                  audio_out=audio_out if track is not None else None, noref=False)]
        if not stats.failed:
            pcm = audio_out[0][1] if audio_out else np.zeros(0, np.int16)
            return frames, pcm, stats.decoder
    raise RuntimeError(f"ffmpeg ({stats.decoder}) code {stats.returncode} : {stats.stderr[-300:]}")


def run_item(db: Database, row, engine, net, voice_model: str, built, should_stop, guard=None, cancel=None,
             budget_s: float | None = None, p: AsdParams = DEFAULT) -> str:
    """La lecture des lèvres d'un élément ; rend `done` ou `yield` (un ordre plus pressé attend)."""
    item_id, etag, path = row["item_id"], row["etag"], row["path"]
    budget = settings.asd_budget_s if budget_s is None else budget_s
    prev = db.one("SELECT * FROM asd_runs WHERE item_id=?", (item_id,))
    resume = (prev is not None and prev["status"] == "partial" and prev["etag"] == etag
              and prev["version"] == ASD_VERSION and prev["voice_model"] == voice_model)
    state = json.loads(prev["state_json"]) if resume and prev["state_json"] else {}
    done_w = {tuple(w) for w in state.get("windows", [])}
    spent0 = float(state.get("cpu", 0.0))
    c0, t0 = cpu_now(), time.monotonic()

    regions, wins, embs = voicejob.load_voice(db, item_id)
    memory = voicejob.series_memory(db, row["series_id"], voice_model, exclude_item=item_id)
    before = build(regions, wins, embs, built.presence, built.scenes, memory, asd=voicejob.load_asd(db, item_id))
    plans = state.get("plans")
    if plans is None:
        plans = [{"voice": vp.voice, "size": vp.size, "candidates": vp.candidates, "pieces": vp.pieces}
                 for vp in plan(before, p)]
        state["plans"] = plans
        # Les voix indécises *du résultat gardé* (celui de la fin de l'analyse) : la reconstruction `before`
        # lit la mémoire de la série du moment, qu'un autre épisode a pu changer depuis.
        stored = _stored_voice_stats(db, item_id)
        state["undecidedBefore"] = stored.get("voicesUndecided", before.stats.get("voicesUndecided", 0))
    vplans = [VoicePlan(d["voice"], d["size"], d["candidates"], [tuple(x) for x in d["pieces"]]) for d in plans]
    wlist = windows(vplans, p)
    stats = {"voicesTried": len(vplans), "windows": len(wlist), "videoSeconds": round(sum(b - a for a, b, _ in wlist), 1)}
    if not vplans:
        stats.update(voicesResolved=0, voicesUndecided=before.stats.get("voicesUndecided", 0), cpuSeconds=0.0)
        _save_run(db, row, voice_model, "done", {}, stats)
        event(log, "[xray] %s : lecture des lèvres — aucune voix à lire (%d indécises)", item_id,
              stats["voicesUndecided"], item=item_id, action="asd_done", **stats)
        _report(db, item_id)
        return "done"
    event(log, "[xray] %s : lecture des lèvres — %d voix à lire, %d fenêtres (%.0f s de vidéo)%s", item_id, len(vplans),
          len(wlist), stats["videoSeconds"], " (reprise)" if resume else "", item=item_id, action="asd_start",
          resume=resume, budgetS=budget, spentS=round(spent0, 1),
          voices=[{"voiceId": vp.voice, "pieces": vp.size, "candidates": vp.candidates, "lines": len(vp.pieces)}
                  for vp in vplans], windows=len(wlist), videoSeconds=stats["videoSeconds"])

    info = decode.probe(path)
    track, _ = voicejob.track_for(db, row, path)
    cis = sorted(built.assignments)
    cents = built.centroids[cis] if built.centroids is not None and cis else np.zeros((0, 512), np.float32)
    ids = [built.assignments[ci].person_id for ci in cis]
    decoders = set()
    capped = False
    nvotes = 0
    calls0 = device_calls(engine)
    for a, b, pcs in wlist:
        if (a, b) in done_w:
            continue
        if should_stop():
            state.update(windows=sorted(done_w), cpu=spent0 + cpu_now() - c0)
            _save_run(db, row, voice_model, "partial", state, stats)
            event(log, "[xray] %s : lecture des lèvres — cède la place à un ordre plus pressé (%d/%d fenêtres)", item_id,
                  len(done_w), len(wlist), item=item_id, action="asd_yield", windowsDone=len(done_w), windows=len(wlist))
            return "yield"
        if spent0 + cpu_now() - c0 >= budget:
            capped = True
            break
        frames, pcm, dec = _decode_window(path, info, a, b, track, guard, cancel)
        decoders.add(dec)
        # Couleur pour les seules images de détection ; niveaux de gris (la luminance, ramenée à la pleine
        # échelle comme le ferait une conversion BGR → gris) pour toutes : la mémoire reste petite.
        h = frames[0].shape[0] * 2 // 3 if frames else 0
        grays = [cv2.convertScaleAbs(f[:h], alpha=255 / 219, beta=-16 * 255 / 219) for f in frames]
        bgrs = {k: cv2.cvtColor(frames[k], cv2.COLOR_YUV2BGR_NV12) for k in range(0, len(frames), p.det_every)}
        del frames
        dets = {}
        for k, im in bgrs.items():
            dets[k] = [f for f in engine.detector.detect(im) if f.score >= p.det_score and f.min_side >= p.min_box]
        tracks = link_tracks(dets, len(grays), p)
        identify(engine, bgrs, tracks, cents, ids, p)
        score_tracks(net, tracks, grays, pcm)
        votes = piece_votes(tracks, a, pcs, p)
        with db.tx() as c:
            cur = c.execute("SELECT etag FROM items WHERE item_id=?", (item_id,)).fetchone()
            if cur is None or cur["etag"] != etag:
                return "done"
            c.executemany("""INSERT OR REPLACE INTO asd_votes (item_id, start, end, person_id, score, second, faces)
                             VALUES (?, ?, ?, ?, ?, ?, ?)""",
                          [(item_id, float(s), float(e), who, sc, sec, int(nf)) for s, e, who, sc, sec, nf in votes])
        nvotes += sum(1 for v in votes if v[3] is not None)
        done_w.add((a, b))
    cpu = round(spent0 + cpu_now() - c0, 1)
    if any(v[2] is not None for v in voicejob.load_asd(db, item_id)):
        res = voicejob.assemble(db, item_id, etag, voice_model, row["series_id"],
                                json.loads(row["voice_track_json"]) if row["voice_track_json"] else None,
                                built.presence, built.scenes, final=True)
    else:
        # Aucune voix nommée par les lèvres : le résultat de la fin de l'analyse reste tel quel. Le refaire
        # ici changeait des noms sans aucun vote (mémoire de la série relue, Ted Lasso S01E10, 10/11/2026).
        res = None
    resolved = 0
    if res is not None:
        rows = res.pieces
        for vp in vplans:
            idx = [i for i, r in enumerate(rows) if r[2] == vp.voice]
            if idx and sum(1 for i in idx if rows[i][3] is not None) >= 0.5 * len(idx):
                resolved += 1
    calls1 = device_calls(engine)
    kept = _stored_voice_stats(db, item_id) if res is None else {}
    stats.update(voicesResolved=resolved,
                 voicesUndecided=(res.stats.get("voicesUndecided") if res else kept.get("voicesUndecided")),
                 resultKept=res is None,
                 undecidedBefore=state.get("undecidedBefore"), votes=nvotes, cpuSeconds=cpu, capped=capped,
                 wallSeconds=round(time.monotonic() - t0, 1), decoders=sorted(decoders),
                 voicesAsd=(res.stats.get("voicesAsd") if res else kept.get("voicesAsd")),
                 # Détecteur et empreinte de cette lecture : appels servis par l'iGPU et le processeur (ce
                 # passage-ci ; Light-ASD lui-même tourne sur le processeur).
                 inference=None if calls0 is None or calls1 is None else
                 {k: calls1[k] - calls0[k] for k in calls1})
    _save_run(db, row, voice_model, "done", {"windows": sorted(done_w)}, stats)
    event(log, "[xray] %s : lecture des lèvres — %d voix lues, %d nommées, %d indécises restent (avant : %s) ; "
          "%d fenêtres, %.0f s de vidéo, %d votes, %.0f s de calcul%s", item_id, len(vplans), resolved,
          stats["voicesUndecided"] or 0, stats["undecidedBefore"], len(wlist), stats["videoSeconds"], nvotes, cpu,
          " (plafond atteint)" if capped else "", item=item_id, action="asd_done", **stats)
    _report(db, item_id)
    return "done"


def _stored_voice_stats(db: Database, item_id: str) -> dict:
    r = db.one("SELECT stats_json FROM voice_results WHERE item_id=?", (item_id,))
    try:
        return json.loads(r["stats_json"]) if r is not None and r["stats_json"] else {}
    except ValueError:
        return {}


def _report(db: Database, item_id: str) -> None:
    from . import report

    report.save(db, item_id, "lèvres")
