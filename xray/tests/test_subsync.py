"""« Synchro des sous-titres » : la mesure sur des masques synthétiques au décalage et à l'échelle connus, le tri
des répliques qui ne sont que bruits, la lecture SubRip / WebVTT / ASS, les seuils des verdicts, et l'ordre (API,
file, exécution avec une lecture de fichier simulée)."""

import json
import random

import pytest

from app import subsync as S
from app import subsyncjob as J
from conftest import AUTH, EPISODE, ITEM, ITEM2, MEDIA


def speech_track(duration: float, seed: int = 1) -> list[tuple[float, float]]:
    """Des zones de parole plausibles : 0,4 à 4 s, séparées de 0,2 à 3 s, des silences plus longs de temps en temps."""
    rnd = random.Random(seed)
    t, out = 20.0, []
    while t < duration - 10:
        d = rnd.uniform(0.4, 4.0)
        out.append((t, t + d))
        t += d + (rnd.uniform(0.2, 3.0) if rnd.random() > 0.1 else rnd.uniform(5, 25))
    return out


def cues_from(speech, a: float, s: float, seed: int = 2, jitter: float = 0.08):
    """Les répliques d'un sous-titre dont la parole tombe en `a + s·t` : t = (parole − a) / s, un peu bruité."""
    rnd = random.Random(seed)
    out = []
    for x, y in speech:
        if rnd.random() < 0.15:
            continue  # une réplique non sous-titrée
        out.append(((x - a) / s + rnd.uniform(-jitter, jitter), (y - a) / s + rnd.uniform(-jitter, jitter)))
    return [c for c in out if c[1] > c[0] and c[0] > 0]


DUR = 2700.0  # un épisode de 45 min


@pytest.fixture(scope="module")
def speech():
    return speech_track(DUR)


def test_cale_dit_ok(speech):
    m = S.measure(speech, cues_from(speech, 0.0, 1.0), duration=DUR)
    assert m["verdict"] == "ok" and m["reliable"] and m["confidence"] == "high"
    assert abs(m["offset"]) < 0.05 and m["scale"] == 1.0 and m["scaleLabel"] == "1"
    assert m["windows"] >= 6 and m["inliers"] >= 0.8 and m["z"] >= 5


@pytest.mark.parametrize("a", [2.5, -7.0, 31.0, -95.0])
def test_decalage_connu(speech, a):
    m = S.measure(speech, cues_from(speech, a, 1.0), duration=DUR)
    assert m["verdict"] == "décalé"
    assert abs(m["offset"] - a) < 0.06
    assert m["scale"] == 1.0 and abs(m["maxErrorS"] - abs(a)) < 0.06


@pytest.mark.parametrize("label", ["25→23.976", "23.976→25", "24→23.976", "25→24"])
def test_derive_connue_ramenee_au_rapport(speech, label):
    s = dict(S.SCALES)[label]
    m = S.measure(speech, cues_from(speech, 1.5, s), duration=DUR)
    assert m["verdict"] == "dérive" and m["reliable"]
    assert m["scaleLabel"] == label and m["scale"] == s
    assert abs(m["offset"] - 1.5) < 0.1


def test_petit_decalage_reste_ok(speech):
    # 0,3 s : sous le seuil de 0,5 s — rien à corriger.
    m = S.measure(speech, cues_from(speech, 0.3, 1.0), duration=DUR)
    assert m["verdict"] == "ok" and abs(m["offset"] - 0.3) < 0.06


def test_peu_de_repliques(speech):
    cues = cues_from(speech, 2.0, 1.0)[:60]
    m = S.measure(speech, cues, duration=DUR)
    assert m["verdict"] == "peu-de-répliques" and not m["reliable"]


def test_sans_rapport_dit_incertain(speech):
    other = speech_track(DUR, seed=99)
    m = S.measure(speech, cues_from(other, 0.0, 1.0), duration=DUR)
    assert m["verdict"] == "incertain" and not m["reliable"]


def test_montage_saut_au_milieu():
    sp = speech_track(5400.0, seed=5)
    half = len(sp) // 2
    # La seconde moitié du sous-titre décalée de 2 s : nettes, les fenêtres ne tombent plus sur une droite.
    cues = cues_from(sp[:half], 0.0, 1.0, seed=3) + cues_from(sp[half:], 2.0, 1.0, seed=4)
    m = S.measure(sp, cues, duration=5400.0)
    assert m["verdict"] == "montage" and not m["reliable"]


def test_zone_non_ecoutee_ne_compte_pas(speech):
    cues = cues_from(speech, 2.5, 1.0)
    # La parole écoutée seulement sur le premier tiers : moins de fenêtres, la mesure reste juste.
    m = S.measure(speech, cues, valid_ranges=[(0.0, DUR / 3)], duration=DUR)
    assert m["windows"] <= 6
    assert abs(m["offset"] - 2.5) < 0.1


