# Security

How accounts, roles and sessions work, and what the server refuses. Installation:
[DEPLOYMENT.md](../DEPLOYMENT.md); every variable: [ENV.md](../ENV.md).

## Authentication and roles

Two ways in, and exactly two roles.

**Jellyfin accounts (the normal way).** Any existing Jellyfin user logs in with their Jellyfin
username and password. The session carries a Jellyfin identity, which is what per-user resume,
play history, watched state, playback preferences and recommendations are all built on. Jellyfin
administrators are administrators here; everyone else is a regular user.

**The local admin account** is created by the setup assistant (its password stored hashed) and is
independent from Jellyfin — for setup, and for the day Jellyfin is unreachable. It has no Jellyfin
identity, so nothing depending on one works under it, and it lands on `/gestion` rather than on
Cinema. A deployment managed as code can fix it in `.env` instead (`APP_ADMIN_USER` /
`APP_ADMIN_PASSWORD`, see [ENV.md](../ENV.md)), which replaces the assistant's.

Permissions are never enforced by the interface. `src/proxy.ts` refuses every write a `user`
should not make, whatever the screen happens to show; hiding a button is presentation, not
security. A number of reads are refused too (`ADMIN_ONLY_READS`): the interactive release and
subtitle searches, which start work at the indexers and subtitle providers although they are
`GET`s, and every read only the management screens use — the Radarr/Sonarr library lists and
items, the calendar, queues, download client, indexers, statistics, service status and activity.
Cinema reads its own routes, which apply the account's restrictions.

**Jellyfin's parental control is honoured everywhere.** A tag blocked in an account's Jellyfin policy
(*Blocked tags*) hides the tagged titles in Laterna as it does in Jellyfin: from the catalogue, the
search, the discovery rows, filmographies, sagas and similar titles, and the title's own routes
answer as if it did not exist. New Jellyfin accounts can receive a set of blocked tags
automatically: list them in *Management → Configuration → New accounts* (`NEW_ACCOUNT_BLOCKED_TAGS`). Within five
minutes, any account the server has not seen before gets them in its Jellyfin policy, once —
existing accounts are left untouched, administrators always, and removing the tag by hand later is
final.

---

## Keys, tokens and what never to commit

Never commit:

```text
.env
data/
*.db
*.db-wal
*.db-shm
```

All service API keys stay server-side and are never exposed to the browser, and the server's
configuration module is never bundled into client code (a constant a screen needs lives in a
module of its own, such as `src/lib/tmdbImageBase.ts`). Jellyfin writes its
access token into the playlists and subtitle URLs it generates (`ApiKey=`); the stream relay
authenticates every request with its own header and strips that parameter from every address and
playlist it forwards (`src/lib/stripAccessToken.ts`), so it never reaches a page, a history or a
reverse proxy's access log. Streams, segments and subtitles are served `Cache-Control: private`:
only the viewer's browser may keep them, never a shared cache.

### Sessions

A session is a signed token (HMAC-SHA256) in an `httpOnly` cookie, with a server-side row so it
can be revoked immediately rather than only on expiry. A few things are worth knowing:

- **The Jellyfin token and the Jellyseerr cookie travel inside it, encrypted** (AES-GCM, key
  derived from `SESSION_SECRET`). Signing is not hiding: without this, a stolen cookie handed over
  a working Jellyfin token rather than just a Laterna session.
- **Sessions slide.** The cookie is reissued past a day of age, keeping the same session id, so
  daily use never ends in a weekly sign-out.
- **Each sign-in is a Jellyfin device** (`Laterna`, id `cine-app-…`), revoked at sign-out. One a
  session never signed out of is removed by a daily task once it has been idle for 30 days —
  never another client's, never one still tied to a live session.
- **Writes from another page are refused.** The cookie is `SameSite=Lax`, which stops a
  third-party site but not a sibling subdomain of the same domain. Every write to `/api/` is
  checked in `src/proxy.ts`: `Sec-Fetch-Site` must say `same-origin` (or, from a browser that does
  not send it, `Origin` must match the host).
- **A casting pass dies with its session.** The pass a television uses to fetch one title's stream
  without a cookie (six hours, read-only, that title only) names the session that asked for it,
  and stops working once that session is signed out or closed.
- **Signing out turns this device's notifications off.** A push subscription belongs to the
  browser, not to the person; left in place, the next account on a shared tablet received the
  previous one's notifications. If they were on, the question is asked again at the next sign-in.
- **Abuse is bounded where one account could cost everyone.** Sign-in fields are typed and
  length-capped before any work; problem reports are capped per account (30 a day, 20 open
  drafts; the administrator is exempt), refused without a declared size, and their screenshots
  decoded under a pixel limit; push subscriptions are accepted only for known push services, ten
  per account; searches (120 a minute), ratings lookups (30 a minute, 50 new titles each) and
  player-log detail lines (400 an hour) are limited per account; the server's in-memory cache is
  bounded, so no stream of distinct queries can fill it.
- **Requests are always someone's.** When Jellyseerr cannot tell which account is asking, a request
  is refused with a message rather than filed under the API key, which Jellyseerr would treat as
  its administrator (approved, outside quotas).
- **The image optimizer needs a session.** `/_next/image` downloads and keeps resized artwork for a
  year; open to anyone, walking TMDB addresses could fill the data volume. Only the server's own
  poster prewarm, on the loopback, passes without one.
- **Client addresses come from the connection.** Sign-in limits and logs are keyed by address. The
  server records the address of each connection itself and believes `X-Forwarded-For` only when the
  connection comes from a proxy listed in `TRUSTED_PROXIES` (a container name, an address or a
  network). Without it, any container on the same Docker network could claim a different address
  on every attempt. See [DEPLOYMENT.md](../DEPLOYMENT.md#3-put-it-behind-a-reverse-proxy).
- **Signing your other devices out affects Laterna only.** The Jellyfin sessions those logins
  opened are left alone — deliberately: nobody clicking that button expects to lose Jellyfin
  with it.

`SESSION_SECRET` is generated on first launch when `.env` leaves it empty, and kept in
`data/config/secrets.json`. A value set in `.env` wins; the server refuses to start rather than
logging a line nobody reads when that value is shorter than 16 characters or one of the published
example values (`openssl rand -hex 32` makes a good one). Likewise, `APP_ADMIN_PASSWORD` left at the old example
value `change-me` stops the startup (empty is allowed: it disables the local admin account).
