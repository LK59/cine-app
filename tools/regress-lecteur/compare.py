#!/usr/bin/env python3
"""Compare deux passages normalisés du banc : un écart par navigateur et par titre, sortie 1 s'il y en a.

`=` identique, `≠` écart (compté), `~` écart sur un couple titre × profil marqué instable dans
titres.json (affiché, pas compté), `·` couple qu'un des deux passages n'avait pas prévu de jouer
(passage partiel : mode rapide, REGRESS_ONLY, REGRESS_PROFILES — son `plan.json`), ni affiché en
détail ni compté. Les compteurs `volatil` (attentes, blocages, reprises) sont
montrés à côté d'un écart, pour le lire, et ne sont jamais comparés.

Usage : compare.py <résultats A> <résultats B>
"""
import difflib
import json
import os
import sys


def lines_of(case):
    if case is None:
        return ["(absent de ce passage)"]
    out = [f'étape   {s["step"]}: {s["outcome"]}' + (f' [{s["source"]}]' if s.get("source") else "")
           + (f' ({s["pistes"]} pistes)' if "pistes" in s else "") for s in case["steps"]]
    out += ["journal " + json.dumps(l, ensure_ascii=False, sort_keys=True) for l in case["lines"]]
    out += ["serveur " + json.dumps(l, ensure_ascii=False, sort_keys=True) for l in case["server"]]
    return out


def main():
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    a_dir, b_dir = sys.argv[1], sys.argv[2]
    a = json.load(open(os.path.join(a_dir, "normalise.json")))
    b = json.load(open(os.path.join(b_dir, "normalise.json")))
    differ = tolerated = skipped = 0

    def plan(d, n):
        try:
            return set(json.load(open(os.path.join(d, "plan.json"))))
        except OSError:
            return set(n)  # passage d'avant plan.json : tout ce qu'il a joué était prévu

    pa, pb = plan(a_dir, a), plan(b_dir, b)
    for key in sorted(set(a) | set(b)):
        if key not in pa or key not in pb:
            skipped += 1
            print(f"·  {key}  (pas prévu dans {'A' if key not in pa else 'B'})")
            continue
        la, lb = lines_of(a.get(key)), lines_of(b.get(key))
        if la == lb:
            print(f"=  {key}")
            continue
        unstable = bool((a.get(key) or {}).get("instable") or (b.get(key) or {}).get("instable"))
        if unstable:
            tolerated += 1
            print(f"~  {key}  (instable connu, non compté)")
        else:
            differ += 1
            print(f"≠  {key}")
        va, vb = (a.get(key) or {}).get("volatil"), (b.get(key) or {}).get("volatil")
        print(f"     volatil A {va} · B {vb}")
        for d in difflib.unified_diff(la, lb, fromfile=a_dir, tofile=b_dir, lineterm="", n=1):
            print("     " + d)
    total = len(set(a) | set(b)) - skipped
    print(f"\n{total - differ - tolerated} identiques, {differ} différents, {tolerated} instables connus"
          + (f", {skipped} non prévus d'un côté" if skipped else ""))
    return 1 if differ else 0


if __name__ == "__main__":
    sys.exit(main())
