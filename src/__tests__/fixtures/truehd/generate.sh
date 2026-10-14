#!/bin/sh
# Rebuilds the synthetic mono and stereo TrueHD fixtures read by webcodecs-truehd.test.ts, so nobody
# has to take them on trust: half a second of sine tones, raw access units (`-f truehd`), encoded by
# FFmpeg's own TrueHD encoder. The repository is public: no excerpt of a real film belongs in it.
#
#   docker run --rm -v "$PWD/src/__tests__/fixtures/truehd":/o --entrypoint sh linuxserver/ffmpeg \
#     /o/generate.sh /o                                                  # FFmpeg 9.0, 14/10/2026
#
# Why mono and stereo only: up to 8.1 the encoder wrote multichannel streams its own decoder refused
# (6.1 to 8.1, tried on 21/09/2026); its mono and stereo output is read by FFmpeg 9.0's decoder and
# by ours. Both are one-substream streams — exactly the case FFmpeg 7.1.2's mlpdec left with an
# empty mask when the caller named no layout, which our module never does (fixed in 7.1.3).
#
# Tones: mono 440 Hz at 1/16 (RMS −27.09 dBFS); stereo L 440 Hz at 1/16, R 1 kHz at 1/80
# (−41.07 dBFS), so a swapped pair shows in the levels.
set -e
cd "${1:-/o}"
ffmpeg -hide_banner -loglevel error -y -fflags +bitexact -flags:a +bitexact \
  -f lavfi -i "sine=f=440:r=48000:d=0.5,volume=0.5" -c:a truehd -strict -2 -f truehd mono.thd
ffmpeg -hide_banner -loglevel error -y -fflags +bitexact -flags:a +bitexact \
  -f lavfi -i "sine=f=440:r=48000:d=0.5,volume=0.5" -f lavfi -i "sine=f=1000:r=48000:d=0.5,volume=0.1" \
  -filter_complex "[0][1]join=inputs=2:channel_layout=stereo" -c:a truehd -strict -2 -f truehd stereo.thd
