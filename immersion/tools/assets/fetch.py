#!/usr/bin/env python3
"""Télécharge les sources brutes décrites par manifest.json dans assets-src/<slug>/.
Usage : python3 -I tools/assets/fetch.py [--only id,id]   (stdlib uniquement)
Les fichiers déjà présents sont conservés. Rien de ce qui est téléchargé n'est exécuté."""
import hashlib, json, os, sys, time, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SRC = os.path.join(ROOT, "assets-src")
UA = {"User-Agent": "asset-fetch/1.0"}
API = "https://api.polyhaven.com"


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return r.read()
        except Exception as e:
            if i == tries - 1:
                raise
            time.sleep(2 * (i + 1))


def jget(url):
    return json.loads(get(url))


def download(url, dest, md5=None):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    data = get(url)
    if md5 and hashlib.md5(data).hexdigest() != md5:
        raise RuntimeError(f"md5 différent pour {url}")
    with open(dest + ".part", "wb") as f:
        f.write(data)
    os.replace(dest + ".part", dest)


def write_info(slug, source):
    p = os.path.join(SRC, slug, "info.json")
    if os.path.exists(p):
        return
    i = jget(f"{API}/info/{slug}")
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump({
        "slug": slug, "name": i.get("name", slug), "authors": list(i.get("authors", {}).keys()),
        "licence": "CC0 1.0", "licence_url": "https://creativecommons.org/publicdomain/zero/1.0/",
        "url": f"https://polyhaven.com/a/{slug}", "source": source,
        "categories": i.get("categories", []), "tags": i.get("tags", []),
        "polycount": i.get("polycount"),
    }, open(p, "w"), indent=1, ensure_ascii=False)


def pick(entry, prefs=("png", "jpg")):
    for fmt in prefs:
        if fmt in entry:
            return entry[fmt]
    raise KeyError("format absent")


def fetch_texture(a):
    slug, res = a["slug"], a["resolution"]
    files = jget(f"{API}/files/{slug}")
    d = os.path.join(SRC, slug)
    want = {"Diffuse": "diffuse", "nor_gl": "nor_gl"}
    if "arm" in files:
        want["arm"] = "arm"
    else:  # pas de carte ARM : on récupère les cartes séparées, build.mjs les empaquette
        for k, n in (("AO", "ao"), ("Rough", "rough"), ("Metal", "metal")):
            if k in files:
                want[k] = n
    for key, name in want.items():
        f = pick(files[key][res])
        ext = "png" if f["url"].endswith(".png") else "jpg"
        download(f["url"], os.path.join(d, f"{name}_{res}.{ext}"), f.get("md5"))
    write_info(slug, "polyhaven")


def fetch_model(a):
    slug = a["slug"]
    files = jget(f"{API}/files/{slug}")
    g = files["gltf"][a["resolution"]]["gltf"]
    d = os.path.join(SRC, slug)
    download(g["url"], os.path.join(d, f"{slug}.gltf"), g.get("md5"))
    for rel, f in g.get("include", {}).items():
        download(f["url"], os.path.join(d, rel), f.get("md5"))
    # cartes supplémentaires demandées par le manifeste (ex. opacité des feuillages, absente du glTF)
    for key in a.get("alphaMaps", {}).values():
        f = pick(files[key][a["resolution"]])
        ext = "png" if f["url"].endswith(".png") else "jpg"
        download(f["url"], os.path.join(d, "extra", f"{key}_{a['resolution']}.{ext}"), f.get("md5"))
    write_info(slug, "polyhaven")


def fetch_hdri(a):
    slug = a["slug"]
    files = jget(f"{API}/files/{slug}")
    d = os.path.join(SRC, slug)
    h = files["hdri"][a["resolution"]]["hdr"]
    download(h["url"], os.path.join(d, f"{slug}_{a['resolution']}.hdr"), h.get("md5"))
    t = files.get("tonemapped")
    if t:
        download(t["url"].replace(" ", "%20"), os.path.join(d, f"{slug}_tonemapped.jpg"), t.get("md5"))
    write_info(slug, "polyhaven")


def fetch_thumb(slug):
    download(f"https://cdn.polyhaven.com/asset_img/thumbs/{slug}.png?width=256&height=256",
             os.path.join(SRC, "_thumbs", f"{slug}.png"))


def fetch_alt_diffuse(slug):
    """Couleur 1k des alternatives, pour la planche-contact seulement (ignoré si absent)."""
    try:
        files = jget(f"{API}/files/{slug}")
        f = files["Diffuse"]["1k"]["jpg"]
    except Exception as e:
        print("alternative sans couleur", slug, repr(e))
        return
    download(f["url"], os.path.join(SRC, "_alt", f"{slug}_diffuse_1k.jpg"), f.get("md5"))


def run(a):
    try:
        if a["source"] != "polyhaven":
            raise NotImplementedError(a["source"])
        {"textures": fetch_texture, "model": fetch_model, "hdri": fetch_hdri}[a["kind"]](a)
        return a["id"], None
    except Exception as e:
        return a["id"], repr(e)


if __name__ == "__main__":
    m = json.load(open(os.path.join(HERE, "manifest.json")))["assets"]
    m = [a for a in m if not a.get("skip")]
    if "--only" in sys.argv:
        only = set(sys.argv[sys.argv.index("--only") + 1].split(","))
        m = [a for a in m if a["id"] in only]
    thumbs = {a["slug"] for a in m} | {s for a in m for s in a.get("alternates", [])}
    with ThreadPoolExecutor(6) as ex:
        res = list(ex.map(run, m))
        list(ex.map(lambda s: fetch_thumb(s), sorted(thumbs)))
        alts = sorted({s for a in m if a["kind"] == "textures" for s in a.get("alternates", [])})
        list(ex.map(fetch_alt_diffuse, alts))
        # infos des alternatives (pour le tableau de choix)
        for a in m:
            for s in a.get("alternates", []):
                try:
                    write_info(s, "polyhaven")
                except Exception:
                    pass
    bad = [(i, e) for i, e in res if e]
    for i, e in bad:
        print("ÉCHEC", i, e)
    print(f"{len(res) - len(bad)}/{len(res)} ok")
    sys.exit(1 if bad else 0)
