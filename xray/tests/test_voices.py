"""« Qui parle » : assemblage (voices.py), piste son (audio.py), stockage (voicejob.py), API, son du même ffmpeg."""

import json
import os
import shutil
import subprocess
import tempfile

import numpy as np
import pytest

from app import audio as audiomod
from app import voicejob
from app.config import VOICE_VERSION, settings
from app.voice import speech_regions, windows_in
from app.voices import VoiceParams, build, make_pieces, split_on_change
from conftest import AUTH, ITEM, job, unit, noisy


# ---- données synthétiques : un champ-contrechamp ------------------------------------------------

def dialogue(rng, turns, voices, dim=256, gap=0.4, turn_len=4.0):
    """`turns` : la voix de chaque tour de parole. Rend (zones, fenêtres, empreintes)."""
    regions, wins, embs = [], [], []
    t = 0.0
    for v in turns:
        s, e = t, t + turn_len
        regions.append((s, e))
        for (a, b) in windows_in([(s, e)]):
            wins.append((a, b))
            embs.append(noisy(rng, voices[v], 0.35))
        t = e + gap
    return regions, np.array(wins), np.array(embs, dtype=np.float32)


def shots_for(regions, turns, shown):
    """Un plan par tour de parole ; `shown[v]` : qui est à l'image quand la voix v parle."""
    pres = []
    for (s, e), v in zip(regions, turns):
        for pid, frac in shown[v]:
            pres.append((s, e, pid, frac))
    return pres


def scenes_of(regions):
    return [{"start": regions[0][0], "end": regions[-1][1] + 1, "people": []}]


@pytest.fixture
def rng():
    return np.random.default_rng(7)


def test_morceaux_egaux_de_deux_secondes_au_plus():
    p = make_pieces([(0.0, 5.0), (6.0, 6.5)], 2.0)
    assert p == [(0.0, 5 / 3), (5 / 3, 10 / 3), (10 / 3, 5.0), (6.0, 6.5)]


def test_coupe_au_changement_de_voix(rng):
    a, b = unit(rng, 256), unit(rng, 256)
    # Une seule zone de 6 s sans silence : A puis B à 3 s.
    wins = np.array(windows_in([(0.0, 6.0)]))
    embs = np.array([noisy(rng, a if (w0 + w1) / 2 < 3 else b, 0.2) for w0, w1 in wins], dtype=np.float32)
    unitv = embs / np.linalg.norm(embs, axis=1, keepdims=True)
    cut = split_on_change([(0.0, 6.0)], wins, unitv, 0.5)
    assert len(cut) == 2 and abs(cut[0][1] - 3.0) <= 0.5
    # Une même voix n'est jamais coupée.
    same = np.array([noisy(rng, a, 0.2) for _ in wins], dtype=np.float32)
    assert split_on_change([(0.0, 6.0)], wins, same / np.linalg.norm(same, axis=1, keepdims=True), 0.5) == [(0.0, 6.0)]


def test_champ_contrechamp_nomme_chaque_voix(rng):
    A, B = unit(rng), unit(rng)
    voices = {"A": A, "B": B}
    turns = ["A", "B"] * 12
    regions, wins, embs = dialogue(rng, turns, voices)
    # Quand A parle, on voit surtout A (et un peu B de dos) ; et inversement.
    shown = {"A": [(1, 0.9), (2, 0.2)], "B": [(2, 0.9), (1, 0.2)]}
    r = build(regions, wins, embs, shots_for(regions, turns, shown), scenes_of(regions))
    named = {}
    for s in r.segments:
        if s["personId"] is not None:
            mid = (s["start"] + s["end"]) / 2
            k = next(i for i, (a, b) in enumerate(regions) if a <= mid < b)
            named.setdefault(turns[k], set()).add(s["personId"])
    assert named == {"A": {1}, "B": {2}}
    assert all(0 < s["confidence"] <= 1 for s in r.segments if s["personId"])
    assert r.stats["voicesNamed"] == 2 and r.stats["voicesConflict"] == 0
    # Les visages ont nommé chaque voix : la mémoire de la série peut les apprendre.
    assert set(r.profiles) == {1, 2}


