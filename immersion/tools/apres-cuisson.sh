#!/bin/sh
# Chaîne sans surveillance : attend la fin de la cuisson des lightmaps, puis
# build, captures de chaque pièce et de l'affiche, puis le portail de l'application jusqu'au vert (5 essais).
# Journaux : immersion/logs/. Usage : sh tools/apres-cuisson.sh   (depuis immersion/)
cd "$(dirname "$0")/.." || exit 1
L=logs; mkdir -p $L
say() { echo "$(date '+%H:%M:%S') $*" >> $L/suite.log; }
say "attente de la fin de la cuisson"
# La cuisson enchaîne plusieurs conteneurs : c'est la ligne « exit= » de son journal qui dit qu'elle a fini.
while ! grep -aq '^exit=' $L/bake.log 2>/dev/null; do sleep 20; done
# La cuisson écrit son journal dans logs/bake.log ; lancée ailleurs, BAKELOG dit où le prendre.
[ -n "${BAKELOG:-}" ] && [ "$BAKELOG" != "$L/bake.log" ] && cp "$BAKELOG" $L/bake.log 2>/dev/null
say "cuisson finie : $(grep -a 'exit=' $L/bake.log | tail -1) ; $(ls public/assets/lightmaps | tr '\n' ' ')"
say "build"
docker run --rm --name immersion-build --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD/..":/repo -w /repo/immersion node:26-alpine \
  sh -c 'npx tsc --noEmit && npx vite build --minify false' > $L/build.log 2>&1
say "build : exit=$?"
cp tests/fixtures/mire.webm dist/mire.webm
say "captures des pièces"
STATE="$PWD/$L/immersion-state.json" QUALITY=ultra PW_CPUS=4 timeout 1500 tests/capture.sh entree salon tv baie canape charpente cuisine ilot escalier mezzanine balcon couloir chambre lit telechambre terrasse bain dehors vue foyer hifi chat plaid porte reglages > $L/captures.log 2>&1
say "captures : exit=$?"
say "affiche"
STATE="$PWD/$L/immersion-state.json" QUALITY=ultra SIZE=1000x1500 PW_CPUS=4 timeout 600 tests/capture.sh affiche > $L/affiche.log 2>&1
say "affiche : exit=$? (version précédente gardée dans $L/poster-v1.jpg)"
n=1
while [ $n -le 5 ]; do
  say "portail, essai $n"
  docker run --rm --name immersion-gate -v "$PWD/..":/app -v /opt/stacks/cine-app/node_modules:/app/node_modules:ro -w /app node:26-alpine \
    sh -c 'set -e; npm run typecheck; npm run lint -- --max-warnings=0; npm test' > $L/gate-$n.log 2>&1
  code=$?
  echo "exit=$code" >> $L/gate-$n.log
  say "portail, essai $n : exit=$code ; $(sed 's/\x1b\[[0-9;]*m//g' $L/gate-$n.log | grep -a 'Test Files' | tail -1)"
  [ $code -eq 0 ] && break
  n=$((n + 1))
done
say "fin de la chaîne"
