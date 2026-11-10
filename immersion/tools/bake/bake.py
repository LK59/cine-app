"""
Cuisson de la lumière du chalet (Blender, Cycles CPU) -> lightmaps pour la page (three.js `lightMap`).
Lancé par tools/bake/bake.sh ; voir tools/bake/README.md.

    blender -b --python tools/bake/bake.py -- --calibrate
    blender -b --python tools/bake/bake.py -- --group salon [--sofa f.glb] [--samples 384]
    blender -b --python tools/bake/bake.py -- --preview [--sofa f.glb] [--exposure 1.0]

Repère : glTF (X est, Y haut, Z sud, mètres) -> Blender (Z haut) par (x, y, z) -> (x, -z, y) pour les positions
ET les directions de lumière (g2b ci-dessous) ; rotation propre, l'orientation des faces ne change pas.

Orientation de l'image : l'image de Blender a son origine en bas à gauche (v_b = 0 = dernière ligne du fichier).
La page échantillonne avec flipY = false : v = 0 est la PREMIÈRE ligne (haut) du fichier. On écrit donc
    v_page = 1 - v_b       (uv.bin)
    et le PNG est écrit de haut en bas (np.flipud des pixels de Blender).
Les deux se compensent ; `verify_flip` le recalcule sur le PNG écrit, avec les UV du fichier uv.bin.
"""
import bpy, sys, os, json, math, time, struct, datetime
import numpy as np
from mathutils import Vector

ROOT = os.getcwd()
SRC = os.path.join(ROOT, "assets-src", "bake")
WORK = os.path.join(SRC, "work")
OUT = os.path.join(ROOT, "public", "assets", "lightmaps")
PREV = os.path.join(ROOT, "tools", "bake", "previews")
os.makedirs(WORK, exist_ok=True)

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def opt(name, default=None, cast=str):
    if name in argv:
        return cast(argv[argv.index(name) + 1])
    return default
CALIBRATE = "--calibrate" in argv
PREVIEW = "--preview" in argv
GROUP = opt("--group")
SOFA = opt("--sofa")
SAMPLES = opt("--samples", 384, int)
EXPOSURE = opt("--exposure", 0.0, float)
PACK_MARGIN_PX = opt("--margin", 6, int)
BAKE_MARGIN_PX = 6
THREADS = opt("--threads", 5, int)
TEXEL_METAL = 0.5          # échelle linéaire des îlots de la matière `metal`
SOFA_ALBEDO = {"sofa": [0.62, 0.54, 0.44], "pillows": [0.3, 0.24, 0.18]}
SNOW = [0.8, 0.85, 0.95]
PI = math.pi

def log(*a):
    print("[bake]", *a, flush=True)

def g2b(p):
    return (p[0], -p[2], p[1])

def b2g(p):
    return (p[0], p[2], -p[1])

# ---------------------------------------------------------------- scène

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    cy = sc.cycles
    cy.device = "CPU"
    cy.samples = SAMPLES
    cy.use_denoising = False
    cy.use_adaptive_sampling = True
    cy.adaptive_threshold = 0.005
    cy.adaptive_min_samples = 32
    cy.max_bounces = 6
    cy.diffuse_bounces = 4
    cy.glossy_bounces = 0
    cy.transmission_bounces = 0
    cy.transparent_max_bounces = 0
    cy.caustics_reflective = False
    cy.caustics_refractive = False
    cy.sample_clamp_indirect = 50.0
    cy.sample_clamp_direct = 0.0
    sc.render.threads_mode = "FIXED"
    sc.render.threads = THREADS
    sc.view_settings.view_transform = "Standard"
    return sc