def test_une_personne_une_voix_la_voix_au_telephone_reste_sans_nom(rng):
    A, B, P = unit(rng), unit(rng), unit(rng)
    turns = ["A", "B"] * 12 + ["A", "P"] * 22
    regions, wins, embs = dialogue(rng, turns, {"A": A, "B": B, "P": P})
    # Au téléphone, A est seul à l'image pendant que la voix P parle.
    shown = {"A": [(1, 0.9), (2, 0.2)], "B": [(2, 0.9), (1, 0.2)], "P": [(1, 0.9)]}
    r = build(regions, wins, embs, shots_for(regions, turns, shown), scenes_of(regions))
    for s in r.segments:
        mid = (s["start"] + s["end"]) / 2
        k = next(i for i, (a, b) in enumerate(regions) if a <= mid < b)
        if turns[k] == "P":
            assert s["personId"] != 1, "la voix du téléphone reçoit le nom du seul visage"


def test_desaccord_memoire_visages_laisse_sans_nom_et_le_dit(rng):
    A, B = unit(rng), unit(rng)
    turns = ["A", "B"] * 12
    regions, wins, embs = dialogue(rng, turns, {"A": A, "B": B})
    shown = {"A": [(1, 0.9), (2, 0.2)], "B": [(2, 0.9), (1, 0.2)]}
    # La mémoire de la série tient la voix A pour la personne 2, et la voix B pour la personne 1.
    r = build(regions, wins, embs, shots_for(regions, turns, shown), scenes_of(regions), memory={2: A, 1: B})
    assert r.segments and all(s["personId"] is None for s in r.segments)
    assert all(s.get("conflict") is True for s in r.segments)
    assert r.stats["voicesConflict"] == 2 and r.stats["voicesNamed"] == 0
    # Une mémoire d'accord ne change rien aux noms.
    ok = build(regions, wins, embs, shots_for(regions, turns, shown), scenes_of(regions), memory={1: A, 2: B})
    assert {s["personId"] for s in ok.segments} == {1, 2} and not any(s.get("conflict") for s in ok.segments)


def test_la_memoire_nomme_une_voix_que_les_visages_laissent(rng):
    A, B = unit(rng), unit(rng)
    turns = ["A", "B"] * 12
    regions, wins, embs = dialogue(rng, turns, {"A": A, "B": B})
    # Les deux toujours ensemble à l'image, à parts égales : les visages ne départagent pas.
    shown = {"A": [(1, 0.8), (2, 0.8)], "B": [(1, 0.8), (2, 0.8)]}
    bare = build(regions, wins, embs, shots_for(regions, turns, shown), scenes_of(regions))
    assert all(s["personId"] is None for s in bare.segments)
    mem = build(regions, wins, embs, shots_for(regions, turns, shown), scenes_of(regions), memory={1: A, 2: B})
    assert {s["personId"] for s in mem.segments} == {1, 2}
    # Nommées par la mémoire seule : elles ne la nourrissent pas en retour.
    assert mem.profiles == {}


def test_consensus_un_seul_avis_ne_suffit_pas(rng):
    A, B = unit(rng), unit(rng)
    turns = ["A", "B"] * 12
    regions, wins, embs = dialogue(rng, turns, {"A": A, "B": B})
    shown = {"A": [(1, 0.9), (2, 0.2)], "B": [(2, 0.9), (1, 0.2)]}
    # Trois seuils absurdes sur quatre (tout en une voix) : rien n'obtient deux avis.
    p = VoiceParams(thresholds=(1.9, 1.95, 1.99, 0.7), need=2)
    r = build(regions, wins, embs, shots_for(regions, turns, shown), scenes_of(regions), params=p)
    assert all(s["personId"] is None for s in r.segments)


def test_sans_parole_rien():
    r = build([], np.zeros((0, 2)), np.zeros((0, 256), np.float32), [], [])
    assert r.segments == [] and r.stats["pieces"] == 0


# ---- détection de parole, fenêtres ----------------------------------------------------------------

def test_zones_de_parole_jointes_et_courtes_ecartees():
    hop = 512 / 16000
    prob = np.zeros(200)
    prob[10:40] = 0.9   # 0,96 s
    prob[44:60] = 0.9   # silence de 0,13 s : jointe
    prob[100:104] = 0.9  # 0,13 s : écartée
    regs = speech_regions(prob)
    assert len(regs) == 1 and abs(regs[0][0] - 10 * hop) < 1e-9 and abs(regs[0][1] - 60 * hop) < 1e-9


