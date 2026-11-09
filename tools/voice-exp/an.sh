#!/bin/sh
# lance analyse.py dans un conteneur jetable (scipy/numpy de l'image xray)
docker run --rm -i --name voice-an-$$ --user 1000:1000 -e HOME=/tmp --cpus 1 -v /tmp/claude-1000/-opt-stacks-cine-app/9bf72156-c396-4d6d-80d5-0d784ed2dcfd/scratchpad/voice:/w --entrypoint python laterna-xray:local "$@" 2>&1 | grep -v telemetry
