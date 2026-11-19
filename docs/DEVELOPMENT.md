# Development

Only relevant if you are modifying the code — deploying needs none of this.

**No Node or npm is needed on the host.** Everything runs through Docker.

```sh
# Once, and after every dependency change: install node_modules into the working tree.
# Alpine, like every container below, so the native better-sqlite3 module matches; the build
# tools are needed because npm rebuilds it from source (the Dockerfile's deps stage does the same).
docker run --rm -v "$PWD":/app -w /app node:26-alpine sh -c \
  'apk add --no-cache python3 make g++ && npm ci'

# Iterate — hot reload against the working tree. Published on the server's loopback (3001) unless
# DEV_BIND says otherwise; reach it through a reverse proxy on the same Docker network
# (cine-app-dev:3000), an SSH tunnel, or DEV_BIND=0.0.0.0 on a private LAN.
# Runs alongside production; does not rebuild the image.
docker compose -f docker-compose.dev.yml up

# The gate — identical to CI's verify job. Run it before every commit.
docker run --rm -v "$PWD":/app -w /app node:26-alpine sh -c \
  'set -e; npm run typecheck; npm run lint -- --max-warnings=0; npm test'

# One test file
docker run --rm -v "$PWD":/app -w /app node:26-alpine npx vitest run src/__tests__/<file>
```

`set -e` and no pipes: `npm test | grep` swallows the exit code, and a red test has been pushed
that way before.

**Building from source** instead of pulling the image — replace the `image:` line in your compose
file with:

```yaml
build:
  context: .
  dockerfile: Dockerfile
  args:
    BUILD_REF: ${BUILD_REF:-}
```

then:

```sh
BUILD_REF=$(tools/build-ref.sh) docker compose build && docker compose up -d && docker builder prune -f --max-used-space 15GB
```

`BUILD_REF` names the build: it is shown next to the version in the settings page (« Version 8.1
(5526f39) ») and names the service worker's cache generation. The version itself comes from
`package.json` and is chosen by hand before each release (major, minor, patch); it is shown
without a zero patch, as iOS does. `tools/build-ref.sh` prints the short commit, with `-dirty`
appended when tracked files differ from it, so a build of modified sources never passes for the
commit. The published images carry their commit this way (the GHCR workflow passes it); without it (`.git` is not in the build context) the build names itself with
its own date and time. The build runs the test suite first: it fails loudly instead of
shipping a broken image.

`docker-compose.yml` is intentionally git-ignored: keep your production compose local to your
server, and commit changes to `docker-compose.example.yml` (minimal) or `docker-compose.advanced.yml`
when the public templates should change.

**Why the dev stack exists.** `docker compose build` re-runs the full production build and writes
a new set of image layers every time — hundreds of megabytes per iteration, pure waste when a
single source file changed. The dev stack runs `next dev` against the bind-mounted working tree,
in its own container, on its own port, with its own build directory, so the two never overwrite
each other's output.

When a real build *is* needed, three things keep it cheap: `.dockerignore` excludes `data/` (the
runtime state, which used to be copied into the build context and into a layer); the `manifest`
stage hands `npm install` a `package.json` / `package-lock.json` whose version is reset to 0.0.0,
so the version bump before each release does not invalidate the dependency layer; and npm's
download cache is a BuildKit cache mount, updated in place. Next's own compiler cache is
deliberately *not* reused: a build fed the previous one once shipped fresh JavaScript with a stale
stylesheet. Each build still adds a few hundred megabytes of build cache that nothing else removes
— hence the `docker builder prune` above.

One caveat: the development port is plain HTTP, and several browser APIs are restricted to secure
contexts. The ordinary path — remux into MediaSource, native `<video>` — works there. WebCodecs
does not exist outside a secure context, so neither does what depends on it: the in-browser
re-encoding of DTS, TrueHD and FLAC, which needs `AudioEncoder` — those files go to the server
player instead. Testing them needs a secure context: an SSH tunnel to `localhost:3001`
(`localhost` counts as secure), a reverse-proxy host pointing at `cine-app-dev:3000`, or a deploy.

## Debugging a running deployment

Diagnose against the container rather than reasoning in the dark. It has every service URL and API
key in its environment:

```sh
docker exec laterna node -e '...'
docker exec laterna tail -n 50 /app/data/logs/server.log   # server errors, with stack traces
docker exec laterna tail -n 50 /app/data/logs/player.log   # what each viewer's player reported
```

The container is `cine-app` on installations made before 10.65.2.

Both are one JSON object per line, rotated at 5 MB, and live in the `data` volume — which matters,
because `docker logs` dies with the container, and the container is recreated on every deploy.
Beside them: `auth.log`, `startup.log`, `notifications.log`, `subtitle-gen.log` and the test bench's
`bench.log` — all listed in [DEPLOYMENT.md](../DEPLOYMENT.md#7-troubleshooting).

## Screenshot conventions

Placeholders in [FEATURES.md](FEATURES.md) and [DEPLOYMENT.md](../DEPLOYMENT.md) are HTML
comments naming the file to produce, what to frame, and the `<img>` tag to uncomment once it
exists. They live in `docs/screenshots/`. The images the top-level README shows (the hero, the
demo and the gallery) are referenced there directly, not through placeholders.

For a consistent set: desktop shots at 1920×1080 in the dark theme, phone shots from one device,
and the same handful of titles across all of them so the library reads as one library.

The list of what is still missing is the placeholders themselves — there is no second list to keep
in sync:

```sh
grep -n 'CAPTURE :' docs/FEATURES.md DEPLOYMENT.md
```
