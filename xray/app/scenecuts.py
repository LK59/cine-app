"""Les débuts de scène où l'on peut revenir : « Revenir au début de la scène » (11/2026).

Laterna propose, à la reprise d'un film laissé depuis des heures, de revenir au début de la scène en
cours. Encore faut-il que ce début en soit un : une scène du service est un regroupement de plans par
les couleurs et les visages, et une frontière de scène peut tomber au milieu d'un dialogue (deux décors
alternés), entre deux angles d'une même pièce, ou dans un montage rapide sans personne. Ce module dit,
**frontière par frontière, si l'on peut y revenir** (`cut: {ok, why}`) et **d'où partir** (`entry`) — sans
rien relire du fichier : tout vient de ce qui est gardé en base (plans, pistes de visages, zones de parole)
et des chapitres du fichier, lus une fois par ffprobe (l'en-tête seul).

Ce qui est mesuré à chaque frontière (`boundary_features`, calculé à l'assemblage, `results._assemble`) :

- `sim` : la ressemblance des couleurs des deux scènes (histogrammes moyens, comme `_merge_short`) ;
- `fb`, `fa`, `fj` : les groupes de visages — anonymes compris — vus dans la minute d'avant (dans la scène
  d'avant) et dans la minute d'après (dans la scène d'après), et leur indice de Jaccard ;
- `first` (le début du fichier) et `gap` (la première scène après une plage non analysée : générique sauté).

Ce qui s'y ajoute à la lecture (`annotate`, servi par `/items/{id}/scenes`) :

- la **parole qui traverse la coupe** (zones de parole de « qui parle » fusionnées sous 0,5 s d'écart) : si
  elle a commencé 3 s au plus avant la coupe, le point d'entrée recule jusqu'à elle (`entry`) — revenir au
  milieu d'une phrase n'est pas revenir au début d'une scène ; plus de 3 s avant, la coupe est au milieu d'un
  dialogue et n'en est pas une (`parole`) ;
- un **chapitre d'auteur** à 2 s près rend la coupe sûre (`chapitre`) ; des chapitres posés à intervalles
  réguliers (« Chapter 1 », « Chapter 2 »… toutes les 5 min) sont automatiques et ignorés, et des marqueurs
  seuls (intro, générique) ne disent rien des scènes ;
- sinon, **deux signaux** (choix du propriétaire, 10/11/2026) : les couleurs changent (`sim` ≤ 0,82) *et* les
  personnes changent (`fj` ≤ 0,15 avec deux groupes au moins de chaque côté) ; sinon `même-lieu`. Deux scènes
  de moins de 25 s sans visages ni parole sont un `montage`, et une scène sûre de moins d'une minute entre deux
  frontières refusées un `îlot`.

Mesuré le 10/11/2026 sur 44 frontières jugées à l'œil (*Ted Lasso*, *Le Flambeau*, *House of the Dragon*) :
un seul signal (couleurs *ou* personnes) acceptait 7 frontières fausses sur 22 acceptées ; deux signaux en
acceptent beaucoup moins, presque toutes justes. Les seuils sont des constantes nommées, ici.

Rien de ceci ne touche les scènes, leurs personnes, ni la version des résultats (`RESULT_VERSION`) : les
champs sont des **ajouts compatibles** de `/scenes`, et ils portent leur propre version (`CUTS_VERSION`).
"""

from __future__ import annotations

import json
import logging
import re
import statistics
import subprocess
import time

from .config import settings

log = logging.getLogger("xray.scenecuts")

# Version des débuts de scène (`cutsVersion` de /scenes) : à monter quand une règle ou un seuil d'ici
# change. Les mesures gardées (`results.bounds_json`) portent la leur ; une mesure d'une autre version est
# refaite en tâche de fond (`backfill_some`), sans rien décoder.
#   1 — (10/11/2026) première version : chapitres, parole, deux signaux, montage, îlot.
CUTS_VERSION = 1

