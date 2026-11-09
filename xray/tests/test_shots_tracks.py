"""Coupes, choix des images, scènes et pistes — sur des images et visages synthétiques."""

import numpy as np

from app.decode import MediaInfo, build_command, vaapi_suits
from app.faces import Face, align, similarity_transform, ARCFACE_TEMPLATE
from app.gpu_guard import sessions_use_hw
from app.shots import ShotInfo, ShotSplitter, frames_to_sample, group_scenes, pick_indices
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
    assert "vaapi" not in cmd and "-threads 4" in cmd


def test_jellyfin_garde_l_igpu():
    assert not sessions_use_hw([])
    assert not sessions_use_hw([{"TranscodingInfo": {"HardwareAccelerationType": None}}])
    assert not sessions_use_hw([{"TranscodingInfo": {"HardwareAccelerationType": "none"}}])
    assert not sessions_use_hw([{"NowPlayingItem": {}}])
    assert sessions_use_hw([{}, {"TranscodingInfo": {"HardwareAccelerationType": "vaapi"}}])
    assert sessions_use_hw([{"TranscodingInfo": {"HardwareAccelerationType": "qsv"}}])
    assert not sessions_use_hw({"pas": "une liste"})
