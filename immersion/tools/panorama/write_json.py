# Writes public/assets/panorama/panorama.json (python3 -I, from immersion/).
import json, os, re, sys
sys.path.insert(0, "tools/panorama")
import params as P
extra = json.load(open("tools/assets/extra-assets.json"))["assets"][0]
layers = {}
for k, (lo, hi, w, h) in P.LAYERS.items():
    # La hauteur encodée est ramenée au multiple de 4 supérieur (fit4.mjs) : les textures compressées l'exigent.
    layers[k] = {"file": f"{k}.ktx2", "width": w, "height": -(-h // 4) * 4, "from": lo}
terrain = float(open("assets-src/panorama/final/out/terrain_z.txt").read())
doc = {"elevationMin": P.EL_MIN, "elevationMax": P.EL_MAX, "layers": layers,
       "main": {"lat": P.LAT, "lon": P.LON, "altitude": round(terrain, 1), "headingDeg": P.HEADING},
       "moon": {"azimuthDeg": P.MOON_AZ, "elevationDeg": P.MOON_EL},
       "sky": {"horizon": list(P.SKY_HORIZON), "zenith": list(P.SKY_ZENITH)},
       "moonColor": list(P.MOON_COLOR),
       "attribution": extra["attribution"],
       "disclaimer": extra["disclaimer"]}
json.dump(doc, open("public/assets/panorama/panorama.json", "w"), indent=2); print(json.dumps(doc, indent=2))