def test_cache_de_la_parole_partage(speech):
    cache: dict = {}
    a = S.measure(speech, cues_from(speech, 2.5, 1.0), speech_fft_cache=cache, duration=DUR)
    n = cache["n"]
    b = S.measure(speech, cues_from(speech, -3.0, 1.0, seed=7), speech_fft_cache=cache, duration=DUR)
    assert cache["n"] == n
    assert abs(a["offset"] - 2.5) < 0.06 and abs(b["offset"] + 3.0) < 0.06


def test_snap_scale():
    assert S.snap_scale(1.000020) == (1.0, "1")
    assert S.snap_scale(1.0003)[1] is None
    # Sur une piste courte, un écart qui ne déplace rien de plus de 0,15 s est ramené à 1.
    assert S.snap_scale(1.0003, span=400.0) == (1.0, "1")
    r = dict(S.SCALES)["25→23.976"]
    assert S.snap_scale(r * (1 + 50e-6)) == (r, "25→23.976")
    assert S.snap_scale(r * (1 + 200e-6))[1] is None


def test_verdict_seuils():
    base = {"z": 6.0, "windows": 8, "candidateWindows": 9, "inliers": 0.9, "madMs": 80.0, "speechCues": 300,
            "maxErrorS": 1.2, "scale": 1.0}
    assert S.verdict_of(base) == {"reliable": True, "confidence": "high", "verdict": "décalé"}
    assert S.verdict_of({**base, "maxErrorS": 0.4})["verdict"] == "ok"
    assert S.verdict_of({**base, "scale": 25 / 24})["verdict"] == "dérive"
    for k, v in (("z", 4.9), ("windows", 5), ("madMs", 151.0), ("speechCues", 99)):
        assert not S.verdict_of({**base, k: v})["reliable"], k
    assert S.verdict_of({**base, "speechCues": 99})["verdict"] == "peu-de-répliques"
    assert S.verdict_of({**base, "inliers": 0.5})["verdict"] == "montage"
    # Peu de fenêtres nettes parmi les possibles : un hasard, pas un montage.
    assert S.verdict_of({**base, "inliers": 0.5, "candidateWindows": 30})["verdict"] == "incertain"
    assert S.verdict_of({**base, "z": 2.0, "windows": 2})["confidence"] == "low"


# ---- lecture des sous-titres ---------------------------------------------------------------------------

SRT = """1
00:00:01,000 --> 00:00:02,500
<i>Bonjour.</i>

2
00:00:03,000 --> 00:00:04,000
[rires]

3
00:00:05,000 --> 00:00:06,000
- (soupir)
- Encore toi ?

4
00:00:07,000 --> 00:00:08,000
♪ la la la ♪

5
00:00:09,5 --> 00:00:10,25
{\\an8}Là-haut.
"""


def test_srt_bruits_ecartes():
    p = S.parse_srt(SRT)
    assert p.total == 5 and p.sound == 2
    assert p.speech == [(1.0, 2.5), (5.0, 6.0), (9.5, 10.25)]


def test_vtt():
    vtt = "WEBVTT\n\n00:01.000 --> 00:02.000 line:90%\nSalut\n\n01:00:00.000 --> 01:00:01.500\n(musique)\n"
    p = S.parse_srt(vtt)
    assert p.speech == [(1.0, 2.0)] and p.sound == 1


def test_ass():
    ass = """[Script Info]
Title: x

[V4+ Styles]
Format: Name, Fontname
Style: Default,Arial

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\i1}Bonjour, toi.{\\i0}\\NSecond, avec virgule
Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,[porte qui claque]
Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,note
Dialogue: 0,0:00:07.00,0:00:08.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}
"""
    p = S.parse_ass(ass)
    assert p.speech == [(1.0, 2.5)] and p.sound == 1 and p.total == 2
    assert S.parse_subtitle(ass, ".ass").speech == p.speech


def test_flux_de_sous_titres():
    data = {"streams": [{"index": 3, "codec_name": "subrip", "tags": {"language": "fre", "title": "Français SDH"},
                         "disposition": {"default": 1, "forced": 0}},
                        {"index": 4, "codec_name": "hdmv_pgs_subtitle", "tags": {"language": "eng"}, "disposition": {}}]}
    subs = J.parse_subtitle_streams(data)
    assert subs[0].text and not subs[0].image and subs[0].hi and subs[0].default and subs[0].language == "fre"
    assert subs[1].image and not subs[1].text


