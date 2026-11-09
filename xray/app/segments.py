"""Plages à ne pas analyser : générique de début, de fin, rappel, bande-annonce.

Personne n'y cherche un acteur, et un générique de fin défile souvent sur des visages (photos,
bêtisier) qui n'ont rien à faire dans les scènes. Deux sources, dans cet ordre :

1. `skip` dans l'ordre (`POST /jobs`) : Laterna dit lui-même quoi sauter — une liste vide veut
   dire « rien », et rien n'est demandé à Jellyfin ;
2. sinon, avec `JELLYFIN_URL` et `JELLYFIN_API_KEY`, les segments que Jellyfin connaît pour
   l'élément (`GET /MediaSegments/{itemId}`, Jellyfin 10.10 et suivants) : Intro, Outro (le
   générique de fin), Recap, Preview. `Commercial` et `Unknown` ne sont pas sautés.

Un échec (Jellyfin injoignable, élément inconnu) n'empêche rien : l'élément est analysé en entier.
"""

from __future__ import annotations

import logging

import httpx

from .config import settings

log = logging.getLogger("xray.segments")

SKIP_TYPES = {"Intro", "Outro", "Recap", "Preview"}
TICKS = 10_000_000  # Jellyfin compte en unités de 100 ns
# Un morceau analysable de moins d'une demi-seconde, coincé entre une plage sautée et le bord
# d'un tronçon, ne donnerait qu'une image : il est sauté avec elle.
MIN_PIECE = 0.5


def parse_segments(data: object) -> list[tuple[float, float]]:
    items = data.get("Items") if isinstance(data, dict) else None
    out = []
    for it in items or []:
        if not isinstance(it, dict) or it.get("Type") not in SKIP_TYPES:
            continue
        try:
            s, e = float(it["StartTicks"]) / TICKS, float(it["EndTicks"]) / TICKS
        except (KeyError, TypeError, ValueError):
            continue
        if e > s >= 0:
            out.append((s, e))
    return merge(out)


def merge(ranges: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[list[float]] = []
    for s, e in sorted(ranges):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(a, b) for a, b in out]


def fetch_jellyfin(item_id: str) -> list[tuple[float, float]] | None:
    """Les plages à sauter selon Jellyfin ; None si Jellyfin n'est pas configuré ou ne répond pas."""
    if not (settings.jellyfin_url and settings.jellyfin_api_key):
        return None
    try:
        r = httpx.get(
            f"{settings.jellyfin_url}/MediaSegments/{item_id}",
            # Seule forme d'authentification acceptée par Jellyfin 12 par défaut.
            headers={"Authorization": f'MediaBrowser Token="{settings.jellyfin_api_key}"'},
            timeout=10.0,
        )
        if r.status_code == 404:
            return []
        r.raise_for_status()
        return parse_segments(r.json())
    except Exception as e:
        log.warning("Jellyfin /MediaSegments : %s", type(e).__name__)
        return None


def pieces(start: float, end: float, skips: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Ce qui reste à analyser de [start, end] une fois les plages sautées retirées."""
    out = []
    cur = start
    for s, e in merge(skips):
        if e <= cur or s >= end:
            continue
        if s > cur:
            out.append((cur, s))
        cur = max(cur, e)
    if cur < end:
        out.append((cur, end))
    return [(a, b) for a, b in out if b - a >= MIN_PIECE]
