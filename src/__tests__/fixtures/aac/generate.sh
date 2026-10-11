#!/bin/sh
# Rebuilds the synthetic AAC-with-PCE fixtures read by aacWasm-decode.test.ts, so nobody has to take
# them on trust. Six sine tones, one per channel, encoded by ffmpeg's own AAC encoder forced to
# describe an ordinary 5.1 with a program config element (`-aac_pce 1`). The repository is public:
# no excerpt of a real film belongs in it.
#
#   sh src/__tests__/fixtures/aac/generate.sh src/__tests__/fixtures/aac pce-51-lavc62.mkv   # FFmpeg 8.0
#   docker run --rm -v "$PWD/src/__tests__/fixtures/aac":/o --entrypoint sh linuxserver/ffmpeg \
#     /o/generate.sh /o pce-51-lavc63.mkv                                                   # FFmpeg 8.1+
#
# The encoder's version decides the PCE, and the two are kept on purpose:
# - FFmpeg 8.0 (libavcodec 62) writes front [pair, mono], side [mono], back [pair], no LFE element —
#   byte for byte the PCE of « Elle s'appelle Ruby », the shape whose decoded order was measured
#   (`MEASURED_DECODED_ORDERS`, "PM/M/P/0"), delivered as a whole 5.1;
# - FFmpeg 8.1 (libavcodec 63) writes another PCE for the same 5.1, a shape never measured, which
#   the player keeps to L R C (the rule for any unmeasured layout).
#
# Tones: L 440 Hz, R 660 Hz, C 880 Hz, LFE 55 Hz, Ls 1320 Hz, Rs 1760 Hz. The test finds each one
# back on its rank after decoding, which is what proves the channel order; an encoder upgrade may
# change the bytes, never which tone must sit where.
set -e
cd "${1:-/o}"
ffmpeg -hide_banner -loglevel error -y -fflags +bitexact -flags:a +bitexact \
  -f lavfi -i sine=frequency=440:sample_rate=48000:duration=0.5 \
  -f lavfi -i sine=frequency=660:sample_rate=48000:duration=0.5 \
  -f lavfi -i sine=frequency=880:sample_rate=48000:duration=0.5 \
  -f lavfi -i sine=frequency=55:sample_rate=48000:duration=0.5 \
  -f lavfi -i sine=frequency=1320:sample_rate=48000:duration=0.5 \
  -f lavfi -i sine=frequency=1760:sample_rate=48000:duration=0.5 \
  -filter_complex "[0][1][2][3][4][5]join=inputs=6:channel_layout=5.1(side):map=0.0-FL|1.0-FR|2.0-FC|3.0-LFE|4.0-SL|5.0-SR[a]" \
  -map "[a]" -c:a aac -aac_pce 1 -b:a 96k -map_metadata -1 -f matroska "${2:-pce-51.mkv}"
ls -l