def test_filtre_du_son_complete_le_debut():
    from app.audio import AudioTrack

    t = AudioTrack(1, 0, "ac3", 6, "5.1(side)", "eng", "", True, False, False)
    args = J.speech_filter(t)
    assert args[:2] == ["-af", "pan=mono|c0=FC,aresample=async=1:first_pts=0"] and "-ar" in args
    t2 = AudioTrack(1, 0, "aac", 2, "stereo", "eng", "", True, False, False)
    assert J.speech_filter(t2)[:2] == ["-af", "aresample=async=1:first_pts=0"]


# ---- l'ordre ---------------------------------------------------------------------------------------------

EXT = MEDIA / "tv" / "Show" / "S01E01.fr.srt"


def _ext_file(text: str = SRT) -> str:
    EXT.write_text(text, encoding="utf-8")
    return str(EXT)


def subjob(item=ITEM, **over):
    body = {"itemId": item, "path": EPISODE, "etag": "etag-1", "priority": "low"}
    if "externals" not in over:
        body["externals"] = [{"path": _ext_file(), "language": "fre", "forced": False, "hi": False}]
    body.update(over)
    return body


def test_ordre_exige_la_cle(client):
    assert client.post("/subsync/jobs", json=subjob()).status_code == 401
    assert client.get(f"/subsync/results?itemId={ITEM}").status_code == 401


def test_ordre_puis_lecture(client):
    r = client.post("/subsync/jobs", json=subjob(), headers=AUTH)
    assert r.status_code == 202
    assert r.json() == {"itemId": ITEM, "status": "queued", "position": 0}
    body = client.get(f"/subsync/results?itemId={ITEM},{ITEM2}", headers=AUTH).json()
    assert body["version"] == S.ALGO_VERSION
    first, second = body["items"]
    assert first["itemId"] == ITEM and first["status"] == "queued" and first["tracks"] == []
    # Un élément inconnu : dans la liste, jamais un 404.
    assert second == {"itemId": ITEM2, "status": "unknown", "tracks": []}
    assert client.get("/health", headers=AUTH).json()["subsync"]["pending"] == 1
    # En double : rien de relancé, la priorité peut seulement monter.
    r = client.post("/subsync/jobs", json=subjob(priority="high"), headers=AUTH)
    assert r.status_code == 202 and r.json()["status"] == "queued"
    assert client.db.one("SELECT priority FROM subsync_jobs WHERE item_id=?", (ITEM,))["priority"] == 0


def test_ordre_refuse(client):
    for over, msg in (({"itemId": "x"}, "itemId"), ({"path": "/etc/passwd"}, "path"),
                      ({"externals": [{"path": "/etc/passwd.srt"}]}, "hors de la médiathèque"),
                      ({"externals": [{"path": str(MEDIA / "tv" / "Show" / "notes.txt")}]}, ".srt"),
                      ({"priority": "vite"}, "priority"), ({"force": "oui"}, "force")):
        r = client.post("/subsync/jobs", json=subjob(**over), headers=AUTH)
        assert r.status_code == 400 and msg in r.json()["error"], over
    assert client.get("/subsync/results", headers=AUTH).status_code == 400


def _speech_row(db, item=ITEM, etag="etag-1"):
    sp = speech_track(DUR)
    db.run("INSERT OR REPLACE INTO subsync_speech (item_id, etag, source, regions_json, valid_json, track_json, updated) "
           "VALUES (?, ?, 'parole-seule', ?, ?, NULL, 0)", (item, etag, json.dumps(sp), json.dumps([[0, DUR]])))
    return sp


def _srt(cues) -> str:
    def ts(t):
        ms = int(round(t * 1000))
        return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"
    return "\n".join(f"{i + 1}\n{ts(a)} --> {ts(b)}\nRéplique {i}\n" for i, (a, b) in enumerate(cues))


