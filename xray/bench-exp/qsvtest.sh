# Transcodage façon Jellyfin (VA-API : décodage HEVC, réduction, encodage H.264) — images/s
F="/media/tv/MacGyver (2016)/MacGyver (2016) - S01E06 - Wrench.mkv"
/usr/lib/jellyfin-ffmpeg/ffmpeg -hide_banner -v error -stats -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 -hwaccel_output_format vaapi -ss 600 -t 60 -i "$F" -map 0:v:0 -vf scale_vaapi=w=1920:h=1080:format=nv12 -c:v h264_vaapi -b:v 8M -f null - 2>&1 | tr '\r' '\n' | grep -o "fps=[ 0-9.]*" | tail -1
