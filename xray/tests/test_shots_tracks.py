"""Coupes, choix des images, scènes et pistes — sur des images et visages synthétiques."""

import numpy as np

from app.decode import MediaInfo, build_command, vaapi_suits
from app.faces import Face, align, similarity_transform, ARCFACE_TEMPLATE
from app.gpu_guard import sessions_use_hw
from app.shots import MAX_SCENE, ShotInfo, ShotSplitter, boundary_strength, frames_to_sample, group_scenes, pick_indices
from app.tracks import link, summarize
from conftest import noisy, unit

W, H = 64, 36


def nv12(y, u, v, noise=0, rng=None):
    f = np.empty((H * 3 // 2, W), dtype=np.uint8)
    f[:H] = y
    uv = f[H:].reshape(H // 2, W // 2, 2)
    uv[..., 0] = u
    uv[..., 1] = v
    if noise and rng is not None:
        f[:H] = np.clip(f[:H].astype(int) + rng.integers(-noise, noise, (H, W)), 0, 255)
    return f


def test_coupes():
    rng = np.random.default_rng(0)
    sp = ShotSplitter(W, H, 0.25)
    done = []
    frames = [nv12(60, 100, 150, 5, rng)] * 8 + [nv12(200, 140, 90, 5, rng)] * 8 + [nv12(60, 100, 150, 5, rng)] * 3
    for i, f in enumerate(frames):
        s = sp.push(i * 0.25, f)
        if s:
            done.append(s)
    done.append(sp.flush(19 * 0.25))
    assert [(s.start, s.end) for s in done] == [(0.0, 2.0), (2.0, 4.0), (4.0, 4.75)]
    assert all(len(s.frames) > 0 for s in done)


def test_pas_de_coupe_sur_un_mouvement():
    rng = np.random.default_rng(1)
    sp = ShotSplitter(W, H, 0.25)
    base = rng.integers(0, 255, (H, W)).astype(np.uint8)
    for i in range(10):
        f = nv12(0, 120, 130)
        f[:H] = np.roll(base, i * 2, axis=1)  # panoramique : mêmes couleurs, image décalée
        assert sp.push(i * 0.25, f) is None


def test_coupe_dans_un_decor_sombre_d_une_seule_teinte():
    # Champ-contrechamp dans un bureau sombre : mêmes teintes, luminance voisine, mais l'image
    # change de forme. L'ancienne règle n'y voyait rien.
    rng = np.random.default_rng(2)
    a = rng.integers(30, 60, (H, W)).astype(np.uint8)
    b = np.flipud(np.fliplr(a)).copy()
    b[: H // 2] = np.clip(b[: H // 2].astype(int) + 24, 0, 255)
    fa, fb = nv12(0, 120, 128), nv12(0, 121, 129)
    fa[:H], fb[:H] = a, b
    from app.shots import is_cut, signature, hist_distance
    sa, sb = signature(fa, W, H), signature(fb, W, H)
    assert 0.10 <= hist_distance(sa.hist, sb.hist) < 0.30
    assert float(np.abs(sa.thumb - sb.thumb).mean()) < 0.12
    assert is_cut(sa, sb)
    # La même image un peu bruitée (grain, petit mouvement) : pas de coupe.
    fc = fa.copy()
    fc[:H] = np.clip(a.astype(int) + rng.integers(-3, 4, (H, W)), 0, 255)
    assert not is_cut(sa, signature(fc, W, H))


def test_images_par_plan():
    assert frames_to_sample(0.5) == 1
    assert frames_to_sample(1.5) == 2
    assert frames_to_sample(5) == 3
    assert frames_to_sample(30) == 5
    assert frames_to_sample(600) == 6
    assert pick_indices(12, 3) == [2, 6, 10]
    assert pick_indices(1, 3) == [0]


def h(seed):
    """Histogramme d'un décor : la lumière concentrée autour d'une teinte propre à la graine."""
    r = np.random.default_rng(seed)
    out = np.full(64, 0.002, np.float32)
    for a, b in ((0, 32), (32, 48), (48, 64)):
        out[a + int(r.integers(0, b - a))] += 1.0
        out[a:b] /= out[a:b].sum()
    return out


def test_scenes_champ_contrechamp_et_courtes():
    A, B, C = h(1), h(2), h(3)
    shots = [ShotInfo(0, 6, A), ShotInfo(6, 12, B), ShotInfo(12, 18, A), ShotInfo(18, 24, B),
             ShotInfo(24, 30, C), ShotInfo(30, 36, C), ShotInfo(36, 39, h(4)), ShotInfo(39, 45, C)]
    spans = [(s[0].start, s[-1].end) for s in group_scenes(shots)]
    # Sans visage pour les relier, A puis B forment deux scènes de 6 s, trop courtes : elles
    # sont fondues ensemble, et le plan de 3 s glissé au milieu de C rejoint C.
    assert spans == [(0, 24), (24, 45)]


def test_scene_tenue_par_une_personne():
    # Contrechamp dans un décor voisin (à mi-chemin) : relié par la personne qu'on y revoit.
    # Même personne dans un tout autre décor : nouvelle scène.
    near = (h(1) + h(2)) / 2
    shots = [ShotInfo(0, 15, h(1), {7}), ShotInfo(15, 30, near, {7}), ShotInfo(30, 45, h(3), {7})]
    spans = [(s[0].start, s[-1].end) for s in group_scenes(shots)]
    assert spans == [(0, 30), (30, 45)]
    shots[1].clusters = {8}
    assert len(group_scenes(shots[:2] + [ShotInfo(30, 45, h(3), {9})])) == 3


def face(box, emb=None, accepted=True, q=0.8):
    return Face(box=np.array(box, np.float32), score=0.9, kps=np.zeros((5, 2), np.float32), emb=emb,
                quality=q, accepted=accepted and emb is not None)


def test_pistes_par_recouvrement_et_empreinte():
    rng = np.random.default_rng(3)
    a, b = unit(rng), unit(rng)
    frames = [
        [face([10, 10, 60, 60], noisy(rng, a, 0.5)), face([300, 10, 350, 60], noisy(rng, b, 0.5))],
        # A a bougé loin (aucun recouvrement) : relié par l'empreinte. B n'a pas d'empreinte
        # (trop petit ou de profil) : relié par le recouvrement.
        [face([150, 20, 200, 70], noisy(rng, a, 0.5)), face([305, 12, 352, 62], None, accepted=False)],
        [face([155, 22, 205, 72], noisy(rng, a, 0.5))],
    ]
    tracks = link(frames)
    assert sorted(len(t.faces) for t in tracks) == [2, 3]
    summaries = [summarize(t, 3) for t in tracks]
    by_len = {len(t.faces): s for t, s in zip(tracks, summaries)}
    assert by_len[3].presence == 1.0 and by_len[3].faces == 3
    assert float(by_len[3].emb @ a) > 0.8
    assert abs(by_len[2].presence - 2 / 3) < 1e-6


def test_piste_sans_bon_visage_ignoree():
    tr = link([[face([0, 0, 20, 20], None, accepted=False)]])
    assert summarize(tr[0], 1) is None


def test_alignement_retrouve_le_gabarit():
    m = similarity_transform(ARCFACE_TEMPLATE * 2 + 30, ARCFACE_TEMPLATE)
    pts = (np.c_[ARCFACE_TEMPLATE * 2 + 30, np.ones(5)] @ m.T)
    assert np.allclose(pts, ARCFACE_TEMPLATE, atol=1e-3)
    img = np.zeros((400, 400, 3), np.uint8)
    assert align(img, ARCFACE_TEMPLATE * 2 + 30).shape == (112, 112, 3)


def test_decodage():
    info = MediaInfo(2551.0, "hevc", "Main 10", 3840, 2160, "yuv420p10le")
    assert info.out_size(640) == (640, 360)
    assert MediaInfo(1, "h264", "High", 720, 576, "yuv420p", sar=16 / 15).out_size(640) == (640, 480)
    assert vaapi_suits(info)
    assert not vaapi_suits(MediaInfo(1, "av1", "Main", 1920, 1080, "yuv420p10le"))
    assert not vaapi_suits(MediaInfo(1, "h264", "High 10", 1920, 1080, "yuv420p10le"))
    assert not vaapi_suits(MediaInfo(1, "hevc", "Rext", 1920, 1080, "yuv444p"))
    cmd = " ".join(build_command("/media/x.mkv", 120, 120, info, True, 4, 640, 4))
    assert "-hwaccel vaapi" in cmd and "-hwaccel_output_format vaapi" in cmd
    assert "scale_vaapi=w=640:h=360:format=nv12,hwdownload,format=nv12" in cmd
    cmd = " ".join(build_command("/media/x.mkv", 0, 120, info, False, 4, 640, 4))
    assert "vaapi" not in cmd and "-threads 4" in cmd and "tonemapx" not in cmd


def test_hdr_adapte(monkeypatch):
    import app.decode as dec

    monkeypatch.setitem(dec._tonemap_state, "ok", True)
    pq = MediaInfo(7600.0, "hevc", "Main 10", 3840, 1608, "yuv420p10le", transfer="smpte2084")
    assert pq.hdr and MediaInfo(1, "hevc", "Main 10", 1920, 1080, "yuv420p10le", transfer="arib-std-b67").hdr
    assert not MediaInfo(1, "hevc", "Main 10", 1920, 1080, "yuv420p10le", transfer="bt709").hdr
    # La carte réduit en 10 bits, puis le processeur adapte la petite image.
    cmd = " ".join(build_command("/media/x.mkv", 0, 120, pq, True, 4, 640, 4))
    assert "scale_vaapi=w=640:h=268:format=p010,hwdownload,format=p010,tonemapx=" in cmd
    assert cmd.index("scale_vaapi") < cmd.index("tonemapx") and "format=nv12 -f rawvideo" in cmd
    cmd = " ".join(build_command("/media/x.mkv", 0, 120, pq, False, 4, 640, 4))
    assert "scale=640:268:flags=fast_bilinear,format=yuv420p10le,tonemapx=" in cmd
    # Sans tonemapx (autre ffmpeg) : l'ancienne chaîne, plutôt qu'un échec.
    monkeypatch.setitem(dec._tonemap_state, "ok", False)
    assert "tonemapx" not in " ".join(build_command("/media/x.mkv", 0, 120, pq, True, 4, 640, 4))


def test_jellyfin_garde_l_igpu():
    assert not sessions_use_hw([])
    assert not sessions_use_hw([{"TranscodingInfo": {"HardwareAccelerationType": None}}])
    assert not sessions_use_hw([{"TranscodingInfo": {"HardwareAccelerationType": "none"}}])
    assert not sessions_use_hw([{"NowPlayingItem": {}}])
    assert sessions_use_hw([{}, {"TranscodingInfo": {"HardwareAccelerationType": "vaapi"}}])
    assert sessions_use_hw([{"TranscodingInfo": {"HardwareAccelerationType": "qsv"}}])
    assert not sessions_use_hw({"pas": "une liste"})


def _decor_uniforme(n, seconds, people_at=None):
    """Un décor qui ne change presque pas (les urgences de The Pitt) : chaque plan ressemble au
    précédent, et une personne au moins revient sans cesse — rien ne coupe la scène."""
    base = h(11)
    rng = np.random.default_rng(3)
    shots = []
    for i in range(n):
        hist = base + rng.uniform(0, 0.004, 64).astype(np.float32)
        hist[:32] /= hist[:32].sum(); hist[32:48] /= hist[32:48].sum(); hist[48:] /= hist[48:].sum()
        shots.append(ShotInfo(i * seconds, (i + 1) * seconds, hist, (people_at or (lambda i: {1}))(i)))
    return shots


def test_scene_trop_longue_recoupee():
    shots = _decor_uniforme(160, 5.0)  # 800 s d'un seul tenant
    scenes = group_scenes(shots)
    durs = [s[-1].end - s[0].start for s in scenes]
    assert max(durs) <= MAX_SCENE and min(durs) >= 30.0
    assert sum(durs) == 800.0 and len(scenes) >= 5
    # Toujours contiguës, aucun plan perdu ni dupliqué.
    flat = [x for s in scenes for x in s]
    assert flat == shots


def test_recoupe_a_la_frontiere_la_plus_faible():
    shots = _decor_uniforme(50, 5.0)  # 250 s
    # Le plan 21 (105 s) change un peu de couleurs : c'est là qu'on coupe.
    shots[21].hist = (shots[21].hist + h(12)) / 2
    shots[22].hist = shots[21].hist.copy()
    scenes = group_scenes(shots)
    assert [(s[0].start, s[-1].end) for s in scenes] == [(0.0, 105.0), (105.0, 250.0)]


def test_recoupe_quand_les_personnes_changent():
    # Mêmes couleurs partout, mais les personnes de la première minute et demie ne sont plus là
    # ensuite : la frontière se met à ce changement.
    shots = _decor_uniforme(50, 5.0, lambda i: {1, 2} if i < 18 else {3})
    for s in shots[17:19]:
        s.clusters = s.clusters | {1}  # la scène se tient encore par une personne commune…
    shots[18].clusters = {3}
    assert boundary_strength(shots, 18) < boundary_strength(shots, 30)
    scenes = group_scenes(shots)
    assert [(s[0].start, s[-1].end) for s in scenes] == [(0.0, 90.0), (90.0, 250.0)]


def test_scene_courte_toujours_fondue_et_scene_normale_intacte():
    # Une scène de 150 s n'est pas touchée ; la règle des 10 s tient toujours.
    shots = _decor_uniforme(30, 5.0)
    assert [(s[0].start, s[-1].end) for s in group_scenes(shots)] == [(0.0, 150.0)]


def _rafale(people_burst, people_after):
    """Un vestiaire de 60 s (A, B : deux personnes), puis une conférence de presse montée en plans de 2 s
    aux couleurs changeantes (chacun une scène courte), puis 30 s dans un troisième décor."""
    A, B = h(1), (h(1) * 3 + h(2)) / 4
    shots = [ShotInfo(i * 6.0, (i + 1) * 6.0, A if i % 2 == 0 else B, {1} if i % 2 == 0 else {2}) for i in range(10)]
    t = 60.0
    for k in range(12):
        shots.append(ShotInfo(t, t + 2.0, h(40 + k), people_burst(k)))
        t += 2.0
    shots += [ShotInfo(t, t + 15.0, h(9), people_after), ShotInfo(t + 15.0, t + 30.0, h(9), people_after)]
    return shots


def test_rafale_d_un_autre_lieu_gardee():
    # Ted Lasso S01E09 : la conférence de presse (d'autres personnes, plans courts sans lien de couleur)
    # n'est plus fondue morceau par morceau dans le vestiaire.
    spans = [(s[0].start, s[-1].end) for s in group_scenes(_rafale(lambda k: {10 + k % 3}, {20}))]
    assert spans == [(0.0, 60.0), (60.0, 84.0), (84.0, 114.0)]


def test_rafale_des_memes_personnes_fondue():
    # Les mêmes personnes que le vestiaire (un champ-contrechamp aux couleurs qui sautent) : comme avant,
    # fondue dans ses voisines. Sans visage non plus : rien ne dit que le lieu a changé.
    for people in (lambda k: {1 + k % 2}, lambda k: set()):
        spans = [(s[0].start, s[-1].end) for s in group_scenes(_rafale(people, {20}))]
        assert (60.0, 84.0) not in spans and spans[0][0] == 0.0 and spans[-1][1] == 114.0
