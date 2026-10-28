# Behaviour fingerprint of the player

A characterization suite: it does not say what the player *should* do, it records what it *does*,
so that a refactoring that is meant to change nothing can prove it changed nothing. It exists for
splitting the four large player files (`ExperimentalPlayerHost.tsx`, `PlayerHost.tsx`,
`PlayerControls.tsx`, `mseSource.ts`) without a device lab.

## What it drives

| File | Under test (real) | Simulated |
|---|---|---|
| `empreinte-natif.test.tsx` | `ExperimentalPlayerHost` + `PlayerControls` + `usePlaybackSession` + `reportPlayback` + `unsentStop` | the remux pipeline, the file description (SWR), the playback provider, the lighter-version prewarm |
| `empreinte-serveur.test.tsx` | `PlayerHost` + `PlayerControls` + `usePlaybackSession` + `reportPlayback` + `unsentStop` | hls.js (every call noted), the engine (native HLS or hls.js), the playback provider, the native player's handover, the page reload |
| `empreinte-mse.test.ts` | `MseSource` | MediaSource / SourceBuffer / the element / the remuxer (every operation noted) |

Scenarios: opening (resume given, resume asked of the server, `resumeAt: 0`), seeks (keyboard,
button, superseded, while paused), a pause longer than ten minutes, audio track change (native
rebuild, hls.js renegotiation in place, WebKit reload intent), subtitles (container track, side file
in flight then abandoned, dual subtitles), background (short and long, source lost), network loss
and recovery, give-up (repeated source loss, media-error budget, outage bound), slow link and the
lighter-version switch, handover to the server player (failure, AirPlay), cast route taken and
lost, next episode (button, credits card countdown, episodes menu), close / `pagehide` / bfcache /
unmount, error screens (media server unreachable, expired Jellyfin session, refused file, audio
ladder). For `MseSource`: hand-written sessions plus three sessions drawn from fixed seeds.

## What it records

One ordered thread per scenario, written to `__empreintes__/<family>/<scenario>.txt`, one line per
entry:

- `log <kind> {fields}` — every player-log line, whichever channel it left by (`fetch`, or `beacon`
  for a `stop`), with all its fields in the order the code wrote them;
- `fetch <method> <url> {body}` and `abort` — every other request (Jellyfin progress/stop, playback
  negotiation, prewarm, subtitles…), and every request abandoned in flight;
- `storage local|session set|remove <key> <value>` — writes to the player's `cine*` keys (kept
  stop summary, resume memory, reload intent, volume…);
- `media <element> play|pause|load|currentTime=|src=` — orders given to the `<video>` element;
- `hls …`, `probe …`, `remux …`, `buffer …`, `source …`, `remuxer …` — orders given to what lies
  under the host;
- `trace <step>` — the player's local trace;
- `playback …`, `onFallback …`, `stepBack …` — what the host asked of its parent;
- `dom <step>` followed by indented lines — a summary of the controls at that step: every button,
  input, role and live region with its accessible name and ARIA state, displayed messages, the
  `<video>` and its `<track>`s.

Everything is deterministic rather than masked: fake timers (`Date`, `performance`, timeouts,
animation frames) from a fixed instant, `Math.random` and `crypto.randomUUID` drawn from a fixed
sequence. A changed delay or duration shows up as a changed number. Only three fields are removed,
because they change with the build and not with the behaviour: `build`, `version`, `lineId`; the
user agent is written `<agent>`.

## Running it

```sh
docker run --rm -v "$PWD":/app -w /app node:26-alpine npx vitest run src/__tests__/empreinte/
```

It is part of `npm test`, so the gate runs it. A missing fingerprint file is written on a local
run and is a failure under CI. To see the raw thread of a scenario while writing one, set
`EMPREINTE_DEBUG=<directory>`: each scenario's entries are written there, even when it fails.

## The rule

- **A pure move must not change any fingerprint.** If one changes, the move was not pure: read the
  diff, it says which line, which field, which order.
- **A deliberate behaviour change updates the fingerprints in its own commit**, with the reason in
  the message (`npx vitest run src/__tests__/empreinte/ -u`, then read every changed file before
  committing). Never mix a refresh of the fingerprints with a refactoring.
- **A missing fingerprint fails**: a renamed scenario or a deleted file would otherwise be rewritten
  silently and prove nothing. A new scenario is recorded with `EMPREINTE_UPDATE=1`.

What it does not see: real decoding, real networks, real engines. It fixes what the code decides
given the same inputs; device testing remains the proof that the inputs are realistic.
