"""Assemble public/assets/lightmaps/lightmaps.json depuis les résultats par atlas (assets-src/bake/work/<groupe>.json)."""
import json, os, datetime
work, out = "assets-src/bake/work", "public/assets/lightmaps"
cal = json.load(open(f"{work}/calibration.json"))
scene = json.load(open("assets-src/bake/scene.json"))
atlases = {}
for g in ("salon", "sud", "nuit", "sofa"):
    p = f"{work}/{g}.json"
    if os.path.exists(p) and os.path.exists(f"{out}/{g}.ktx2"):
        atlases[g] = json.load(open(p))["atlas"]
doc = {
    "range": scene["range"],
    "atlases": atlases,
    "lights": {"bakeToE": cal["bakeToE"], "pointWattsPerIntensity": round(cal["point"], 5), "sunStrengthPerIntensity": round(cal["sun"], 5),
               "skyStrengthPerIrradiance": round(cal["sky"], 5), "check": cal["check"]},
    "generated": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
json.dump(doc, open(f"{out}/lightmaps.json", "w"), indent=1)
print("lightmaps.json :", ", ".join(atlases))
