#!/bin/sh
# Imprime la référence d'un build local : le hash court du commit, suffixé `-dirty` si les
# fichiers suivis diffèrent de ce commit. À passer ainsi :
#   BUILD_REF=$(tools/build-ref.sh) docker compose build
# Sans elle, le build s'horodate lui-même et le champ `build` des journaux ne désigne plus aucun
# commit ; sans le suffixe, un build fait d'un arbre modifié se ferait passer pour le commit.
# Les fichiers non suivis ne comptent pas : .env, docker-compose.yml, data/ le sont exprès.
set -e
cd "$(dirname "$0")/.."
ref=$(git rev-parse --short HEAD)
git update-index -q --refresh >/dev/null 2>&1 || true
if git diff-index --quiet HEAD --; then echo "$ref"; else echo "$ref-dirty"; fi
