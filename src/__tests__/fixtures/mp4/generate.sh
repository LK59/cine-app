#!/bin/sh
# Rebuilds the synthetic MP4 fixtures read by webcodecs-mp4Demux.test.ts, so nobody has to take
# them on trust. Every picture and every sound comes from ffmpeg's own generators (testsrc, sine):
# the repository is public, and no excerpt of a real film belongs in it.
#
#   docker run --rm -v "$PWD/src/__tests__/fixtures/mp4":/o --entrypoint sh linuxserver/ffmpeg /o/generate.sh
#
# The tests hard-code what ffprobe reports for these exact files (timestamps, sizes, offsets). An
# encoder upgrade may change the bytes; if it does, re-run this, re-probe, and update the expected
# values — never the other way round. The MP4s come out byte-identical run after run; the Matroska
# twins do not (the muxer writes fresh UIDs), which is harmless: only their codec records are read.
set -e
cd /o
F="ffmpeg -hide_banner -loglevel error -y -fflags +bitexact -flags:v +bitexact -flags:a +bitexact"
V="-f lavfi -i testsrc=size=64x48:rate=24:duration=1"
A="-f lavfi -i sine=frequency=440:sample_rate=48000:duration=1"
X264="-c:v libx264 -preset ultrafast -tune zerolatency -x264-params keyint=12:min-keyint=12"

# (a) H.264 + AAC, index at the front. x264's defaults with B-frames: an edit list moves the
#     presentation back to zero (elst media_time > 0), the ordinary shape of a web MP4.
$F $V $A -c:v libx264 -preset ultrafast -x264-params keyint=12:min-keyint=12:bframes=2 \
  -c:a aac -b:a 24k -movflags +faststart -metadata:s:a:0 language=eng -pix_fmt yuv420p a-faststart.mp4

# (b) The same, index at the end — the reader must find `moov` after `mdat`.
$F $V $A $X264 -c:a aac -b:a 24k -pix_fmt yuv420p b-moov-end.mp4

# (c) HEVC + AAC (eng) + AC-3 (fre) + two mov_text tracks, one of them with a gap between lines.
cat > /tmp/fr.srt <<'SRT'
1
00:00:00,100 --> 00:00:00,400
Bonjour

2
00:00:00,600 --> 00:00:00,900
Au revoir
SRT
cat > /tmp/en.srt <<'SRT'
1
00:00:00,200 --> 00:00:00,700
Hello
SRT
$F $V $A -f lavfi -i sine=frequency=660:sample_rate=48000:duration=1 -i /tmp/fr.srt -i /tmp/en.srt \
  -map 0:v -map 1:a -map 2:a -map 3 -map 4 \
  -c:v libx265 -preset ultrafast -x265-params keyint=12:min-keyint=12:log-level=error -tag:v hvc1 \
  -c:a:0 aac -b:a:0 24k -c:a:1 ac3 -b:a:1 64k -c:s mov_text \
  -metadata:s:a:0 language=eng -metadata:s:a:1 language=fre \
  -metadata:s:s:0 language=fre -metadata:s:s:1 language=eng \
  -pix_fmt yuv420p -movflags +faststart c-hevc-multi.mp4
# Its Matroska twin: the same streams copied (the text re-wrapped: Matroska has no mov_text).
# The codec records must come out identical.
$F -i c-hevc-multi.mp4 -map 0 -c copy -c:s srt c-hevc-multi.mkv

# (d) Fragmented: moof/mdat pairs, nothing in the sample tables. Refused, by design.
$F $V $X264 -an -pix_fmt yuv420p -movflags frag_keyframe+empty_moov d-fragmented.mp4

# (e) B-frames with signed composition offsets (ctts version 1), no edit-list shift needed.
$F $V -c:v libx264 -preset ultrafast -x264-params keyint=12:min-keyint=12:bframes=3 -an \
  -pix_fmt yuv420p -movflags +negative_cts_offsets+faststart e-bframes-ctts1.mp4

# (f) A one-picture JPEG track placed *before* the film's own video track — what a cover stored
#     as a track looks like. The main picture must still be the H.264 one.
$F -f lavfi -i color=c=red:size=32x32:duration=0.04:rate=25 -frames:v 1 -c:v mjpeg /tmp/cover.mp4
$F -i /tmp/cover.mp4 $V $A -map 0:v -map 1:v -map 2:a -c:v:0 copy -c:v:1 libx264 -preset ultrafast \
  -pix_fmt:v:1 yuv420p -c:a aac -b:a 24k -movflags +faststart f-cover-track.mp4

# (g) Audio codecs whose MP4 record is not Matroska's: Opus (dOps ↔ OpusHead), FLAC (dfLa ↔ fLaC),
#     E-AC-3. And its Matroska twin, for the same comparison as (c).
$F $V $A -map 0:v -map 1:a -map 1:a -map 1:a -c:v libx264 -preset ultrafast \
  -c:a:0 libopus -b:a:0 16k -c:a:1 flac -ar:a:1 8000 -sample_fmt:a:1 s16 -c:a:2 eac3 -b:a:2 32k \
  -pix_fmt yuv420p -movflags +faststart g-audio-codecs.mp4
$F -i g-audio-codecs.mp4 -map 0 -c copy g-audio-codecs.mkv

# What ffprobe reads in each file, packet by packet — the reference the demuxer is held to:
# stream, pts, dts, duration (in the stream's time base), size, file offset, flags.
for f in a-faststart b-moov-end c-hevc-multi e-bframes-ctts1 f-cover-track g-audio-codecs; do
  ffprobe -v error -show_entries packet=stream_index,pts,dts,duration,size,pos,flags -of csv=p=0 "$f.mp4" > "$f.packets.csv"
done

ls -l /o