def test_execution_avec_lecture_simulee(client, monkeypatch):
    db = client.db
    sp = _speech_row(db)
    ext = _ext_file(_srt(cues_from(sp, 3.0, 1.0)))
    client.post("/subsync/jobs", json=subjob(externals=[{"path": ext, "language": "fre"}]), headers=AUTH)

    emb_text = _srt(cues_from(sp, 0.0, dict(S.SCALES)["25→23.976"], seed=8))

    def fake_probe(path):
        return [J.SubStream(2, "subrip", "eng", None, True, False, False),
                J.SubStream(3, "hdmv_pgs_subtitle", "eng", None, False, False, False)], DUR

    def fake_read(path, track, subs, tmpdir, vad, should_stop):
        assert track is None and vad is None  # la parole est gardée : rien à réécouter
        files = {}
        for s in subs:
            p = f"{tmpdir}/s{s.index}.srt"
            open(p, "w").write(emb_text)
            files[s.index] = p
        return None, 0.0, files, 0.1

    monkeypatch.setattr(J, "probe_subtitles", fake_probe)
    monkeypatch.setattr(J, "read_file", fake_read)
    row = J.next_job(db)
    assert J.run_job(db, row, lambda: None, lambda: False) == "done"
    item = client.get(f"/subsync/results?itemId={ITEM}", headers=AUTH).json()["items"][0]
    assert item["status"] == "done" and item["speechSource"] == "parole-seule" and item["version"] == S.ALGO_VERSION
    tracks = {t["trackKey"]: t for t in item["tracks"]}
    assert tracks["emb:3"]["verdict"] == "image"
    assert tracks["emb:2"]["verdict"] == "dérive" and tracks["emb:2"]["scaleLabel"] == "25→23.976"
    ext_t = tracks[f"ext:{ext}"]
    assert ext_t["verdict"] == "décalé" and abs(ext_t["offset"] - 3.0) < 0.06 and ext_t["kind"] == "external"
    assert ext_t["size"] > 0 and ext_t["mtime"] > 0
    # Même fichier, mêmes fichiers à côté, même algorithme : rien n'est relancé.
    r = client.post("/subsync/jobs", json=subjob(externals=[{"path": ext, "language": "fre"}]), headers=AUTH)
    assert r.status_code == 200 and r.json()["status"] == "done"
    # Un autre fichier (etag) : en file à nouveau, la mesure d'avant reste lisible avec son etag.
    r = client.post("/subsync/jobs", json=subjob(etag="etag-2", externals=[{"path": ext, "language": "fre"}]), headers=AUTH)
    assert r.status_code == 202
    item = client.get(f"/subsync/results?itemId={ITEM}", headers=AUTH).json()["items"][0]
    assert item["status"] == "queued" and item["etag"] == "etag-2" and item["resultEtag"] == "etag-1"
    since = client.get("/subsync/results?since=0", headers=AUTH).json()
    assert [i["itemId"] for i in since["items"]] == [ITEM]


def test_execution_cede_la_place(client, monkeypatch):
    db = client.db
    client.post("/subsync/jobs", json=subjob(externals=[]), headers=AUTH)
    monkeypatch.setattr(J, "probe_subtitles", lambda p: ([J.SubStream(2, "subrip", "eng", None, True, False, False)], DUR))

    def fake_read(*a, **k):
        raise J.Yielded()

    monkeypatch.setattr(J, "read_file", fake_read)
    monkeypatch.setattr(J.audiomod, "probe_tracks", lambda p: [J.audiomod.AudioTrack(1, 0, "aac", 2, "stereo", "eng", "", True, False, False)])
    assert J.run_job(db, J.next_job(db), lambda: object(), lambda: True) == "yield"
    assert db.one("SELECT status FROM subsync_jobs WHERE item_id=?", (ITEM,))["status"] == "queued"


def test_execution_sans_detection_de_parole(client, monkeypatch):
    db = client.db
    client.post("/subsync/jobs", json=subjob(externals=[]), headers=AUTH)
    monkeypatch.setattr(J, "probe_subtitles", lambda p: ([], DUR))
    monkeypatch.setattr(J.audiomod, "probe_tracks", lambda p: [J.audiomod.AudioTrack(1, 0, "aac", 2, "stereo", "eng", "", True, False, False)])
    assert J.run_job(db, J.next_job(db), lambda: None, lambda: False) == "failed"
    item = client.get(f"/subsync/results?itemId={ITEM}", headers=AUTH).json()["items"][0]
    assert item["status"] == "failed" and "détection de parole" in item["error"]


def test_parole_de_qui_parle_reprise(db):
    db.run("INSERT INTO items (item_id, etag, path, priority, cast_json, status, seq, created, updated, skip_json) "
           "VALUES (?, 'e', '/x', 1, '[]', 'done', 1, 0, 0, ?)", (ITEM, json.dumps([[100, 200]])))
    db.run("INSERT INTO voice_results (item_id, etag, model, segments_json, analyzed_until, complete, version, updated) "
           "VALUES (?, 'e', 'm', '[]', 0, 1, 2, 0)", (ITEM,))
    for i in range(3):
        db.run("INSERT INTO chunks (item_id, idx, start, end, voice) VALUES (?, ?, ?, ?, 1)", (ITEM, i, i * 120.0, (i + 1) * 120.0))
    db.run("INSERT INTO voice_regions (item_id, chunk_idx, start, end) VALUES (?, 0, 10, 12)", (ITEM,))
    regions, valid = J.voice_speech(db, ITEM, "e")
    assert regions == [(10.0, 12.0)]
    assert valid == [(0.0, 100.0), (200.0, 240.0), (240.0, 360.0)]
    assert J.voice_speech(db, ITEM, "autre") is None