def test_fenetres():
    assert windows_in([(0.0, 1.0)]) == [(0.0, 1.0)]
    w = windows_in([(0.0, 3.0)])
    assert w[0] == (0.0, 1.5) and w[-1] == (1.5, 3.0) and len(w) == 4
    w = windows_in([(0.0, 2.8)])
    assert w[-1] == pytest.approx((1.3, 2.8))  # la fin non couverte reçoit une fenêtre calée sur elle


# ---- la piste son ---------------------------------------------------------------------------------

TED = {"streams": [
    {"index": 1, "codec_type": "audio", "codec_name": "eac3", "channels": 6, "channel_layout": "5.1(side)",
     "tags": {"language": "fre", "title": "French"}, "disposition": {"default": 1}},
    {"index": 2, "codec_type": "audio", "codec_name": "eac3", "channels": 6, "channel_layout": "5.1(side)",
     "tags": {"language": "fre", "title": "French Audiodescription"}, "disposition": {"default": 0}},
    {"index": 3, "codec_type": "audio", "codec_name": "eac3", "channels": 6, "channel_layout": "5.1(side)",
     "tags": {"language": "eng", "title": "English"}, "disposition": {"default": 0}},
]}


def test_piste_originale_d_apres_la_langue_d_origine():
    tracks = audiomod.parse_tracks(TED)
    assert tracks[1].excluded and not tracks[0].excluded
    t, why = audiomod.choose_track(tracks, "en")
    assert (t.index, t.rel, why) == (3, 2, "original")
    t, why = audiomod.choose_track(tracks, "fr")
    assert (t.index, why) == (1, "original")  # jamais l'audiodescription
    t, why = audiomod.choose_track(tracks, None)
    assert (t.index, why) == (1, "default")
    t, why = audiomod.choose_track(tracks, "en", mode="default")
    assert (t.index, why) == (1, "default")
    t, why = audiomod.choose_track(tracks, "ja")
    assert (t.index, why) == (1, "default")


def test_piste_dite_vo_par_son_titre():
    data = {"streams": [
        {"index": 1, "codec_type": "audio", "channels": 6, "channel_layout": "5.1(side)", "tags": {"language": "fre", "title": "FR VFF : DDP 5.1"}, "disposition": {"default": 1}},
        {"index": 2, "codec_type": "audio", "channels": 8, "channel_layout": "7.1", "tags": {"language": "eng", "title": "ENG VO : DDP 7.1"}, "disposition": {"default": 0}},
    ]}
    t, why = audiomod.choose_track(audiomod.parse_tracks(data), None)
    assert (t.index, why) == (2, "vo")
    assert audiomod.language_matches("ger", "de") and audiomod.language_matches("eng", "en")
    assert not audiomod.language_matches("und", "en") and not audiomod.language_matches("fre", "en")


def test_canal_central_ou_melange_mono():
    tracks = audiomod.parse_tracks(TED)
    assert "pan=mono|c0=FC" in audiomod.audio_filter(tracks[0])
    stereo = audiomod.AudioTrack(1, 0, "aac", 2, "stereo", "fre", "", True, False, False)
    assert audiomod.audio_filter(stereo)[:2] == ["-ac", "1"]
    args = audiomod.audio_output_args(tracks[2], "pipe:9")
    assert args[:2] == ["-map", "0:a:2"] and args[-1] == "pipe:9" and "s16le" in args


# ---- le son sort du même ffmpeg que l'image --------------------------------------------------------

@pytest.fixture(scope="module")
def clip():
    if not shutil.which(settings.ffmpeg) and not os.path.exists(settings.ffmpeg):
        pytest.skip("ffmpeg absent")
    d = tempfile.mkdtemp()
    path = os.path.join(d, "clip.mkv")
    # 4 s d'image, et un 5.1 dont seul le centre porte un son (440 Hz) ; les autres canaux, du silence.
    r = subprocess.run([settings.ffmpeg, "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=4",
                        "-f", "lavfi", "-i", "sine=frequency=440:duration=4:sample_rate=48000",
                        "-filter_complex", "[1:a]pan=5.1(side)|FC=c0[a]", "-map", "0:v", "-map", "[a]",
                        "-c:v", "mpeg4", "-c:a", "ac3", "-y", path], capture_output=True, text=True)
    if r.returncode != 0:
        pytest.skip(f"ffmpeg : {r.stderr[-200:]}")
    yield path
    shutil.rmtree(d, ignore_errors=True)


