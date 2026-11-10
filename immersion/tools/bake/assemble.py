"""Assemble public/assets/lightmaps/lightmaps.json depuis les résultats par atlas (assets-src/bake/work/<groupe>.json)."""
import json, os, datetime
work, out = "assets-src/bake/work", "public/assets/lightmaps"
cal = json.load(open(f"{work}/calibration.json"))
scene = json.load(open("assets-src/bake/scene.json"))
atlases = {}
total = 0
for g in ("salon", "sud", "nuit", "sofa"):
    p = f"{work}/{g}.json"
    if not os.path.exists(p):
        continue
    a = json.load(open(p))["atlas"]
    # une couche n'est annoncée que si son KTX2 existe ; les KTX2 d'une couche invalidée sont retirés
    a["layers"] = {l: v for l, v in a.get("layers", {}).items() if os.path.exists(f"{out}/{v['texture']}")}
    keep = {v["texture"] for v in a["layers"].values()}
    for stale in (f"{g}.ktx2", f"{g}_lampes.ktx2"):
        if stale not in keep and os.path.exists(f"{out}/{stale}"):
            os.remove(f"{out}/{stale}")
    if "nuit" not in a["layers"]:
        continue
    a["texture"] = a["layers"]["nuit"]["texture"]
    total += sum(os.path.getsize(f"{out}/{v['texture']}") for v in a["layers"].values())
    atlases[g] = a
doc = {
    "range": next(iter(atlases.values()))["layers"]["nuit"]["range"],   # ancienne lecture : la portée de la couche nuit du premier atlas
    "atlases": atlases,
    "lights": {"bakeToE": cal["bakeToE"], "pointWattsPerIntensity": round(cal["point"], 5), "sunStrengthPerIntensity": round(cal["sun"], 5),
               "skyStrengthPerIrradiance": round(cal["sky"], 5), "check": cal["check"]},
    "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
json.dump(doc, open(f"{out}/lightmaps.json", "w"), indent=1)
print("lightmaps.json :", ", ".join(atlases), f"; KTX2 au total : {total} octets" + ("  (> 9 Mo !)" if total > 9_000_000 else ""))
