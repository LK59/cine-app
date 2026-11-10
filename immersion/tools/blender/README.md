# Shared headless Blender image

Blender 4.5.16 LTS (official tarball, SHA-256 verified in the Dockerfile), with `tifffile` and
`imagecodecs` installed in Blender's Python (numpy is bundled).

Build (from `immersion/`):

    docker build -t immersion-blender tools/blender

Run a script (headless, CPU), from `immersion/`:

    docker run --rm --name immersion-blender-job --cpus 5 --user $(id -u):$(id -g) -e HOME=/tmp \
      -v "$PWD":/work immersion-blender -b --python tools/panorama/some_script.py -- args

The entrypoint is `blender`; use `--entrypoint /opt/blender/4.5/python/bin/python3.11` for plain Python.
Name containers `immersion-blender-*`, always `--rm`.