def test_un_seul_ffmpeg_rend_image_et_son(clip):
    from app import decode

    info = decode.probe(clip)
    track = audiomod.probe_tracks(clip)[0]
    stats = decode.DecodeStats("cpu")
    out: list = []
    frames = list(decode.read_frames(clip, 1.0, 2.0, info, False, stats, audio=track, audio_out=out))
    assert len(frames) >= 7 and not stats.failed
    (start, pcm), = out
    assert start == 1.0
    assert abs(len(pcm) - 2 * 16000) < 0.15 * 16000
    # Le centre porte le son : il est là, et fort.
    assert float(np.abs(pcm.astype(np.float32)).mean()) > 1000
    alone = audiomod.read_audio(clip, 1.0, 2.0, track)
    assert abs(len(alone) - len(pcm)) < 0.15 * 16000


# ---- stockage, son seul, API ------------------------------------------------------------------------

def _item(db, item_id=ITEM, status="done", etag="e1"):
    db.run("""INSERT INTO items (item_id, etag, path, priority, start_at, series_id, cast_json, status, seq, version,
              created, updated, duration) VALUES (?, ?, '/m/x.mkv', 1, 0, ?, '[]', ?, 1, 5, 0, 0, 240)""",
           (item_id, etag, "c" * 32, status))
    db.run("INSERT INTO chunks (item_id, idx, start, end, done) VALUES (?, 0, 0, 120, 1)", (item_id,))
    db.run("INSERT INTO chunks (item_id, idx, start, end, done) VALUES (?, 1, 120, 240, 1)", (item_id,))


def test_stockage_demi_precision_et_resultat_complet(db, rng):
    _item(db)
    embs = np.stack([unit(rng) for _ in range(3)])
    wins = np.array([(1.0, 2.5), (1.5, 3.0), (2.0, 3.5)])
    assert voicejob.store_chunk(db, ITEM, "e1", 0, [(1.0, 3.5)], wins, embs)
    assert not voicejob.store_chunk(db, ITEM, "autre", 1, [], np.zeros((0, 2)), np.zeros((0, 256)))
    regions, w, e = voicejob.load_voice(db, ITEM)
    assert regions == [(1.0, 3.5)] and np.allclose(w, wins)
    assert np.allclose(e, embs, atol=2e-3)
    voicejob.assemble(db, ITEM, "e1", "wespeaker_r34", None, None, [], [], final=True)
    assert db.one("SELECT complete FROM voice_results WHERE item_id=?", (ITEM,))["complete"] == 0  # un tronçon manque
    voicejob.store_chunk(db, ITEM, "e1", 1, [], np.zeros((0, 2)), np.zeros((0, 256)))
    voicejob.assemble(db, ITEM, "e1", "wespeaker_r34", None, None, [], [], final=True)
    assert db.one("SELECT complete FROM voice_results WHERE item_id=?", (ITEM,))["complete"] == 1


def test_un_autre_modele_oublie_les_empreintes(db, rng):
    _item(db)
    db.run("UPDATE items SET voice_model='campplus_en'")
    voicejob.store_chunk(db, ITEM, "e1", 0, [(1.0, 2.0)], np.array([(1.0, 2.0)]), np.stack([unit(rng, 512)]))
    voicejob.reset_if_other_model(db, ITEM, "wespeaker_r34")
    assert db.one("SELECT COUNT(*) FROM voice_windows")[0] == 0
    assert db.one("SELECT SUM(voice) FROM chunks")[0] == 0


def test_son_seul_pour_un_ordre_fini_sans_voix(db):
    _item(db)
    _item(db, "b" * 32, status="queued")
    row = voicejob.next_voice_only(db, "wespeaker_r34")
    assert row["item_id"] == ITEM
    voicejob.no_audio(db, ITEM, "e1", "wespeaker_r34", {"track": None, "reason": "none"})
    assert voicejob.next_voice_only(db, "wespeaker_r34") is None
    # Un autre modèle de voix : à refaire.
    assert voicejob.next_voice_only(db, "campplus_en")["item_id"] == ITEM
    # Un essai en échec attend une semaine.
    db.run("DELETE FROM voice_results")
    db.run("UPDATE items SET voice_tried=?", (1e12,))
    assert voicejob.next_voice_only(db, "wespeaker_r34", now=1e12 + 3600) is None


