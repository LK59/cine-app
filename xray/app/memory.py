"""La mémoire d'une série, visages et voix : des contributions par épisode, gardées avec leur provenance.

Jusqu'au 10/11/2026 la mémoire des visages était une moyenne glissante par personne (`series_faces`) :
un épisode mal nommé s'y fondait pour toujours, sans qu'on puisse dire lequel, ni le retirer. Désormais
chaque épisode **dépose** sa contribution (`series_memory` : série, genre `face` ou `voice`, modèle,
personne, épisode, empreinte, poids, note, date) et la mémoire est **lue** comme la moyenne pondérée
des contributions. Conséquences :

- **une contribution par épisode et par personne**, remplacée — jamais ajoutée — quand l'épisode est
  réanalysé ou rénommé (`relabel.py`) : refaire un épisode ne double pas son poids ;
- **l'influence d'un épisode est bornée** : poids plafonné (`FACE_EPISODE_MAX`, `VOICE_EPISODE_MAX`) et
  au plus `MAX_PEOPLE_PER_EPISODE` personnes, les plus présentes ;
- **seulement ce qui est sûr, et d'une source indépendante** : un visage nommé par les *photos* avec une
  marge nette (`castmod.update_series`), une voix nommée par les *visages* (`voices.build`, `profiles`) —
  jamais par la mémoire elle-même, qui finirait par confirmer ses erreurs ;
- **auditable et réinitialisable** : `GET /series/{id}/memory` liste les contributions,
  `POST /series/{id}/memory/reset` les efface, puis la série est renommée dans l'ordre des épisodes.

Les lignes de l'ancienne `series_faces` sont reprises une fois comme une contribution `legacy`.
"""

from __future__ import annotations

import time

import numpy as np

from .db import Database

FACE_EPISODE_MAX = 300.0      # secondes de présence comptées au plus par personne et par épisode
VOICE_EPISODE_MAX = 60.0      # morceaux de parole comptés au plus par personne et par épisode
MAX_PEOPLE_PER_EPISODE = 15
LEGACY = "legacy"


def contribute(db: Database, series_id: str | None, kind: str, model: str, item_id: str,
               entries: dict[int, tuple[np.ndarray, float, float]]) -> int:
    """Remplace la contribution de cet épisode : {personId: (empreinte, poids, note)}. Rend le nombre gardé."""
    if not series_id:
        return 0
    cap = FACE_EPISODE_MAX if kind == "face" else VOICE_EPISODE_MAX
    kept = sorted(((pid, e) for pid, e in entries.items() if e[1] > 0), key=lambda kv: -kv[1][1])[:MAX_PEOPLE_PER_EPISODE]
    now = time.time()
    with db.tx() as c:
        c.execute("DELETE FROM series_memory WHERE series_id=? AND kind=? AND model=? AND item_id=?",
                  (series_id, kind, model, item_id))
        for pid, (emb, weight, score) in kept:
            v = np.asarray(emb, dtype=np.float32)
            v = v / max(float(np.linalg.norm(v)), 1e-9)
            c.execute("""INSERT INTO series_memory (series_id, kind, model, person_id, item_id, emb, weight, score, updated)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                      (series_id, kind, model, int(pid), item_id, v.tobytes(), float(min(weight, cap)), float(score), now))
    return len(kept)


def recall(db: Database, series_id: str | None, kind: str, model: str) -> dict[int, np.ndarray]:
    """La mémoire : par personne, la moyenne des contributions pondérée par leur poids, normalisée."""
    if not series_id:
        return {}
    acc: dict[int, np.ndarray] = {}
    for r in db.q("SELECT person_id, emb, weight FROM series_memory WHERE series_id=? AND kind=? AND model=?",
                  (series_id, kind, model)):
        v = np.frombuffer(r["emb"], dtype=np.float32) * float(r["weight"])
        pid = int(r["person_id"])
        acc[pid] = acc[pid] + v if pid in acc else v.copy()
    return {pid: (v / max(float(np.linalg.norm(v)), 1e-9)).astype(np.float32) for pid, v in acc.items()}


def provenance(db: Database, series_id: str) -> list[dict]:
    return [{"kind": r["kind"], "model": r["model"], "personId": int(r["person_id"]), "itemId": r["item_id"],
             "weight": round(float(r["weight"]), 2), "score": round(float(r["score"]), 4), "updated": r["updated"]}
            for r in db.q("""SELECT kind, model, person_id, item_id, weight, score, updated FROM series_memory
                             WHERE series_id=? ORDER BY kind, person_id, updated""", (series_id,))]


def reset(db: Database, series_id: str) -> int:
    with db.tx() as c:
        n = c.execute("SELECT COUNT(*) FROM series_memory WHERE series_id=?", (series_id,)).fetchone()[0]
        c.execute("DELETE FROM series_memory WHERE series_id=?", (series_id,))
        c.execute("DELETE FROM series_faces WHERE series_id=?", (series_id,))
    return int(n)


def migrate_legacy(conn) -> None:
    """Une fois : chaque ligne de `series_faces` devient une contribution `legacy` (même empreinte,
    même poids). Rien n'est repris si la série a déjà des contributions de visages."""
    conn.execute(f"""INSERT OR IGNORE INTO series_memory (series_id, kind, model, person_id, item_id, emb, weight, score, updated)
                     SELECT f.series_id, 'face', f.model, f.person_id, '{LEGACY}', f.emb, f.weight, 0, f.updated
                     FROM series_faces f
                     WHERE NOT EXISTS (SELECT 1 FROM series_memory m WHERE m.series_id=f.series_id AND m.kind='face'
                                       AND m.model=f.model)""")
