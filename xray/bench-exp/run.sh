#!/bin/bash
# usage: run.sh IMAGE TAG [ITEMS...]  — conteneur jetable xray-exp-TAG, volume xe-TAG ; XE_ENV = options docker en plus
X=/tmp/claude-1000/-opt-stacks-cine-app/9bf72156-c396-4d6d-80d5-0d784ed2dcfd/scratchpad/xexp
IMG=$1; TAG=$2; shift 2; N=xray-exp-$TAG; V=xe-$TAG; O=$X/$TAG; mkdir -p $O
T=${XE_THREADS:-10}; C=${XE_CPUS:-10}
docker rm -f $N >/dev/null 2>&1 || true
docker volume rm $V >/dev/null 2>&1 || true
docker volume create $V >/dev/null
docker run --rm -v $X/models:/src:ro -v $V:/data --user 0 --entrypoint sh $IMG -c 'mkdir -p /data/models && cp -a /src/. /data/models/ && chown -R 1000:1000 /data'
docker run -d --name $N --network media_net --env-file /opt/stacks/laterna-xray/.env \
  -e XRAY_MODEL=${XE_MODEL:-buffalo_l} -e XRAY_THREADS=$T -e HOME=/data ${XE_ENV} --user 1000:1000 \
  -v /mnt/media/video:/media:ro -v $V:/data --device /dev/dri:/dev/dri --group-add 993 \
  --cpus $C --memory 4g $IMG >/dev/null
export XRAY_API_KEY=$(grep '^XRAY_API_KEY=' /opt/stacks/laterna-xray/.env | cut -d= -f2-)
for i in $(seq 120); do
  docker exec $N python -c "import os,sys,json,urllib.request as u;r=u.Request('http://127.0.0.1:8000/health',headers={'Authorization':'Bearer '+os.environ['XRAY_API_KEY']});sys.exit(0 if json.load(u.urlopen(r))['model']['ready'] else 1)" 2>/dev/null && break
  timeout 5 tail -f /dev/null || true
done
ALL="mg5:28b7a5abbe3bb3e1fa922e652a575672:ep:67133:1:5 mg6:693f49c6fd61dbcb64eeabfb716da54b:ep:67133:1:6 pitt101:2508800bef9fd913e38cae89c6ebcba0:ep:250307:1:1 pitt201:21226eb69fa52770b272a3df1c139d80:ep:250307:2:1 bullet:f63dd2bd16b9ef5a8eaf96ddb49c967f:movie:718930"
WANT="${*:-mg5 mg6 pitt101 pitt201 bullet}"
for x in $ALL; do n=${x%%:*}; r=${x#*:}; it=${r%%:*}; ref=${r#*:}
  case " $WANT " in *" $n "*) ;; *) continue;; esac
  echo "start $n $(date -Is) $(cat /proc/loadavg)" >> $O/timing
  if [ -s $X/cast/$n.order.json ]; then
    docker exec -i -e XRAY_API_KEY -e XB_HOST=$N -e XB_ITEM=$it -e XB_CAST=$(base64 -w0 $X/cast/$n.order.json) cine-app node --input-type=module - < $X/order2.mjs > $O/$n.order.json
  else
    docker exec -i -e XRAY_API_KEY -e XB_HOST=$N -e XB_ITEM=$it -e XB_REF=$ref cine-app node --input-type=module - < $X/order.mjs > $O/$n.order.json
  fi
  docker exec -i -e XRAY_API_KEY -e XB_HOST=$N -e XB_ITEM=$it cine-app node --input-type=module - < $X/poll.mjs > $O/$n.poll.log
  echo "end $n $(date -Is) $(cat /proc/loadavg)" >> $O/timing
done
docker logs $N > $O/svc.log 2>&1
docker exec $N python -c "import sqlite3;s=sqlite3.connect('file:/data/xray.db?mode=ro',uri=True);d=sqlite3.connect('/tmp/snap.db');s.backup(d);d.close()"
docker exec $N cat /tmp/snap.db > $O/snap.db
[ -n "$XE_KEEP" ] || { docker rm -f $N >/dev/null; docker volume rm $V >/dev/null; }
echo "DONE $TAG $(date -Is)" >> $O/timing
