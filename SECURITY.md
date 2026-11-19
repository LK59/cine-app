# Security

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub:
**[Security → Report a vulnerability](https://github.com/LK59/laterna/security/advisories/new)**.

Include what an attacker can do, the version, and the steps or request that show it. You will get an
answer within a few days; a fix is released as a new version, and the advisory is published once
installations have had a chance to update.

## Supported versions

Only the **latest release** is supported — the `:stable` / `:latest` image. Updating is
`docker compose pull && docker compose up -d`; migrations run at startup.

## Scope

Laterna sits between your household and your own services (Jellyfin, Radarr, Sonarr, qBittorrent,
Jellyseerr…). Of particular interest: a way around the server-side role checks (a `user` or a share
link doing what only an administrator may), reading another account's data, reaching an upstream
service or its API key through Laterna, or a request from another site acting on a signed-in session.
How the server enforces each of these is described in [docs/SECURITY.md](docs/SECURITY.md).
