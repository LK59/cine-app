#!/bin/sh
# Rebuilds the synthetic AC-3, E-AC3 and DTS fixtures read by webcodecs-ac3dts-worker.test.ts (essai
# demux-son, 19/11/2026): half a second of tones, raw frames, encoded by FFmpeg's own encoders. The
# repository is public: no excerpt of a real film belongs in it.
#
#   sh src/__tests__/fixtures/ac3dts/generate.sh src/__tests__/fixtures/ac3dts      # FFmpeg 8.0.1, 19/11/2026
#
# Stereo, L 440 Hz at 1/16, R 1 kHz at 1/80, so a swapped pair shows in the levels.
set -e
cd "${1:-.}"
for spec in "ac3 ac3 ac3" "eac3 eac3 eac3" "dca dts dts"; do
  set -- $spec
  ffmpeg -hide_banner -loglevel error -y -fflags +bitexact -flags:a +bitexact \
    -f lavfi -i "sine=f=440:r=48000:d=0.5,volume=0.5" -f lavfi -i "sine=f=1000:r=48000:d=0.5,volume=0.1" \
    -filter_complex "[0][1]join=inputs=2:channel_layout=stereo" -c:a "$1" -strict -2 -f "$2" "stereo.$3"
done
