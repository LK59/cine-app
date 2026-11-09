#!/bin/bash
X=/tmp/claude-1000/-opt-stacks-cine-app/9bf72156-c396-4d6d-80d5-0d784ed2dcfd/scratchpad/xexp
while [ ! -f $X/cpulog.stop ]; do
  for n in $(docker ps --format '{{.Names}}' | grep -E '^(xray-exp-|laterna-xray$|jellyfin$)'); do
    id=$(docker inspect -f '{{.Id}}' $n 2>/dev/null) || continue
    u=$(awk '/usage_usec/{print $2}' /sys/fs/cgroup/system.slice/docker-$id.scope/cpu.stat 2>/dev/null) && echo "$n $(date +%s) $u $(cut -d' ' -f1 /proc/loadavg)" >> $X/cpu.log
  done
  timeout 10 tail -f /dev/null
done
