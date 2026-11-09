"""Décodage : ffmpeg arrêté par nous n'est pas un échec ; images non référencées sautées aussi
sur l'iGPU."""

import sys

import pytest

from app import decode
from app.decode import DecodeStats, MediaInfo, build_command, read_frames

INFO = MediaInfo(duration=600, codec="hevc", profile="Main", width=64, height=36, pix_fmt="yuv420p")


def _fake_ffmpeg(tmp_path, body: str):
    """Un « ffmpeg » qui écrit des images NV12 64×36 sur sa sortie (`body` en Python)."""
    p = tmp_path / "ffmpeg"
    p.write_text(f"#!{sys.executable}\nimport sys, os\nframe = bytes(64 * 36 * 3 // 2)\nout = sys.stdout.buffer\n{body}\n")
    p.chmod(0o755)
    return str(p)


def _read(monkeypatch, ffmpeg, length=1.0):
    monkeypatch.setattr(decode.settings, "ffmpeg", ffmpeg)
    stats = DecodeStats("cpu")
    frames = list(read_frames("/media/x.mkv", 100.0, length, INFO, False, stats, fps=4, width=64))
    return frames, stats


def test_ffmpeg_arrete_par_nous_n_est_pas_un_echec(tmp_path, monkeypatch):
    # Le filtre `fps` rend une image de plus que la plage (ici : sans fin) ; on arrête ffmpeg, il
    # sort tué (−9). Avant : compté comme un échec — reprise sur le processeur, puis ordre en échec.
    ff = _fake_ffmpeg(tmp_path, "while True:\n    out.write(frame); out.flush()")
    frames, stats = _read(monkeypatch, ff)
    assert len(frames) == 4 and [round(t, 2) for t, _ in frames] == [100.0, 100.25, 100.5, 100.75]
    assert stats.stopped and stats.returncode not in (0, None)
    assert not stats.failed


def test_ffmpeg_en_erreur_reste_un_echec(tmp_path, monkeypatch):
    ff = _fake_ffmpeg(tmp_path, "out.write(frame); out.flush(); sys.stderr.write('decode error\\n'); sys.exit(1)")
    frames, stats = _read(monkeypatch, ff)
    assert len(frames) == 1 and not stats.stopped
    assert stats.returncode == 1 and stats.failed
    ff = _fake_ffmpeg(tmp_path, "sys.exit(0)")
    frames, stats = _read(monkeypatch, ff)
    assert frames == [] and stats.failed  # aucune image


def test_ffmpeg_qui_finit_de_lui_meme(tmp_path, monkeypatch):
    ff = _fake_ffmpeg(tmp_path, "for _ in range(3):\n    out.write(frame)\nout.flush()")
    frames, stats = _read(monkeypatch, ff)
    assert len(frames) == 3 and stats.returncode == 0 and not stats.stopped and not stats.failed


def test_images_non_referencees_sautees_sur_l_igpu(monkeypatch):
    info = MediaInfo(duration=100, codec="hevc", profile="Main 10", width=3840, height=2160, pix_fmt="yuv420p10le")
    for vaapi in (True, False):
        cmd = build_command("/media/x.mkv", 0, 120, info, vaapi, 4, 640, 6)
        i = cmd.index("-skip_frame")
        assert cmd[i + 1] == "noref" and i < cmd.index("-i")
    monkeypatch.setattr(decode.settings, "vaapi_noref", False)
    assert "-skip_frame" not in build_command("/media/x.mkv", 0, 120, info, True, 4, 640, 6)
    # Sur le processeur, toujours (c'était déjà le cas).
    assert "-skip_frame" in build_command("/media/x.mkv", 0, 120, info, False, 4, 640, 6)


@pytest.mark.parametrize("raw,expected", [("", True), ("1", True), ("0", False), ("no", False), ("off", False)])
def test_reglage_noref(monkeypatch, raw, expected):
    from app.config import Settings

    monkeypatch.setenv("XRAY_VAAPI_NOREF", raw)
    assert Settings().vaapi_noref is expected