# Les personnes : groupes de visages vus dans la minute de part et d'autre (dans les deux scènes voisines).
PEOPLE_WINDOW_S = 60.0
# Les zones de parole séparées de moins que ceci ne font qu'une prise de parole.
SPEECH_JOIN_S = 0.5
# Une parole « traverse » une coupe si elle commence et finit à plus de ceci de part et d'autre.
SPEECH_CROSS_MARGIN_S = 0.15
# Une parole commencée au plus tant avant la coupe déplace le point d'entrée jusqu'à elle ; plus tôt, la
# coupe est au milieu d'un dialogue.
SPEECH_SNAP_S = 3.0
# Un chapitre d'auteur « tombe » sur une coupe à tant près.
CHAPTER_ALIGN_S = 2.0
# Deux signaux : couleurs et personnes.
SIM_MAX = 0.82
FACE_JACCARD_MAX = 0.15
FACE_GROUPS_MIN = 2
# Montage : deux scènes plus courtes que ceci, sans visages ni parole qui traverse.
MONTAGE_MAX_S = 25.0
# Îlot : une scène sûre plus courte que ceci entre deux frontières refusées.
ISLAND_MAX_S = 60.0
# Chapitres automatiques : intervalles égaux à tant près (ou à 2 % de leur médiane).
EVEN_TOLERANCE_S = 2.0
EVEN_TOLERANCE_SHARE = 0.02


# ---- les frontières, à l'assemblage -----------------------------------------------------------------


def boundary_features(groups: list, sim, first_interval: bool) -> list[dict]:
    """Une mesure par scène de `groups` (les plans d'une plage analysée d'un seul tenant, regroupés par
    `shots.group_scenes`) : la frontière à son début. `sim` : la ressemblance de couleurs de l'assemblage
    (`shots.Similarity`). `first_interval` : cette plage commence le fichier."""
    out: list[dict] = []
    for i, cur in enumerate(groups):
        t = round(cur[0].start, 3)
        if i == 0:
            out.append({"t": t, "first": True} if first_interval else {"t": t, "gap": True})
            continue
        prev = groups[i - 1]
        st = cur[0].start
        before: set[int] = set()
        after: set[int] = set()
        for r in prev:
            if r.end > st - PEOPLE_WINDOW_S:
                before |= r.clusters
        for r in cur:
            if r.start < st + PEOPLE_WINDOW_S:
                after |= r.clusters
        union = before | after
        out.append({
            "t": t,
            "sim": round(float(sim.scenes(prev, cur)), 3),
            "fb": len(before),
            "fa": len(after),
            "fj": round(len(before & after) / len(union), 3) if union else None,
        })
    return out


# ---- la parole -------------------------------------------------------------------------------------


