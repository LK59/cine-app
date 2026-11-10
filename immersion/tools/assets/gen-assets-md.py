#!/usr/bin/env python3
"""Régénère ASSETS.md à la racine de immersion/ depuis manifest.json, assets-src/*/info.json
et public/assets/manifest.json.   Usage : python3 -I tools/assets/gen-assets-md.py"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
manifest = json.load(open(os.path.join(HERE, "manifest.json")))["assets"]
built_p = os.path.join(ROOT, "public/assets/manifest.json")
built = {a["id"]: a for a in json.load(open(built_p))["assets"]} if os.path.exists(built_p) else {}
total = json.load(open(built_p)).get("totalBytes", 0) if os.path.exists(built_p) else 0


def info(slug):
    p = os.path.join(ROOT, "assets-src", slug, "info.json")
    return json.load(open(p)) if os.path.exists(p) else {}


def mb(b):
    return f"{b / 1e6:.1f} Mo" if b >= 1e5 else f"{b / 1e3:.0f} Ko"


def row(a):
    i = info(a["slug"])
    name = i.get("name", a["slug"])
    authors = ", ".join(i.get("authors", [])) or "inconnu"
    src = f"[{a['slug']}](https://polyhaven.com/a/{a['slug']})"
    b = built.get(a["id"])
    if a.get("skip"):
        files = f"non produit : {a['skip']}"
    elif not b:
        files = "non construit"
    elif a["kind"] == "textures":
        files = f"`textures/{a['id']}/` : color, normal, arm (.ktx2), {mb(b['bytes'])}"
    elif a["kind"] == "model":
        n = len([f for f in b["files"] if f["path"].endswith(".ktx2")])
        files = f"`models/{a['id']}/{a['id']}.gltf` + .bin + {n} .ktx2, {b.get('triangles', '?')} triangles, {mb(b['bytes'])}"
    else:
        files = ", ".join(f"`{f['path']}`" for f in b["files"]) + f", {mb(b['bytes'])}"
    return f"| {name} (`{a['id']}`) | {src} | {authors} | CC0 1.0 | {a.get('use', '')} | {files} |"


head = "| Nom | Source | Auteur(s) | Licence | Usage | Fichiers produits |\n|---|---|---|---|---|---|"
out = ["# Assets de l'Immersion", "",
       "Tout ce qui est listé ici est sous licence **CC0 1.0** (domaine public) : on peut l'utiliser, le modifier et le redistribuer sans condition, même pour un usage commercial. La mention de l'auteur n'est pas obligatoire, mais on la garde par courtoisie.",
       "",
       "Les sources sont toutes sur [Poly Haven](https://polyhaven.com), qui publie uniquement du CC0. Aucun autre site ni aucune autre licence.",
       "",
       "Ce fichier est généré : ne pas l'éditer à la main. Il vient de `tools/assets/manifest.json` et des fiches `assets-src/*/info.json`. Pour le refaire : `python3 -I tools/assets/gen-assets-md.py`. Les commandes pour tout reconstruire sont dans `tools/assets/README.md`.",
       "",
       f"Poids total de `public/assets/` : **{total / 1e6:.1f} Mo**." if total else "", ""]
for kind, title in (("textures", "Textures"), ("model", "Modèles 3D"), ("hdri", "Ciels (HDRI)")):
    items = [a for a in manifest if a["kind"] == kind]
    out += [f"## {title} ({len(items)})", "", head] + [row(a) for a in items] + [""]
    if kind == "textures":
        out += ["Chaque texture existe en trois cartes : `color` (sRGB), `normal` (convention OpenGL) et `arm` (occlusion en rouge, rugosité en vert, métal en bleu).", "",
                "Alternatives écartées (au cas où on change d'avis) :", ""]
        for a in items:
            out.append(f"- `{a['id']}` : " + ", ".join(f"[{s}](https://polyhaven.com/a/{s})" for s in a.get("alternates", [])))
        out.append("")
    if kind == "hdri":
        out += ["Le `.hdr` (1k) sert à l'éclairage. Le `_bg.jpg` (4096 px de large) sert de ciel visible.", ""]
    if kind == "model":
        out += ["Géométrie compressée en meshopt, textures en KTX2 (aucune ressource embarquée). La page doit donc fournir un décodeur meshopt et un transcodeur KTX2.", ""]
open(os.path.join(ROOT, "ASSETS.md"), "w", encoding="utf-8").write("\n".join(out).rstrip() + "\n")
print("ASSETS.md écrit")
