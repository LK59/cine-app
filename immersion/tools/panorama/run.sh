#!/bin/sh
# usage: tools/panorama/run.sh <name> <cpus> <script.py> [args...]   (from immersion/)
name=$1; cpus=$2; script=$3; shift 3
exec docker run --rm --name "immersion-blender-$name" --cpus "$cpus" --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD":/work immersion-blender -b --python "$script" -- "$@"
