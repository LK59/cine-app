# usage: sheet.sh FICHIER SORTIE.jpg T1 T2 ... — une rangée par instant donné : 6 images de t-12 s à t+12 s (t = frontière)
F="$1"; O="$2"; shift 2; i=0; rows=""
for t in "$@"; do j=0
  for d in -12 -6 -2 2 6 12; do tt=$(awk "BEGIN{print $t + $d}"); /usr/lib/jellyfin-ffmpeg/ffmpeg -v error -ss $tt -i "$F" -frames:v 1 -vf "scale=240:-2,tonemapx=tonemap=bt2390:t=bt709:m=bt709:p=bt709:format=yuv420p,drawtext=text='$tt':x=4:y=4:fontsize=16:fontcolor=yellow" -y /tmp/f_${i}_$j.png 2>/dev/null || /usr/lib/jellyfin-ffmpeg/ffmpeg -v error -ss $tt -i "$F" -frames:v 1 -vf "scale=240:-2,drawtext=text='$tt':x=4:y=4:fontsize=16:fontcolor=yellow" -y /tmp/f_${i}_$j.png; j=$((j+1)); done
  /usr/lib/jellyfin-ffmpeg/ffmpeg -v error -i /tmp/f_${i}_0.png -i /tmp/f_${i}_1.png -i /tmp/f_${i}_2.png -i /tmp/f_${i}_3.png -i /tmp/f_${i}_4.png -i /tmp/f_${i}_5.png -filter_complex hstack=inputs=6 -y /tmp/row_$i.png
  rows="$rows -i /tmp/row_$i.png"; i=$((i+1)); done
/usr/lib/jellyfin-ffmpeg/ffmpeg -v error $rows -filter_complex vstack=inputs=$i -y "$O"