def speech_runs(regions: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Les zones de parole fusionnées quand moins de `SPEECH_JOIN_S` les sépare."""
    out: list[list[float]] = []
    for s, e in sorted(regions):
        if out and s - out[-1][1] <= SPEECH_JOIN_S:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([float(s), float(e)])
    return [(a, b) for a, b in out]


def speech_across(runs: list[tuple[float, float]], t: float) -> tuple[float, float] | None:
    """La prise de parole qui traverse l'instant `t`, s'il y en a une."""
    for s, e in runs:
        if s < t - SPEECH_CROSS_MARGIN_S and e > t + SPEECH_CROSS_MARGIN_S:
            return (s, e)
        if s > t:
            break
    return None


def speech_share(runs: list[tuple[float, float]], spans: list[tuple[float, float]]) -> float | None:
    """La part du temps analysé (`spans`, les scènes) où l'on parle."""
    total = sum(max(0.0, b - a) for a, b in spans)
    if total <= 0:
        return None
    spoken = 0.0
    for a, b in spans:
        for s, e in runs:
            if e <= a:
                continue
            if s >= b:
                break
            spoken += min(b, e) - max(a, s)
    return round(min(1.0, spoken / total), 4)


# ---- les chapitres ---------------------------------------------------------------------------------

_GENERIC_TITLE = re.compile(
    r"^\s*(?:(?:chapter|chapitre|chap\.?|cap[ií]tulo|kapitel|capitolo|hoofdstuk)\s*)?0*\d+\s*$"
    r"|^\s*\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*$",
    re.IGNORECASE,
)
_MARKER_TITLE = re.compile(
    r"^\s*(?:intro|introduction|opening(?: credits| titles)?|ouverture|g[ée]n[ée]rique(?: de (?:d[ée]but|fin))?"
    r"|(?:end |closing |opening )?credits|cr[ée]dits|recap|r[ée]cap|previously(?: on)?|pr[ée]c[ée]demment"
    r"|outro|ending|end|fin|preview|next time|aper[çc]u|prologue|[ée]pilogue|main|main content|content|contenu"
    r"|episode|[ée]pisode|film|movie|feature|programme|program)\s*$",
    re.IGNORECASE,
)
_MARKER_STRONG = re.compile(r"intro|opening|ouverture|g[ée]n[ée]rique|credits|cr[ée]dits|recap|r[ée]cap|previously|"
                            r"pr[ée]c[ée]demment|outro|ending|preview", re.IGNORECASE)


def parse_chapters(ffprobe_json: dict) -> list[dict]:
    out = []
    for c in ffprobe_json.get("chapters") or []:
        try:
            start = float(c.get("start_time"))
            end = float(c.get("end_time"))
        except (TypeError, ValueError):
            continue
        title = ((c.get("tags") or {}).get("title") or "").strip()
        out.append({"start": round(start, 3), "end": round(end, 3), "title": title[:120]})
    out.sort(key=lambda c: c["start"])
    return out


def classify_chapters(chapters: list[dict]) -> str:
    """`auteur` (placés par qui a monté le disque : à des débuts de scène), `automatique` (à intervalles
    égaux, ou « Chapter N » toutes les N minutes rondes : un outil, pas un auteur), `marqueurs` (intro,
    générique, épisode : des repères de segments, pas de scènes), `aucun` (zéro ou un)."""
    if len(chapters) <= 1:
        return "aucun"
    titles = [c["title"] for c in chapters]
    if all(t and _MARKER_TITLE.match(t) for t in titles) and any(_MARKER_STRONG.search(t) for t in titles):
        return "marqueurs"
    starts = [c["start"] for c in chapters]
    diffs = [b - a for a, b in zip(starts, starts[1:])]
    if len(diffs) >= 2:
        med = statistics.median(diffs)
        if med > 0 and max(diffs) - min(diffs) <= max(EVEN_TOLERANCE_S, EVEN_TOLERANCE_SHARE * med):
            return "automatique"
    generic = all((not t) or _GENERIC_TITLE.match(t) for t in titles)
    if generic and len(starts) >= 3:
        inner = [s for s in starts if s > 0.5]
        if inner and all(min(s % 60.0, 60.0 - s % 60.0) <= 1.0 for s in inner):
            return "automatique"
    return "auteur"


def probe_chapters(path: str) -> dict:
    """Les chapitres du fichier par ffprobe (l'en-tête seul : quelques dizaines de millisecondes). Ne lève
    jamais : `{"chapters": [...]}` ou `{"error": "…"}`."""
    try:
        out = subprocess.run([settings.ffprobe, "-v", "error", "-show_chapters", "-of", "json", path],
                             capture_output=True, text=True, timeout=30)
        if out.returncode != 0:
            return {"error": f"ffprobe : {out.stderr.strip()[-200:]}"}
        return {"chapters": parse_chapters(json.loads(out.stdout or "{}"))}
    except Exception as e:  # le fichier peut avoir disparu : jamais une raison d'échouer
        return {"error": f"{type(e).__name__}: {e}"[:200]}


def store_chapters(db, item_id: str, path: str) -> dict:
    doc = probe_chapters(path)
    db.run("UPDATE items SET chapters_json=? WHERE item_id=?", (json.dumps(doc, ensure_ascii=False), item_id))
    return doc


def chapters_of(doc: dict | None) -> tuple[str, list[float]]:
    """Le genre des chapitres et, pour des chapitres d'auteur, leurs débuts (le premier, à 0, exclu)."""
    if doc is None:
        return "inconnu", []
    if "error" in doc:
        return "illisible", []
    chs = doc.get("chapters") or []
    kind = classify_chapters(chs)
    if kind != "auteur":
        return kind, []
    return kind, [c["start"] for c in chs if c["start"] > CHAPTER_ALIGN_S]


# ---- la décision, à la lecture ---------------------------------------------------------------------


def decide(scenes: list[dict], bounds: list[dict], runs: list[tuple[float, float]],
           chapter_starts: list[float]) -> list[dict | None]:
    """Pour chaque scène de `scenes` (le résultat servi), `{"entry", "cut": {"ok", "why"}}` — ou `None` si sa
    frontière n'a pas de mesure (un résultat d'avant, regroupé autrement)."""
    by_t = {round(b["t"], 3): b for b in bounds}
    out: list[dict | None] = []
    for i, sc in enumerate(scenes):
        t = round(float(sc["start"]), 3)
        b = by_t.get(t)
        if b is None:
            out.append(None)
            continue
        cross = speech_across(runs, t)
        entry = round(cross[0], 3) if cross and t - cross[0] <= SPEECH_SNAP_S else t
        if b.get("first"):
            cut = (True, "début")
        elif b.get("gap"):
            cut = (True, "après-saut")
        elif any(abs(t - c) <= CHAPTER_ALIGN_S for c in chapter_starts):
            cut = (True, "chapitre")
        elif cross and t - cross[0] > SPEECH_SNAP_S:
            cut = (False, "parole")
        else:
            prev_len = float(scenes[i - 1]["end"]) - float(scenes[i - 1]["start"]) if i > 0 else 0.0
            cur_len = float(sc["end"]) - float(sc["start"])
            fb, fa, fj, sim = b.get("fb", 0), b.get("fa", 0), b.get("fj"), b.get("sim")
            if prev_len < MONTAGE_MAX_S and cur_len < MONTAGE_MAX_S and fb == 0 and fa == 0 and not cross:
                cut = (False, "montage")
            elif (sim is not None and sim <= SIM_MAX and fj is not None and fj <= FACE_JACCARD_MAX
                  and fb >= FACE_GROUPS_MIN and fa >= FACE_GROUPS_MIN):
                cut = (True, "deux-signaux")
            else:
                cut = (False, "même-lieu")
        out.append({"entry": entry, "cut": {"ok": cut[0], "why": cut[1]}})
    # Îlot : une scène acceptée aux deux signaux, courte, entre deux frontières refusées (dans l'ordre,
    # une frontière déjà devenue îlot compte comme refusée — la règle mesurée le 10/11/2026).
    for i in range(1, len(out) - 1):
        cur, before, after = out[i], out[i - 1], out[i + 1]
        if cur is None or before is None or after is None:
            continue
        length = float(scenes[i]["end"]) - float(scenes[i]["start"])
        if (cur["cut"]["why"] == "deux-signaux" and not before["cut"]["ok"] and not after["cut"]["ok"]
                and length < ISLAND_MAX_S):
            cur["cut"] = {"ok": False, "why": "îlot"}
    return out


def speech_known(db, item_id: str, etag: str) -> bool:
    """Les zones de parole sont-elles complètes pour ce fichier (« qui parle » fini, son seul compris) ?"""
    row = db.one("SELECT complete, etag FROM voice_results WHERE item_id=?", (item_id,))
    return row is not None and bool(row["complete"]) and row["etag"] == etag


def annotate(db, res) -> dict | None:
    """Les ajouts de `/scenes` pour le résultat `res` (une ligne de `results`) : `{"scenes": [extras…],
    "speechShare", "chapters", "cutsVersion"}`, ou `None` — résultat partiel, ou pas encore mesuré. Ne lève
    jamais : un ajout ne fait pas échouer la lecture des scènes."""
    try:
        if not res["complete"] or not res["bounds_json"]:
            return None
        doc = json.loads(res["bounds_json"])
        if int(doc.get("v", 0)) != CUTS_VERSION:
            return None
        scenes = json.loads(res["scenes_json"])
        item = db.one("SELECT chapters_json FROM items WHERE item_id=?", (res["item_id"],))
        ch_doc = json.loads(item["chapters_json"]) if item is not None and item["chapters_json"] else None
        kind, starts = chapters_of(ch_doc)
        count = len((ch_doc or {}).get("chapters") or [])
        spans = [(float(s["start"]), float(s["end"])) for s in scenes]
        if not speech_known(db, res["item_id"], res["etag"]):
            return {"scenes": [None] * len(scenes), "speechShare": None, "cutsVersion": CUTS_VERSION,
                    "chapters": {"kind": kind, "count": count, "aligned": 0}}
        regions = [(r["start"], r["end"]) for r in
                   db.q("SELECT start, end FROM voice_regions WHERE item_id=? ORDER BY start", (res["item_id"],))]
        runs = speech_runs(regions)
        extras = decide(scenes, doc.get("bounds") or [], runs, starts)
        aligned = sum(1 for x in extras if x is not None and x["cut"]["why"] == "chapitre")
        return {"scenes": extras, "speechShare": speech_share(runs, spans), "cutsVersion": CUTS_VERSION,
                "chapters": {"kind": kind, "count": count, "aligned": aligned}}
    except Exception:
        log.exception("[xray] %s : débuts de scène illisibles", res["item_id"])
        return None


# ---- la mesure des résultats d'avant ----------------------------------------------------------------


def bounds_doc(bounds: list[dict]) -> str:
    return json.dumps({"v": CUTS_VERSION, "bounds": bounds}, separators=(",", ":"))


def next_backfill(db):
    """Un élément fini dont le résultat complet n'a pas de mesure des frontières à la version du jour, ou
    dont les chapitres n'ont jamais été lus."""
    return db.one(
        """SELECT i.* FROM items i JOIN results r ON r.item_id = i.item_id
           WHERE i.status='done' AND r.complete=1 AND r.etag = i.etag
             AND (r.bounds_json IS NULL OR r.bounds_json NOT LIKE ? OR i.chapters_json IS NULL)
           ORDER BY i.updated DESC LIMIT 1""",
        (f'{{"v":{CUTS_VERSION},%',),
    )


def backfill_item(db, row) -> dict:
    """Mesure les frontières d'un résultat déjà servi, **sans le changer** : regroupement des pistes et des
    plans refait depuis la base (comme le renommage), mais seules les mesures sont écrites — les scènes, leurs
    personnes et la version restent celles du résultat. Une frontière regroupée autrement qu'à l'époque (un
    résultat d'une version antérieure) reste sans mesure. Lit aussi les chapitres du fichier, une fois."""
    from .relabel import rebuild_bounds

    item_id, etag = row["item_id"], row["etag"]
    out = {"itemId": item_id}
    if row["chapters_json"] is None:
        doc = store_chapters(db, item_id, row["path"])
        out["chapters"] = "error" if "error" in doc else len(doc.get("chapters") or [])
    res = db.one("SELECT bounds_json, scenes_json FROM results WHERE item_id=?", (item_id,))
    if res is not None and not (res["bounds_json"] or "").startswith(f'{{"v":{CUTS_VERSION},'):
        bounds = rebuild_bounds(db, row)
        stored = {round(float(s["start"]), 3) for s in json.loads(res["scenes_json"])}
        kept = [b for b in bounds if round(b["t"], 3) in stored]
        with db.tx() as c:
            cur = c.execute("SELECT etag FROM items WHERE item_id=?", (item_id,)).fetchone()
            if cur is None or cur["etag"] != etag:
                return {**out, "skipped": "fichier changé"}
            c.execute("UPDATE results SET bounds_json=? WHERE item_id=? AND etag=?", (bounds_doc(kept), item_id, etag))
        out["bounds"] = len(kept)
        out["unmatched"] = len(bounds) - len(kept)
    return out


def backfill_some(db, budget_s: float = 10.0, should_stop=lambda: False) -> int:
    """Quelques éléments, dans un budget de temps ; rend combien ont été faits."""
    t0 = time.monotonic()
    n = 0
    while time.monotonic() - t0 < budget_s and not should_stop():
        row = next_backfill(db)
        if row is None:
            break
        try:
            backfill_item(db, row)
        except Exception:
            # Jamais en boucle sur le même : noté mesuré (sans frontière) et lu (illisible).
            log.exception("[xray] %s : mesure des débuts de scène impossible", row["item_id"])
            db.run("UPDATE results SET bounds_json=? WHERE item_id=?", (bounds_doc([]), row["item_id"]))
            db.run("UPDATE items SET chapters_json=COALESCE(chapters_json, ?) WHERE item_id=?",
                   (json.dumps({"error": "mesure impossible"}), row["item_id"]))
        n += 1
    return n