def test_memoire_de_serie_ponderee(db, rng):
    from app.voices import VoiceResult

    a = unit(rng)
    voicejob.update_series(db, "s" * 32, "wespeaker_r34", VoiceResult([], {5: (a, 10)}), "e" * 32)
    # Le même épisode refait remplace sa contribution, il ne s'ajoute pas.
    voicejob.update_series(db, "s" * 32, "wespeaker_r34", VoiceResult([], {5: (a, 30)}), "e" * 32)
    # Un autre épisode, très bavard : son poids est plafonné.
    voicejob.update_series(db, "s" * 32, "wespeaker_r34", VoiceResult([], {5: (a, 500)}), "f" * 32)
    rows = db.q("SELECT item_id, weight FROM series_memory WHERE kind='voice' ORDER BY item_id")
    assert [(r["item_id"], r["weight"]) for r in rows] == [("e" * 32, 30.0), ("f" * 32, 60.0)]
    mem = voicejob.series_memory(db, "s" * 32, "wespeaker_r34")
    assert np.allclose(mem[5], a, atol=1e-5)
    assert voicejob.series_memory(db, "s" * 32, "campplus_en") == {}


def test_api_voices(client):
    assert client.get(f"/items/{ITEM}/voices").status_code == 401
    assert client.get(f"/items/{ITEM}/voices", headers=AUTH).status_code == 404
    client.post("/jobs", json=job(originalLanguage="en"), headers=AUTH)
    assert client.db.one("SELECT original_language FROM items")["original_language"] == "en"
    segs = [{"start": 1.0, "end": 2.5, "voiceId": 3, "personId": 1, "confidence": 1.0},
            {"start": 3.0, "end": 4.0, "voiceId": 4, "personId": None, "confidence": 0.0, "conflict": True}]
    track = {"track": {"index": 3, "rel": 2, "codec": "eac3", "channels": 6, "layout": "5.1(side)", "language": "eng",
                       "title": "English", "default": False, "original": False, "excluded": False}, "reason": "original"}
    client.db.run("""INSERT INTO voice_results (item_id, etag, model, track_json, segments_json, analyzed_until, complete,
                     version, stats_json, updated) VALUES (?, 'etag-1', 'wespeaker_r34', ?, ?, 240, 1, ?, ?, 0)""",
                  (ITEM, json.dumps(track), json.dumps(segs), VOICE_VERSION, json.dumps({"voicesNamed": 1, "voicesConflict": 1})))
    body = client.get(f"/items/{ITEM}/voices", headers=AUTH).json()
    assert body == {"itemId": ITEM, "etag": "etag-1", "model": "wespeaker_r34", "version": VOICE_VERSION, "complete": True,
                    "analyzedUntil": 240.0,
                    "track": {"index": 3, "language": "eng", "title": "English", "channels": 6, "reason": "original"},
                    "stats": {"voicesNamed": 1, "voicesConflict": 1}, "segments": segs}
    item = client.get(f"/items/{ITEM}", headers=AUTH).json()
    assert item["voices"] == {"complete": True, "voicesNamed": 1, "voicesConflict": 1}
    # Un fichier remplacé fait tout oublier, voix comprises.
    client.post("/jobs", json=job(etag="etag-2"), headers=AUTH)
    assert client.get(f"/items/{ITEM}/voices", headers=AUTH).status_code == 404


def test_langue_d_origine_invalide(client):
    assert client.post("/jobs", json=job(originalLanguage="en; DROP"), headers=AUTH).status_code == 400
    assert client.post("/jobs", json=job(originalLanguage=None), headers=AUTH).status_code == 202


def test_health_dit_les_modeles_de_la_voix(client):
    v = client.get("/health", headers=AUTH).json()["voice"]
    assert v["name"] in ("wespeaker_r34", "campplus_en") and v["vad"]["license"] == "mit"
    assert v["license"] in ("cc-by-4.0", "apache-2.0") and v["ready"] is False
