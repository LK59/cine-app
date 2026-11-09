"""La piste son de « qui parle » : laquelle, et comment la lire sans relire le fichier.

**Laquelle.** La version originale quand elle existe — la langue d'origine du titre (`originalLanguage`
de l'ordre, donnée par Laterna d'après TMDB), sinon une piste que son titre dit originale (« VO »,
« original ») ou que le conteneur marque comme telle —, sinon la piste par défaut, sinon la première.
Jamais une piste de commentaire ni d'audiodescription (une voix de narrateur sur tout le film). La piste
retenue et la raison sont gardées avec l'ordre et rendues par `/voices` (`track`). `XRAY_VOICE_TRACK=
default` prend la piste par défaut d'office (voir README, « Qui parle », pour ce que mesure le banc).

**Comment.** Seize kilohertz, mono, entiers 16 bits — ce qu'attendent Silero et les réseaux d'empreinte.
Le canal central seul quand la piste en a un (5.1, 7.1…) : c'est là que sont les dialogues, sans la
musique ni les effets des autres canaux (`pan=mono|c0=FC`) ; sinon un mélange mono (`-ac 1`). Pendant
l'analyse des visages, c'est **une sortie de plus du même ffmpeg** (`video_and_audio_args`) : le fichier
n'est lu qu'une fois, le son part dans un second tuyau (`pipe:<fd>`). Une analyse faite avant l'étape
des voix est complétée par une lecture du son seul (`read_audio`), bien moins chère que l'image.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import threading
from dataclasses import asdict, dataclass

import numpy as np

from .config import settings

log = logging.getLogger("xray.audio")

SR = 16000

# ISO 639-1 (TMDB) → codes ISO 639-2 que portent les conteneurs. Au-delà, les deux premières lettres.
ISO1_TO_2 = {
    "en": {"eng"}, "fr": {"fre", "fra"}, "es": {"spa"}, "de": {"ger", "deu"}, "it": {"ita"},
    "ja": {"jpn"}, "ko": {"kor"}, "zh": {"chi", "zho", "cmn", "yue"}, "cn": {"chi", "zho", "yue"},
    "pt": {"por"}, "ru": {"rus"}, "nl": {"dut", "nld"}, "sv": {"swe"}, "da": {"dan"},
    "no": {"nor", "nob", "nno"}, "nb": {"nor", "nob"}, "fi": {"fin"}, "pl": {"pol"}, "tr": {"tur"},
    "hi": {"hin"}, "ar": {"ara"}, "he": {"heb"}, "cs": {"cze", "ces"}, "el": {"gre", "ell"},
    "hu": {"hun"}, "is": {"ice", "isl"}, "th": {"tha"}, "fa": {"per", "fas"}, "ro": {"rum", "ron"},
    "uk": {"ukr"}, "id": {"ind"}, "ta": {"tam"}, "te": {"tel"}, "ga": {"gle"}, "cy": {"wel", "cym"},
}
# Ce qui n'est pas la parole des personnages.
EXCLUDED_WORDS = ("comment", "audiodescr", "audio descr", "audio-descr", "description", "malvoyant",
                  "visually impaired", "narrat", "karaok", "isolated", "music only", "musique seule")
ORIGINAL_WORDS = ("vo", "v.o", "original", "vost", "version originale")


@dataclass
class AudioTrack:
    index: int            # rang de la piste dans le fichier (`0:N`)
    rel: int              # rang parmi les pistes son (`0:a:N`)
    codec: str
    channels: int
    layout: str
    language: str
    title: str
    default: bool
    original: bool
    excluded: bool

    def as_dict(self) -> dict:
        return asdict(self)


def _words(title: str) -> list[str]:
    out, cur = [], ""
    for ch in title.lower():
        if ch.isalnum() or ch == ".":
            cur += ch
        else:
            if cur:
                out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out


def parse_tracks(ffprobe_json: dict) -> list[AudioTrack]:
    out = []
    for rel, s in enumerate(s for s in ffprobe_json.get("streams") or [] if s.get("codec_type", "audio") == "audio"):
        tags = {k.lower(): v for k, v in (s.get("tags") or {}).items()}
        disp = s.get("disposition") or {}
        title = str(tags.get("title") or "")
        low = title.lower()
        excluded = bool(disp.get("comment") or disp.get("visual_impaired") or disp.get("descriptions")) or any(
            w in low for w in EXCLUDED_WORDS) or "ad" in _words(title)
        words = _words(title)
        original = bool(disp.get("original")) or any(w in words for w in ("vo", "v.o", "vost", "vostfr")) or "original" in low
        out.append(AudioTrack(
            index=int(s.get("index", rel)), rel=rel, codec=str(s.get("codec_name") or ""),
            channels=int(s.get("channels") or 0), layout=str(s.get("channel_layout") or ""),
            language=str(tags.get("language") or "").lower(), title=title,
            default=bool(disp.get("default")), original=original, excluded=excluded,
        ))
    return out


def probe_tracks(path: str) -> list[AudioTrack]:
    out = subprocess.run(
        [settings.ffprobe, "-v", "error", "-select_streams", "a", "-show_entries",
         "stream=index,codec_name,codec_type,channels,channel_layout:stream_tags=language,title:stream_disposition",
         "-of", "json", path],
        capture_output=True, text=True, timeout=60,
    )
    if out.returncode != 0:
        raise RuntimeError(f"ffprobe (son) : {out.stderr.strip()[-300:]}")
    return parse_tracks(json.loads(out.stdout or "{}"))


def language_matches(track_lang: str, original: str) -> bool:
    t, o = track_lang.strip().lower(), original.strip().lower()
    if not t or not o or t in ("und", "mul", "zxx"):
        return False
    if t == o:
        return True
    codes = ISO1_TO_2.get(o)
    if codes is not None:
        return t in codes
    return len(o) == 2 and t[:2] == o


def choose_track(tracks: list[AudioTrack], original_language: str | None, mode: str = "original") -> tuple[AudioTrack | None, str]:
    """(piste, raison) — raison : `original` (langue d'origine), `vo` (titre ou marque), `default`, `first`."""
    usable = [t for t in tracks if not t.excluded and t.channels > 0] or [t for t in tracks if t.channels > 0]
    if not usable:
        return None, "none"

    def best(cands: list[AudioTrack]) -> AudioTrack:
        # À langue égale : la piste marquée originale, puis celle par défaut, puis celle qui a un canal central.
        return sorted(cands, key=lambda t: (not t.original, not t.default, not has_centre(t), t.rel))[0]

    if mode != "default":
        if original_language:
            match = [t for t in usable if language_matches(t.language, original_language)]
            if match:
                return best(match), "original"
        marked = [t for t in usable if t.original]
        if marked:
            return best(marked), "vo"
    default = [t for t in usable if t.default]
    if default:
        return default[0], "default"
    return usable[0], "first"


CENTRE_LAYOUTS = ("3.0", "3.1", "4.0", "4.1", "5.0", "5.1", "6.0", "6.1", "7.0", "7.1", "hexagonal", "octagonal")


def has_centre(t: AudioTrack) -> bool:
    lay = t.layout.lower()
    return any(lay.startswith(p) for p in CENTRE_LAYOUTS) or (not lay and t.channels in (6, 8))


def channel_use(t: AudioTrack) -> str:
    """Ce qui est écouté de la piste : `centre` (canal central déclaré), `centre_c2` (troisième canal d'une
    piste 5.1/7.1 sans disposition déclarée) ou `downmix` (mélange mono). Même règle qu'`audio_filter`."""
    if has_centre(t) and t.layout:
        return "centre"
    if t.channels >= 6 and not t.layout:
        return "centre_c2"
    return "downmix"


def describe(t: AudioTrack) -> dict:
    """La piste pour le journal et le rapport : rang, langue, codec, canaux, disposition, ce qui est écouté."""
    return {"index": t.index, "language": t.language or None, "codec": t.codec, "channels": t.channels,
            "layout": t.layout or None, "title": t.title or None, "default": t.default, "original": t.original,
            "channelUse": channel_use(t), "filter": " ".join(audio_filter(t))}


def audio_filter(t: AudioTrack) -> list[str]:
    """Le canal central quand il y en a un, sinon un mélange mono ; 16 kHz."""
    if has_centre(t) and t.layout:
        return ["-af", "pan=mono|c0=FC", "-ar", str(SR)]
    if t.channels >= 6 and not t.layout:
        # Sans disposition déclarée, ffmpeg suppose la disposition par défaut du nombre de canaux (5.1, 7.1),
        # dont le troisième canal est le centre.
        return ["-af", "pan=mono|c0=c2", "-ar", str(SR)]
    return ["-ac", "1", "-ar", str(SR)]


def audio_output_args(t: AudioTrack, target: str) -> list[str]:
    return ["-map", f"0:a:{t.rel}", "-vn", "-sn", "-dn", *audio_filter(t), "-f", "s16le", "-acodec", "pcm_s16le", target]


def read_audio(path: str, start: float, length: float, t: AudioTrack, cancel: threading.Event | None = None) -> np.ndarray:
    """Le son seul d'une plage (analyse faite avant l'étape des voix) : int16, 16 kHz, mono."""
    cmd = [settings.ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-threads", "1",
           "-ss", f"{start:.3f}", "-t", f"{length:.3f}", "-i", path, *audio_output_args(t, "pipe:1")]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    sink = PcmSink(proc.stdout)  # type: ignore[arg-type]
    err = proc.stderr.read() if proc.stderr else b""
    sink.join()
    proc.wait()
    if cancel is not None and cancel.is_set():
        return np.zeros(0, dtype=np.int16)
    if proc.returncode != 0 and not len(sink.data):
        raise RuntimeError(f"ffmpeg (son) code {proc.returncode} : {err.decode('utf-8', 'replace')[-300:]}")
    return sink.pcm()


class PcmSink:
    """Vide un tuyau de son dans un fil à lui : ffmpeg écrit ses deux sorties ensemble, et un tuyau
    plein qu'on ne lit pas l'arrêterait — l'image avec."""

    def __init__(self, stream):
        self.data = bytearray()
        self._stream = stream
        self._t = threading.Thread(target=self._run, daemon=True)
        self._t.start()

    def _run(self) -> None:
        try:
            while True:
                b = self._stream.read(1 << 16)
                if not b:
                    break
                self.data += b
        except (OSError, ValueError):
            pass
        finally:
            try:
                self._stream.close()
            except OSError:
                pass

    def join(self, timeout: float | None = 10.0) -> None:
        self._t.join(timeout)

    def pcm(self) -> np.ndarray:
        n = len(self.data) // 2
        return np.frombuffer(bytes(self.data[: n * 2]), dtype=np.int16)


def open_pipe() -> tuple[int, int]:
    r, w = os.pipe()
    return r, w