def diffuse_material(name, albedo, image=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    d = nt.nodes.new("ShaderNodeBsdfDiffuse")
    d.inputs["Color"].default_value = (albedo[0], albedo[1], albedo[2], 1.0)
    nt.links.new(d.outputs["BSDF"], out.inputs["Surface"])
    if image is not None:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = image
        nt.nodes.active = t
        t.select = True
    return m

def parse_obj(path):
    """Positions (glTF) et normales par sommet, dans l'ordre des lignes `v` / `vn` ; vérifie f = 3k+1, 3k+2, 3k+3."""
    V, N = [], []
    nf = 0
    with open(path) as f:
        for line in f:
            if line.startswith("v "):
                V.append(line.split()[1:4])
            elif line.startswith("vn "):
                N.append(line.split()[1:4])
            elif line.startswith("f "):
                idx = [int(t.split("/")[0]) for t in line.split()[1:]]
                if idx != [3 * nf + 1, 3 * nf + 2, 3 * nf + 3]:
                    raise SystemExit(f"{path} : le triangle {nf} n'est pas (3k, 3k+1, 3k+2) : {idx}")
                nf += 1
    V = np.array(V, dtype=np.float64)
    N = np.array(N, dtype=np.float64)
    if len(V) != nf * 3:
        raise SystemExit(f"{path} : {len(V)} sommets pour {nf} triangles")
    return V, N

def make_object(name, V, albedo, collection=None):
    """Maillage en soupe de triangles : sommet i = ligne `v` i, boucle i = sommet i, triangle k = boucles 3k..3k+2."""
    n = len(V)
    co = np.stack([V[:, 0], -V[:, 2], V[:, 1]], axis=1)
    me = bpy.data.meshes.new(name)
    me.from_pydata(co.tolist(), [], [(3 * k, 3 * k + 1, 3 * k + 2) for k in range(n // 3)])
    me.update(calc_edges=True)   # pas de validate(), pas de fusion : l'ordre est le contrat
    ob = bpy.data.objects.new(name, me)
    (collection or bpy.context.scene.collection).objects.link(ob)
    me.materials.append(diffuse_material(name, albedo))
    return ob

def check_order(ob, V, probe=None):
    """Relit, par boucle, les positions de Blender et les compare aux lignes `v` de l'OBJ (et aux sondes de scene.json)."""
    me = ob.data
    n = len(V)
    assert len(me.vertices) == n and len(me.loops) == n, (ob.name, len(me.vertices), len(me.loops), n)
    vi = np.empty(n, dtype=np.int32)
    me.loops.foreach_get("vertex_index", vi)
    assert (vi == np.arange(n)).all(), f"{ob.name} : l'ordre des boucles n'est pas celui de l'OBJ"
    co = np.empty(n * 3, dtype=np.float64)
    me.vertices.foreach_get("co", co)
    co = co.reshape(n, 3)[vi]
    g = np.stack([co[:, 0], co[:, 2], -co[:, 1]], axis=1)
    err = np.abs(g - V).max()
    assert err < 1e-4, f"{ob.name} : écart max {err} m entre Blender et l'OBJ"
    out = None
    if probe is not None:
        out = [[round(float(x), 3) for x in g[i]] for i in (0, n // 2, n - 1)]
        for a, b in zip(out, probe):
            d = max(abs(x - y) for x, y in zip(a, b))
            assert d <= 0.001, f"{ob.name} : sonde {a} != {b}"
    return err, out

def add_lights(lights, factors):
    for L in lights:
        if L["type"] == "point":
            d = bpy.data.lights.new(L["name"], "POINT")
            d.energy = L["intensity"] * factors["point"]
            d.shadow_soft_size = L["radius"]
            ob = bpy.data.objects.new(L["name"], d)
            ob.location = g2b(L["position"])
        else:
            d = bpy.data.lights.new(L["name"], "SUN")
            d.energy = L["intensity"] * factors["sun"]
            d.angle = math.radians(L["angleDeg"])
            ob = bpy.data.objects.new(L["name"], d)
            direction = -Vector(g2b(L["from"])).normalized()   # vers l'origine
            ob.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
        d.color = L["color"][:3]
        d.use_shadow = True
        bpy.context.scene.collection.objects.link(ob)

def add_sky(color, irradiance, factors):
    w = bpy.data.worlds.new("sky")
    w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes["Background"]
    bg.inputs["Color"].default_value = (color[0], color[1], color[2], 1.0)
    bg.inputs["Strength"].default_value = irradiance * factors["sky"]
    bpy.context.scene.world = w

def add_ground():
    V = np.array([[-300, 0, -300], [300, 0, 300], [300, 0, -300], [-300, 0, -300], [-300, 0, 300], [300, 0, 300]], dtype=np.float64)
    V[:, 1] = -0.07
    return make_object("ground", V, SNOW)   # winding : normale vers le haut (vérifié par le test du sol)

# ---------------------------------------------------------------- étalonnage

def new_image(name, size):
    img = bpy.data.images.new(name, size, size, alpha=False, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    return img

def bake_selected(targets, margin):
    bpy.ops.object.select_all(action="DESELECT")
    for o in targets:
        o.select_set(True)
    bpy.context.view_layer.objects.active = targets[0]
    bpy.ops.object.bake(type="DIFFUSE", pass_filter={"DIRECT", "INDIRECT"}, margin=margin, margin_type="EXTEND", use_clear=True, target="IMAGE_TEXTURES")

def read_image(img):
    w, h = img.size
    a = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(h, w, 4)

def calibration_scene(kind, factors, size=256, spp=256):
    sc = reset()
    sc.cycles.samples = spp
    sc.cycles.use_adaptive_sampling = False
    sc.cycles.sample_clamp_indirect = 0.0
    img = new_image("cal", size)
    # plan blanc de 4 m, normale vers +Z de Blender (= +Y glTF), centré à l'origine
    ob = bpy.data.objects.new("plane", bpy.data.meshes.new("plane"))
    ob.data.from_pydata([(-2, -2, 0), (2, -2, 0), (2, 2, 0), (-2, 2, 0)], [], [(0, 1, 2, 3)])
    ob.data.update()
    ob.data.uv_layers.new(name="UVMap")
    ob.data.uv_layers[0].data.foreach_set("uv", [0, 0, 1, 0, 1, 1, 0, 1])
    ob.data.materials.append(diffuse_material("white", [1, 1, 1], img))
    sc.collection.objects.link(ob)
    if kind == "point":   # intensité 1, à 1 m au-dessus du centre
        add_lights([{"type": "point", "name": "p", "position": [0, 1, 0], "color": [1, 1, 1], "intensity": 1.0, "radius": 0.001}], factors)
    elif kind == "sun":   # intensité 1, incidence normale
        add_lights([{"type": "sun", "name": "s", "from": [0, 10, 0], "color": [1, 1, 1], "intensity": 1.0, "angleDeg": 0.5}], factors)
    else:                 # ciel seul, éclairement 1 sur une face tournée vers le haut
        add_sky([1, 1, 1], 1.0, factors)
    bake_selected([ob], 4)
    a = read_image(img)
    c = size // 2
    b = float(a[c - 1:c + 1, c - 1:c + 1, :3].mean())
    return b, a

def calibrate():
    """Le texel sous la lumière doit valoir E = 1 (unités de la page). E = b * PI (b = valeur de la cuisson « diffuse »,
    éclairage sans couleur, d'un blanc) ; les facteurs W_blender/unité_page en découlent (le tout est linéaire)."""
    guess = {"point": 4 * PI * PI, "sun": 1.0, "sky": 1.0 / PI}
    res = {"bakeToE": PI, "guess": guess}
    final = {}
    for kind in ("point", "sun", "sky"):
        b, _ = calibration_scene(kind, guess)
        e = b * PI
        final[kind] = guess[kind] / e
        log(f"étalonnage {kind}: b={b:.5f}  E mesuré={e:.5f} avec le facteur {guess[kind]:.5f}  ->  facteur {final[kind]:.5f}")
    for kind in ("point", "sun", "sky"):
        b, _ = calibration_scene(kind, final)
        res.setdefault("check", {})[kind] = round(b * PI, 4)
        log(f"vérification {kind}: E = {b * PI:.4f} (attendu 1)")
    res.update({"point": final["point"], "sun": final["sun"], "sky": final["sky"]})
    res["note"] = "stocké = b*bakeToE / range ; point : watts Blender par unité d'intensité de la page ; sun : force Blender par unité ; sky : force du fond par unité d'éclairement"
    json.dump(res, open(os.path.join(WORK, "calibration.json"), "w"), indent=1)
    return res

# ---------------------------------------------------------------- chargement

def load_scene_json():
    return json.load(open(os.path.join(SRC, "scene.json")))

def import_sofa(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    for o in meshes:
        key = "pillows" if o.name.startswith("pillows_") else "sofa"
        mats = []
        for i in range(max(1, len(o.material_slots))):
            mats.append(diffuse_material(f"{o.name}.{i}", SOFA_ALBEDO[key]))
        o.data.materials.clear()
        for m in mats:
            o.data.materials.append(m)
        layers = o.data.uv_layers
        lm = layers.get("lightmap") or (layers[1] if len(layers) > 1 else None)
        if lm is None:
            raise SystemExit(f"{o.name} : pas de second jeu d'UV (lightmap / TEXCOORD_1)")
        lm.active_render = True
        layers.active = lm
    return meshes

def build_world(scene, factors, sofa_path=None, only_group=None):
    """Toute la maison (tous les groupes), les occluders ou le vrai canapé, le sol de neige, les lumières, le ciel."""
    reset()
    objs = {}
    probes = {}
    errs = {}
    for g, grp in scene["groups"].items():
        for m in grp["meshes"]:
            V, N = parse_obj(os.path.join(SRC, m["file"]))
            ob = make_object(m["name"], V, m["albedo"])
            errs[m["name"]], probes[m["name"]] = check_order(ob, V, m["probe"])
            objs[m["name"]] = (ob, V, N)
    sofa_meshes = []
    if sofa_path:
        sofa_meshes = import_sofa(sofa_path)
    # Ce qui fait de l'ombre sans être cuit, dans tous les groupes : les boîtes des objets posés, et —
    # seulement sans le vrai canapé — sa version en boîtes (marquée "sofa" par l'export ; un export
    # d'avant cette marque n'avait d'occluders que ceux du canapé).
    for grp in scene["groups"].values():
        for m in grp.get("occluders", []):
            if sofa_path and m.get("sofa", True):
                continue
            V, _ = parse_obj(os.path.join(SRC, m["file"]))
            make_object(m["name"], V, m["albedo"])
    add_ground()
    add_lights(scene["lights"], factors)
    add_sky(scene["sky"]["color"], scene["sky"]["irradiance"], factors)
    return objs, probes, errs, sofa_meshes

def winding_report(objs):
    bad = 0
    tot = 0
    for name, (ob, V, N) in objs.items():
        if len(N) != len(V):
            continue
        t = V.reshape(-1, 3, 3)
        fn = np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0])
        vn = N.reshape(-1, 3, 3).sum(axis=1)
        area = np.linalg.norm(fn, axis=1)
        d = (fn * vn).sum(axis=1)
        ok = area > 1e-12
        b = int(((d < 0) & ok).sum())
        bad += b
        tot += int(ok.sum())
        if b:
            log(f"  attention : {name} : {b}/{int(ok.sum())} triangles dont l'enroulement contredit la normale du sommet")
    log(f"enroulement : {bad} triangles sur {tot} contredisent leur normale")
    return bad

# ---------------------------------------------------------------- dépliage

def helper_mesh(name, V):
    """Copie soudée par position (au 0,1 mm) pour que Smart UV voie la topologie ; renvoie (objet, indices des triangles gardés)."""
    n = len(V) // 3
    q = np.round(V / 1e-4).astype(np.int64)
    uniq, inv = np.unique(q, axis=0, return_inverse=True)
    inv = inv.reshape(-1)
    tri = inv.reshape(n, 3)
    keep = np.where((tri[:, 0] != tri[:, 1]) & (tri[:, 1] != tri[:, 2]) & (tri[:, 0] != tri[:, 2]))[0]
    co = np.stack([uniq[:, 0], -uniq[:, 2], uniq[:, 1]], axis=1) * 1e-4
    me = bpy.data.meshes.new(name + "_h")
    me.from_pydata(co.tolist(), [], tri[keep].tolist())
    me.update(calc_edges=True)
    me.uv_layers.new(name="u")
    ob = bpy.data.objects.new(name + "_h", me)
    bpy.context.scene.collection.objects.link(ob)
    return ob, keep, tri[keep]

def islands_of(tri, uv):
    """Îlots d'UV : triangles reliés par un sommet commun dont les UV coïncident."""
    n = len(tri)
    parent = list(range(n))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    seen = {}
    q = np.round(uv * 1e5).astype(np.int64)
    for f in range(n):
        for i in range(3):
            key = (int(tri[f, i]), int(q[3 * f + i, 0]), int(q[3 * f + i, 1]))
            o = seen.get(key)
            if o is None:
                seen[key] = f
            else:
                a, b = find(o), find(f)
                if a != b:
                    parent[a] = b
    return np.array([find(f) for f in range(n)])

def unwrap_group(group_meshes, objs, size):
    """Smart UV par maillage, densité uniforme (îlots moyennés par l'aire 3D), métal à moitié, rangement commun dans un atlas."""
    sc = bpy.context.scene
    helpers = {}
    for m in group_meshes:
        ob, V, N = objs[m["name"]]
        h, keep, tri = helper_mesh(m["name"], V)
        helpers[m["name"]] = (h, keep, tri, V)
    bpy.ops.object.select_all(action="DESELECT")
    hl = [h for h, _, _, _ in helpers.values()]
    for h in hl:
        h.select_set(True)
    bpy.context.view_layer.objects.active = hl[0]
    sc.tool_settings.use_uv_select_sync = True
    t0 = time.time()
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.002, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.average_islands_scale()
    bpy.ops.object.mode_set(mode="OBJECT")
    log(f"smart_project + densité uniforme : {time.time() - t0:.1f} s")
    # le métal à moitié de densité (îlot par îlot, autour de son centre)
    n_isl = 0
    for m in group_meshes:
        h, keep, tri, V = helpers[m["name"]]
        uv = np.empty(len(h.data.loops) * 2, dtype=np.float32)
        h.data.uv_layers[0].data.foreach_get("uv", uv)
        uv = uv.reshape(-1, 2)
        isl = islands_of(tri, uv)
        n_isl += len(set(isl.tolist()))
        if m["material"] == "metal":
            lab = np.repeat(isl, 3)
            for r in np.unique(lab):
                sel = lab == r
                c = uv[sel].mean(axis=0)
                uv[sel] = c + (uv[sel] - c) * TEXEL_METAL
            h.data.uv_layers[0].data.foreach_set("uv", uv.reshape(-1))
        helpers[m["name"]] = (h, keep, tri, V)
    log(f"{n_isl} îlots")
    t0 = time.time()
    bpy.ops.object.select_all(action="DESELECT")
    for h in hl:
        h.select_set(True)
    bpy.context.view_layer.objects.active = hl[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.pack_islands(udim_source="CLOSEST_UDIM", rotate=True, rotate_method="ANY", scale=True, merge_overlap=False,
                            margin_method="FRACTION", margin=PACK_MARGIN_PX / size, pin=False, shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")
    log(f"pack_islands : {time.time() - t0:.1f} s")
    # retour sur les vraies soupes : boucle i du maillage = sommet i de l'OBJ
    for m in group_meshes:
        ob, V, N = objs[m["name"]]
        h, keep, tri, _ = helpers[m["name"]]
        huv = np.empty(len(h.data.loops) * 2, dtype=np.float32)
        h.data.uv_layers[0].data.foreach_get("uv", huv)
        huv = huv.reshape(-1, 3, 2)
        full = np.zeros((len(V) // 3, 3, 2), dtype=np.float32)
        full[keep] = huv
        lay = ob.data.uv_layers.new(name="lightmap")
        lay.data.foreach_set("uv", full.reshape(-1))
        lay.active_render = True
        ob.data.uv_layers.active = lay
        bpy.data.objects.remove(h)

def uv_of(ob):
    me = ob.data
    lay = me.uv_layers.get("lightmap") or me.uv_layers.active
    a = np.empty(len(me.loops) * 2, dtype=np.float32)
    lay.data.foreach_get("uv", a)
    return a.reshape(-1, 2)

def texel_density(V, uv, size):
    t = V.reshape(-1, 3, 3)
    a3 = 0.5 * np.linalg.norm(np.cross(t[:, 1] - t[:, 0], t[:, 2] - t[:, 0]), axis=1)
    u = uv.reshape(-1, 3, 2).astype(np.float64)
    a2 = 0.5 * np.abs((u[:, 1, 0] - u[:, 0, 0]) * (u[:, 2, 1] - u[:, 0, 1]) - (u[:, 2, 0] - u[:, 0, 0]) * (u[:, 1, 1] - u[:, 0, 1]))
    return math.sqrt(a2.sum() * size * size / max(a3.sum(), 1e-12))

# ---------------------------------------------------------------- débruitage, écriture

def denoise(arr):
    """OIDN par le compositeur sur l'image flottante (RGB), dans une scène à part (une caméra, un échantillon)."""
    h, w = arr.shape[:2]
    img = bpy.data.images.new("dn_in", w, h, alpha=False, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[:, :, :3] = arr
    img.pixels.foreach_set(rgba.reshape(-1))
    img.pack()
    sc = bpy.data.scenes.new("dn")
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 1
    sc.cycles.device = "CPU"
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = w, h, 100
    sc.render.threads_mode = "FIXED"
    sc.render.threads = THREADS
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    sc.collection.objects.link(cam)
    sc.camera = cam
    sc.use_nodes = True
    nt = sc.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    im = nt.nodes.new("CompositorNodeImage")
    im.image = img
    dn = nt.nodes.new("CompositorNodeDenoise")
    dn.use_hdr = True
    dn.prefilter = "ACCURATE"
    co = nt.nodes.new("CompositorNodeComposite")
    nt.links.new(im.outputs["Image"], dn.inputs["Image"])
    nt.links.new(dn.outputs["Image"], co.inputs["Image"])
    sc.view_settings.view_transform = "Raw"
    sc.render.image_settings.file_format = "OPEN_EXR"
    sc.render.image_settings.color_depth = "32"
    sc.render.image_settings.color_mode = "RGB"
    path = os.path.join(WORK, "dn_out.exr")
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True, scene="dn")
    out = bpy.data.images.load(path)
    out.colorspace_settings.name = "Non-Color"
    r = read_image(out)
    os.remove(path)
    return r

def srgb_oetf(x):
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)

def write_png(path, rgb8):
    import imagecodecs
    open(path, "wb").write(imagecodecs.png_encode(rgb8))

def read_png(path):
    import imagecodecs
    return imagecodecs.png_decode(open(path, "rb").read())

# ---------------------------------------------------------------- cuisson d'un atlas

def finish_atlas(name, img, size, rng):
    """Image flottante de Blender (bas en haut) -> PNG sRGB 8 bits de E/range, haut en bas."""
    raw = read_image(img)[:, :, :3]
    t0 = time.time()
    try:
        den = denoise(np.ascontiguousarray(raw.astype(np.float32)))[:, :, :3]
        log(f"débruitage OIDN : {time.time() - t0:.1f} s")
    except Exception as e:  # on le dit, on ne le cache pas
        log("DÉBRUITAGE ÉCHOUÉ :", repr(e))
        raise
    raw_valid = raw.max(axis=2) > 0
    e = den * PI / rng
    e[~raw_valid] = 0.0   # hors des îlots et de leurs marges : zéro (le débruiteur y avait laissé des traces)
    np.save(os.path.join(WORK, f"{name}.bu.npy"), e.astype(np.float32))   # tel que Blender le tient : bas en haut
    png = np.round(srgb_oetf(np.flipud(e)) * 255.0).astype(np.uint8)       # le fichier : haut en bas
    write_png(os.path.join(WORK, f"{name}.png"), png)
    return png, raw

def verify_flip(name, uv_page16, png):
    """Deux lectures indépendantes d'un même sommet : le PNG écrit, lu avec les UV de la page (v = 0 : première ligne),
    et l'image de Blender (bas en haut), lue avec v_b = 1 - v. Elles doivent coïncider ; le sens inverse, non."""
    bu = np.load(os.path.join(WORK, f"{name}.bu.npy"))
    h, w = png.shape[:2]
    pick = np.random.default_rng(1).integers(0, len(uv_page16), 6000)
    u = uv_page16[pick, 0] / 65535.0
    v = uv_page16[pick, 1] / 65535.0
    x = np.clip((u * w).astype(int), 0, w - 1)
    a = png[np.clip((v * h).astype(int), 0, h - 1), x].astype(np.float32)
    b = np.round(srgb_oetf(bu[np.clip(((1.0 - v) * h).astype(int), 0, h - 1), x]) * 255.0)
    c = np.round(srgb_oetf(bu[np.clip((v * h).astype(int), 0, h - 1), x]) * 255.0)
    good, bad = np.abs(a - b).mean(), np.abs(a - c).mean()
    log(f"vérification de l'orientation (PNG relu avec les UV de uv.bin contre l'image de Blender) : écart moyen {good:.3f}/255 ; sens inversé : {bad:.2f}/255")
    assert good < 1.0 and (good * 3 < bad or bad < 1.0), "orientation de l'image incohérente avec uv.bin"

def bake_group(group, scene, factors):
    t_all = time.time()
    objs, probes, errs, _ = build_world(scene, factors, SOFA, group)
    log(f"ordre des sommets : {len(objs)} maillages relus par boucle, écart max {max(errs.values()):.2e} m, sondes à 1 mm : OK")
    winding_report(objs)
    grp = scene["groups"][group]
    size = grp["atlas"]
    unwrap_group(grp["meshes"], objs, size)
    img = new_image(group, size)
    for m in grp["meshes"]:
        ob = objs[m["name"]][0]
        ob.data.materials.clear()
        ob.data.materials.append(diffuse_material(m["name"], m["albedo"], img))
    targets = [objs[m["name"]][0] for m in grp["meshes"]]
    log(f"cuisson {group} : {size}², {SAMPLES} échantillons, {len(scene['lights'])} lumières")
    t0 = time.time()
    bake_selected(targets, BAKE_MARGIN_PX)
    t_bake = time.time() - t0
    log(f"cuisson : {t_bake:.0f} s")
    png, raw = finish_atlas(group, img, size, scene["range"])
    # UV de la page + fichier
    chunks, entries, dens = [], [], {}
    off = 0
    for m in grp["meshes"]:
        ob, V, N = objs[m["name"]]
        uv = uv_of(ob).astype(np.float64)
        page = np.stack([np.clip(uv[:, 0], 0, 1), np.clip(1.0 - uv[:, 1], 0, 1)], axis=1)
        q = np.round(page * 65535.0).astype("<u2")
        chunks.append(q)
        entries.append({"name": m["name"], "material": m["material"], "offset": off, "count": len(V), "probe": probes[m["name"]]})
        dens[m["material"]] = texel_density(V, uv, size)
        off += len(V)
    allq = np.concatenate(chunks)
    os.makedirs(OUT, exist_ok=True)
    allq.astype("<u2").tofile(os.path.join(OUT, f"{group}.uv.bin"))
    verify_flip(group, allq.astype(np.int64), png)
    used = float((raw.max(axis=2) > 0).mean())
    info = {"texture": f"{group}.ktx2", "size": size, "uv": f"{group}.uv.bin", "meshes": entries}
    json.dump({"atlas": info, "stats": {"bakeSeconds": round(t_bake, 1), "totalSeconds": round(time.time() - t_all, 1), "samples": SAMPLES,
               "texelsPerMetre": {k: round(v, 1) for k, v in dens.items()}, "atlasCoverage": round(used, 3)}},
              open(os.path.join(WORK, f"{group}.json"), "w"), indent=1)
    log(f"densité (texels/m) : { {k: round(v, 1) for k, v in dens.items()} } ; atlas utilisé à {used * 100:.0f} %")
    log(f"{group} terminé en {time.time() - t_all:.0f} s")

def bake_sofa(scene, factors):
    t_all = time.time()
    objs, probes, errs, sofa = build_world(scene, factors, SOFA, None)
    size = 1024
    img = new_image("sofa", size)
    for o in sofa:
        key = "pillows" if o.name.startswith("pillows_") else "sofa"
        o.data.materials.clear()
        o.data.materials.append(diffuse_material(o.name, SOFA_ALBEDO[key], img))
    t0 = time.time()
    bake_selected(sofa, BAKE_MARGIN_PX)
    t_bake = time.time() - t0
    png, raw = finish_atlas("sofa", img, size, scene["range"])
    json.dump({"atlas": {"texture": "sofa.ktx2", "size": size, "uvSet": "TEXCOORD_1"},
               "stats": {"bakeSeconds": round(t_bake, 1), "totalSeconds": round(time.time() - t_all, 1), "samples": SAMPLES,
                         "meshes": [o.name for o in sofa]}}, open(os.path.join(WORK, "sofa.json"), "w"), indent=1)
    log(f"sofa terminé en {time.time() - t_all:.0f} s")

# ---------------------------------------------------------------- aperçus « ce que la page montrera »

CAMERAS = {
    "entree": ((-1.2, 1.64, 3.1), (1.5, 2.6, -5)),
    "balcon": ((0.5, 4.5, 4.7), (0.5, 0.5, -3)),
    "cuisine": ((1.3, 1.64, 4.6), (1.3, 1.2, 10)),
    "chambre": ((-0.2, 1.64, 12.9), (-5, 0.8, 15)),
    "escalier": ((-3.2, 1.64, 4.4), (-5, 1.5, 8)),
    "lune": ((3.0, 1.64, -0.5), (0.0, 0.0, -6)),   # en plus : le sol près de la baie nord (lune, ombre des meneaux), à exposer plus fort
}

def emission_material(name, albedo, image, uvname, rng, flat=None):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    if image is None:
        em.inputs["Color"].default_value = (albedo[0] * flat, albedo[1] * flat, albedo[2] * flat, 1)
        em.inputs["Strength"].default_value = 1.0
    else:
        uvn = nt.nodes.new("ShaderNodeUVMap")
        uvn.uv_map = uvname
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = image
        t.interpolation = "Linear"
        t.extension = "EXTEND"
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs["B"].default_value = (albedo[0], albedo[1], albedo[2], 1)
        nt.links.new(uvn.outputs["UV"], t.inputs["Vector"])
        nt.links.new(t.outputs["Color"], mix.inputs["A"])
        nt.links.new(mix.outputs["Result"], em.inputs["Color"])
        em.inputs["Strength"].default_value = rng / PI
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return m

def preview():
    scene = load_scene_json()
    rng = scene["range"]
    sc = reset()
    sc.cycles.samples = 24
    sc.cycles.use_adaptive_sampling = False
    sc.cycles.use_denoising = False
    sc.cycles.sample_clamp_indirect = 0
    w = bpy.data.worlds.new("black")
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Color"].default_value = (0, 0, 0, 1)
    sc.world = w
    lm = json.load(open(os.path.join(OUT, "lightmaps.json")))
    for g, grp in scene["groups"].items():
        at = lm["atlases"][g]
        img = bpy.data.images.load(os.path.join(WORK, f"{g}.png"))
        img.colorspace_settings.name = "sRGB"
        q = np.fromfile(os.path.join(OUT, at["uv"]), dtype="<u2").reshape(-1, 2).astype(np.float64) / 65535.0
        for m, e in zip(grp["meshes"], at["meshes"]):
            V, _ = parse_obj(os.path.join(SRC, m["file"]))
            ob = make_object(m["name"], V, m["albedo"])
            uv = np.stack([q[e["offset"]:e["offset"] + e["count"], 0], 1.0 - q[e["offset"]:e["offset"] + e["count"], 1]], axis=1)
            lay = ob.data.uv_layers.new(name="lightmap")
            lay.data.foreach_set("uv", uv.astype(np.float32).reshape(-1))
            ob.data.materials.clear()
            ob.data.materials.append(emission_material(m["name"], m["albedo"], img, "lightmap", rng))
    sofa_baked = SOFA and os.path.exists(os.path.join(WORK, "sofa.png"))
    if sofa_baked:
        simg = bpy.data.images.load(os.path.join(WORK, "sofa.png"))
        simg.colorspace_settings.name = "sRGB"
        for o in import_sofa(SOFA):
            key = "pillows" if o.name.startswith("pillows_") else "sofa"
            o.data.materials.clear()
            o.data.materials.append(emission_material(o.name, SOFA_ALBEDO[key], simg, o.data.uv_layers.active.name, rng))
    else:
        for m in [m for m in scene["groups"]["salon"]["occluders"] if m.get("sofa", True)]:   # non cuit : gris sombre uniforme (le canapé réel est dessiné par la page)
            V, _ = parse_obj(os.path.join(SRC, m["file"]))
            ob = make_object(m["name"], V, m["albedo"])
            ob.data.materials.clear()
            ob.data.materials.append(emission_material(m["name"], m["albedo"], None, None, rng, flat=0.02))
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "None"
    sc.view_settings.exposure = EXPOSURE
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 1600, 900, 100
    sc.render.image_settings.file_format = "JPEG"
    sc.render.image_settings.quality = 90
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.sensor_fit = "VERTICAL"
    cam.data.sensor_height = 24.0
    cam.data.angle_y = math.radians(68)
    cam.data.clip_start = 0.05
    sc.collection.objects.link(cam)
    sc.camera = cam
    os.makedirs(PREV, exist_ok=True)
    only = opt("--views")
    for name, (eye, tgt) in CAMERAS.items():
        if (only and name not in only.split(",")) or (not only and name == "lune"):
            continue
        cam.location = g2b(eye)
        d = Vector(g2b(tgt)) - Vector(g2b(eye))
        cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(PREV, f"{name}.jpg")
        bpy.ops.render.render(write_still=True)
        log("aperçu", name, "exposition", EXPOSURE, "EV")

def atlas_previews(scene):
    import imagecodecs
    for g in list(scene["groups"]) + ["sofa"]:
        p = os.path.join(WORK, f"{g}.png")
        if not os.path.exists(p):
            continue
        a = read_png(p).astype(np.float32) / 255.0
        lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
        pos = lin[lin > 0]
        k = 0.8 / max(float(np.percentile(pos, 99)) if pos.size else 1.0, 1e-6)   # lisible : le 99e centile à 0,8
        v = np.clip(srgb_oetf(np.clip(lin * k, 0, 1)) * 255.0, 0, 255).astype(np.uint8)
        os.makedirs(PREV, exist_ok=True)
        open(os.path.join(PREV, f"{g}_atlas.jpg"), "wb").write(imagecodecs.jpeg8_encode(v, level=90))
        log(f"atlas {g} : facteur d'exposition de l'aperçu x{k:.1f}")

# ---------------------------------------------------------------- main

def main():
    cal_path = os.path.join(WORK, "calibration.json")
    if CALIBRATE:
        calibrate()
        return
    if PREVIEW:
        preview()
        atlas_previews(load_scene_json())
        return
    if not os.path.exists(cal_path):
        calibrate()
    cal = json.load(open(cal_path))
    factors = {"point": cal["point"], "sun": cal["sun"], "sky": cal["sky"]}
    scene = load_scene_json()
    if GROUP == "sofa":
        bake_sofa(scene, factors)
    else:
        bake_group(GROUP, scene, factors)

main()
