#!/usr/bin/env python3
"""Prépare le dossier de données jetable d'une instance de banc.

N'en recopie que ce qu'il faut pour servir le cinéma comme la production :

- `kv_cache` — les réponses TMDB et le reste du cache disque : sans lui, chaque instance neuve
  redemanderait toute la bibliothèque à TMDB (quota partagé) et ouvrirait plus lentement ;
- `app_settings` — **sauf** les clés des sous-titres générés, de la recherche de répliques, des
  alertes et des tags posés d'office aux nouveaux comptes ;
- `sessions`, réduite à la colonne `jf_device` (jeton, compte et appareil effacés) : le ménage des
  appareils Jellyfin (`jellyfinDevicePrune.ts`, quinze minutes après le démarrage) protège les
  appareils des sessions vivantes. Sur une base vide, il aurait retiré de Jellyfin ceux d'appareils
  encore connectés à la production.

La base de production est ouverte en lecture seule (`mode=ro`) ; `repliques.db` n'est jamais ouverte.
Usage : prepare-data.py <cine.db de production> <dossier de données jetable>
"""
import os
import re
import sqlite3
import sys

DROP_SETTINGS = re.compile(r"^(SUBTITLE_GEN|REPLIQUES|NEW_ACCOUNT|__ACTIVITY|__DIAGNOSIS)|ALERT|PUSH|WEBHOOK", re.I)


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    prod, dest_dir = sys.argv[1], sys.argv[2]
    if os.path.basename(prod) != "cine.db":
        print("refus : seule cine.db est lue", file=sys.stderr)
        return 2
    os.makedirs(os.path.join(dest_dir, "logs"), exist_ok=True)
    dest = os.path.join(dest_dir, "cine.db")
    if os.path.exists(dest):
        os.remove(dest)

    src = sqlite3.connect(f"file:{prod}?mode=ro", uri=True)
    out = sqlite3.connect(dest)
    for table in ("kv_cache", "app_settings", "sessions"):
        (sql,) = src.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
        out.execute(sql)

    rows = src.execute("SELECT key, value, fetched_at FROM kv_cache").fetchall()
    out.executemany("INSERT INTO kv_cache (key, value, fetched_at) VALUES (?, ?, ?)", rows)

    kept, dropped = [], []
    for key, value, updated in src.execute("SELECT key, value, updated_at FROM app_settings"):
        if DROP_SETTINGS.search(key):
            dropped.append(key)
            continue
        kept.append(key)
        out.execute("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)", (key, value, updated))

    devices = src.execute(
        "SELECT jf_device, created_at, last_seen_at FROM sessions WHERE jf_device IS NOT NULL"
    ).fetchall()
    out.executemany(
        "INSERT INTO sessions (jti, user_id, created_at, last_seen_at) VALUES (?, '-', ?, ?)",
        [(f"banc-{i}", c, s) for i, (_, c, s) in enumerate(devices)],
    )
    for i, (device, _, _) in enumerate(devices):
        out.execute("UPDATE sessions SET jf_device = ? WHERE jti = ?", (device, f"banc-{i}"))

    out.commit()
    out.close()
    src.close()
    print(f"kv_cache : {len(rows)} entrées ; réglages gardés : {', '.join(kept)} ; écartés : {', '.join(dropped)} ; appareils protégés : {len(devices)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
