# Blender (Cycles CPU) render of one panorama layer from the Copernicus DEM mosaic.
# usage: blender -b --python tools/panorama/render.py -- <far|mid|near> <out.exr> [--width W] [--samples S]
#                                                        [--mode cover|marker] [--noclip]
import bpy, bmesh, sys, os, json, math, time
import numpy as np
from mathutils import Vector
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from params import *

argv = sys.argv[sys.argv.index("--") + 1:]
layer, outpath = argv[0], argv[1]
def opt(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default
lo, hi, W0, H0 = LAYERS[layer]
W = int(opt("--width", W0)); H = int(round(W * (EL_MAX - EL_MIN) / 360.0)) if "--width" in argv else H0
SAMPLES = int(opt("--samples", 96)); MODE = opt("--mode", "beauty"); NOCLIP = "--noclip" in argv
t0 = time.time()

# ---------------- DEM ----------------
m = json.load(open("assets-src/panorama/mosaic.json")); Z = np.load("assets-src/panorama/mosaic.npy")
N = m["n"]; LAT_TOP = m["lat0"] + m["nlat"]; LON_L = m["lon0"]; NR, NC = Z.shape
def cr(t):  # Catmull-Rom weights for fractional t
    return (0.5 * (-t**3 + 2*t**2 - t), 0.5 * (3*t**3 - 5*t**2 + 2), 0.5 * (-3*t**3 + 4*t**2 + t), 0.5 * (t**3 - t**2))
def dem(x, y):
    """bicubic DEM height at ENU metres (x east, y north) from the viewpoint; clamps (and flattens) outside the mosaic."""
    lat = LAT + y / MLAT; lon = LON + x / (MLAT * np.cos(np.radians(lat)))
    r = (LAT_TOP - lat) * N - 0.5; c = (lon - LON_L) * N - 0.5
    out_d = np.maximum(np.maximum(-r, r - (NR - 1)), np.maximum(-c, c - (NC - 1))).clip(0) * 30.0  # metres outside
    r = r.clip(1, NR - 3); c = c.clip(1, NC - 3)
    r0 = np.floor(r).astype(np.int64); c0 = np.floor(c).astype(np.int64); fr = (r - r0).astype(np.float32); fc = (c - c0).astype(np.float32)
    wr = cr(fr); wc = cr(fc); res = 0
    for i in range(4):
        row = 0
        for j in range(4):
            row = row + wc[j] * Z[r0 + i - 1, c0 + j - 1]
        res = res + wr[i] * row
    w = np.clip(out_d / 8000.0, 0, 1)
    return res * (1 - w) + 450.0 * w
Z0 = float(dem(np.array([0.0]), np.array([0.0]))[0]); EYE = Z0 + CAM_H
print("terrain at viewpoint", Z0, flush=True)
os.makedirs("assets-src/panorama/final/out", exist_ok=True); open("assets-src/panorama/final/out/terrain_z.txt", "w").write(str(Z0))

rng = np.random.default_rng(7)
LAT_N = 256; LATT = [rng.random((LAT_N, LAT_N)).astype(np.float32) for _ in range(3)]
def vnoise(x, y, k=0):
    L = LATT[k]; xi = np.floor(x).astype(np.int64); yi = np.floor(y).astype(np.int64)
    fx = (x - xi).astype(np.float32); fy = (y - yi).astype(np.float32)
    fx = fx*fx*(3 - 2*fx); fy = fy*fy*(3 - 2*fy)
    xi %= LAT_N; yi %= LAT_N; x1 = (xi + 1) % LAT_N; y1 = (yi + 1) % LAT_N
    return (L[yi, xi]*(1-fx) + L[yi, x1]*fx)*(1-fy) + (L[y1, xi]*(1-fx) + L[y1, x1]*fx)*fy
def fbm(x, y, wl, octs=4, k=0):
    s = 0; a = 1; tot = 0; f = 1.0 / wl
    for o in range(octs):
        s = s + a * vnoise(x * f + 17.3 * o, y * f + 5.1 * o, k); tot += a; a *= 0.5; f *= 2.03
    return s / tot
def smooth(e0, e1, v):
    t = np.clip((v - e0) / (e1 - e0), 0, 1); return t*t*(3 - 2*t)

# ---------------- terrain rings ----------------
# (half-size m, step m, hole half-size m)
RINGS = [(750, 3.0, 0), (3200, 10.0, 750), (25000, 30.0, 3200), (110000, 160.0, 25000)]
mat = bpy.data.materials.new("terrain"); mat.use_nodes = True
def ring_mesh(half, step, hole, idx):
    n = int(round(2 * half / step)) + 1
    xs = (np.arange(n) * step - half).astype(np.float64)
    out_h = np.empty((n, n), np.float32)
    X = np.empty((n, n), np.float32); Y = np.empty((n, n), np.float32)
    # displacement (procedural micro-relief, only where the DEM step is coarser than the detail we add)
    amp_scale = {0: 1.0, 1: 1.0, 2: 0.7, 3: 0.0}[idx]
    for i0 in range(0, n, 256):
        i1 = min(n, i0 + 256)
        gx, gy = np.meshgrid(xs, xs[i0:i1])
        h = dem(gx, gy)
        out_h[i0:i1] = h; X[i0:i1] = gx; Y[i0:i1] = gy
    # slope / masks computed from the undisplaced height grid
    gy_, gx_ = np.gradient(out_h.astype(np.float64), step)
    slope = np.degrees(np.arctan(np.hypot(gx_, gy_))).astype(np.float32)
    lf = fbm(X, Y, 900.0, 3, 1); mf = fbm(X, Y, 140.0, 3, 2); tl = TREELINE + (lf - 0.5) * 320
    below = smooth(0, 1, (tl - out_h) / 160.0)                       # fades out towards the tree line
    on_slope = smooth(4, 14, slope)                                  # valley floor is patchy, slopes are wooded
    dens = np.clip(0.2 + on_slope * 0.75 + (mf - 0.5) * 1.4 - (out_h > 1500) * 0.0, 0, 1)
    forest = (below * smooth(0.35, 0.6, dens) * (1 - smooth(46, 56, slope))).astype(np.float32)
    rock = smooth(55, 67, slope + (mf - 0.5) * 6).astype(np.float32)
    if amp_scale > 0:
        canopy = fbm(X, Y, 14.0, 3, 0) - 0.5; broad = fbm(X, Y, 60.0, 3, 2) - 0.5
        out_h = out_h + amp_scale * (canopy * (1.0 + 5.0 * forest) * 3.0 + broad * 3.0 * (1 + rock)).astype(np.float32)
    # cells kept (outside the hole)
    cx = (xs[:-1] + xs[1:]) / 2
    inside = (np.abs(cx)[None, :] < hole) & (np.abs(cx)[:, None] < hole)
    kept = ~inside
    # quads
    ii, jj = np.nonzero(kept)
    v00 = ii * n + jj; v10 = ii * n + jj + 1; v11 = (ii + 1) * n + jj + 1; v01 = (ii + 1) * n + jj
    quads = np.stack([v00, v10, v11, v01], 1)
    # skirts along the boundary of the kept area
    P = np.pad(kept | inside, 1, constant_values=False)   # skirts only on the outer boundary, not around the hole
    ks = []
    for (di, dj, a) in [(-1, 0, "bottom"), (1, 0, "top"), (0, -1, "left"), (0, 1, "right")]:
        edge = kept & ~P[1 + di:1 + di + kept.shape[0], 1 + dj:1 + dj + kept.shape[1]]
        ei, ej = np.nonzero(edge)
        if a == "bottom": s0, s1 = ei * n + ej, ei * n + ej + 1
        elif a == "top": s0, s1 = (ei + 1) * n + ej + 1, (ei + 1) * n + ej
        elif a == "left": s0, s1 = (ei + 1) * n + ej, ei * n + ej
        else: s0, s1 = ei * n + ej + 1, (ei + 1) * n + ej + 1
        ks.append((s0, s1))
    s0 = np.concatenate([k[0] for k in ks]); s1 = np.concatenate([k[1] for k in ks])
    nv = n * n; ns = len(s0)
    # skirt vertices: duplicates of s0 and s1 lowered by 250 m, appended after the grid
    skv = np.concatenate([s0, s1]); sk_idx = nv + np.arange(2 * ns)
    sq = np.stack([s0, s1, nv + ns + np.arange(ns), nv + np.arange(ns)], 1)
    # orient skirt quads outwards is irrelevant: material is double sided for camera rays except backfacing clip,
    # so give the skirt both windings
    sq2 = sq[:, ::-1]
    allq = np.concatenate([quads] + ([] if "--noskirt" in argv else [sq2])).astype(np.int32)
    verts = np.empty((nv + 2 * ns, 3), np.float32)
    verts[:nv, 0] = X.ravel(); verts[:nv, 1] = Y.ravel(); verts[:nv, 2] = out_h.ravel()
    verts[nv:, :] = verts[skv, :]; verts[nv:, 2] -= 250.0
    # attributes
    fa = np.concatenate([forest.ravel(), forest.ravel()[skv]]); ra = np.concatenate([rock.ravel(), rock.ravel()[skv]])
    me = bpy.data.meshes.new(f"ring{idx}")
    me.vertices.add(len(verts)); me.vertices.foreach_set("co", verts.ravel())
    me.loops.add(len(allq) * 4); me.loops.foreach_set("vertex_index", allq.ravel())
    me.polygons.add(len(allq))
    me.polygons.foreach_set("loop_start", np.arange(len(allq), dtype=np.int32) * 4)
    me.polygons.foreach_set("loop_total", np.full(len(allq), 4, np.int32))
    me.polygons.foreach_set("use_smooth", np.ones(len(allq), bool))
    for nm, arr in (("forest", fa), ("rock", ra)):
        at = me.attributes.new(nm, "FLOAT", "POINT"); at.data.foreach_set("value", arr.astype(np.float32))
    me.update(calc_edges=True)
    ob = bpy.data.objects.new(f"ring{idx}", me); bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)
    print(f"ring {idx}: {nv} verts, {len(allq)} quads, {time.time()-t0:.0f}s", flush=True)
    return ob

scene = bpy.context.scene
for o in list(bpy.data.objects): bpy.data.objects.remove(o)

# ---------------- material ----------------
nt = mat.node_tree; nt.nodes.clear()
def nd(t, **kw):
    n = nt.nodes.new(t)
    for k, v in kw.items(): setattr(n, k, v)
    return n
def link(a, ao, b, bi): nt.links.new(a.outputs[ao] if isinstance(ao, (int, str)) else ao, b.inputs[bi])
def math_(op, a=None, b=None, clamp=False):
    n = nd("ShaderNodeMath"); n.operation = op; n.use_clamp = clamp
    for i, v in enumerate((a, b)):
        if v is None: continue
        if isinstance(v, (int, float)): n.inputs[i].default_value = v
        else: nt.links.new(v, n.inputs[i])
    return n.outputs[0]
def ramp(v, e0, e1):
    n = nd("ShaderNodeMapRange"); n.interpolation_type = "SMOOTHSTEP"; n.clamp = True
    n.inputs[1].default_value = e0; n.inputs[2].default_value = e1; nt.links.new(v, n.inputs[0]); return n.outputs[0]
pos = nd("ShaderNodeNewGeometry")
fa = nd("ShaderNodeAttribute", attribute_name="forest"); ra = nd("ShaderNodeAttribute", attribute_name="rock")
def noise(scale, detail, rough=0.55):
    n = nd("ShaderNodeTexNoise"); n.noise_dimensions = "3D"; n.inputs["Scale"].default_value = scale
    n.inputs["Detail"].default_value = detail; n.inputs["Roughness"].default_value = rough
    nt.links.new(pos.outputs["Position"], n.inputs["Vector"]); return n.outputs["Fac"]
n1 = noise(0.12, 5); n2 = noise(0.55, 3)
# masks sharpened with fine noise
Fm = ramp(math_("ADD", fa.outputs["Fac"], math_("MULTIPLY", math_("SUBTRACT", n1, 0.5), 0.5)), 0.42, 0.58)
Rm = ramp(math_("ADD", ra.outputs["Fac"], math_("MULTIPLY", math_("SUBTRACT", n1, 0.5), 0.15)), 0.45, 0.55)
def mixrgb(fac, a, b):
    n = nd("ShaderNodeMix"); n.data_type = "RGBA"
    nt.links.new(fac, n.inputs["Factor"]); n.inputs["A"].default_value = a if isinstance(a, tuple) else (0, 0, 0, 1)
    n.inputs["B"].default_value = b if isinstance(b, tuple) else (0, 0, 0, 1)
    if not isinstance(a, tuple): nt.links.new(a, n.inputs["A"])
    if not isinstance(b, tuple): nt.links.new(b, n.inputs["B"])
    return n.outputs["Result"]
snow = mixrgb(ramp(n1, 0.35, 0.7), (0.74, 0.79, 0.88, 1), (0.88, 0.91, 0.97, 1))
forest = mixrgb(ramp(n2, 0.5, 0.78), mixrgb(n2, (0.004, 0.016, 0.028, 1), (0.010, 0.034, 0.048, 1)), (0.16, 0.21, 0.30, 1))
rockc = mixrgb(n1, (0.030, 0.034, 0.050, 1), (0.062, 0.070, 0.092, 1))
col = mixrgb(Rm, mixrgb(Fm, snow, forest), rockc)
bsdf = nd("ShaderNodeBsdfPrincipled")
nt.links.new(col, bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.62
bsdf.inputs["Specular IOR Level"].default_value = 0.25
bump = nd("ShaderNodeBump"); bump.inputs["Distance"].default_value = 1.0
hgt = nd("ShaderNodeMix"); hgt.data_type = "FLOAT"
nt.links.new(Fm, hgt.inputs["Factor"]); nt.links.new(n1, hgt.inputs["A"]); nt.links.new(n2, hgt.inputs["B"])
nt.links.new(hgt.outputs["Result"], bump.inputs["Height"]); bump.inputs["Strength"].default_value = 0.3
nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
surf = bsdf.outputs["BSDF"]

# distance, haze and clipping
camd = nd("ShaderNodeCameraData")
dist = camd.outputs["View Distance"]
sep = nd("ShaderNodeSeparateXYZ"); nt.links.new(pos.outputs["Position"], sep.inputs[0])
zmid = math_("MULTIPLY", math_("ADD", sep.outputs["Z"], EYE), 0.5)
dens = math_("MULTIPLY", math_("POWER", 2.718281828, math_("MULTIPLY", math_("MAXIMUM", math_("SUBTRACT", zmid, 900.0), 0.0), -1 / 1100.0)), 1 / 4800.0)
tau = math_("MULTIPLY", dist, dens)
T = math_("POWER", 2.718281828, math_("MULTIPLY", tau, -1.0))
em = nd("ShaderNodeEmission"); em.inputs["Color"].default_value = (*HAZE_COLOR, 1); em.inputs["Strength"].default_value = 1.0
hz = nd("ShaderNodeMixShader"); nt.links.new(math_("SUBTRACT", 1.0, T), hz.inputs[0]); nt.links.new(surf, hz.inputs[1]); nt.links.new(em.outputs[0], hz.inputs[2])
lp = nd("ShaderNodeLightPath")
out_range = math_("ADD", math_("LESS_THAN", dist, lo), math_("GREATER_THAN", dist, hi)) if not NOCLIP else None
back = nd("ShaderNodeNewGeometry").outputs["Backfacing"]
kill = math_("MULTIPLY", math_("ADD", out_range, back, ) if out_range is not None else back, lp.outputs["Is Camera Ray"])
kill = math_("MINIMUM", kill, 1.0)
tr = nd("ShaderNodeBsdfTransparent")
fin = nd("ShaderNodeMixShader"); nt.links.new(kill, fin.inputs[0]); nt.links.new(hz.outputs[0], fin.inputs[1]); nt.links.new(tr.outputs[0], fin.inputs[2])
outn = nd("ShaderNodeOutputMaterial"); nt.links.new(fin.outputs[0], outn.inputs["Surface"])
if MODE == "cover":   # coverage mask: white emission wherever any terrain exists, no clip
    nt.nodes.clear(); e = nd("ShaderNodeEmission"); o = nd("ShaderNodeOutputMaterial"); nt.links.new(e.outputs[0], o.inputs["Surface"])

# ---------------- build ----------------
if MODE != "marker":
    SEL = [int(v) for v in opt('--rings', '0,1,2,3').split(',')]
    for i, (half, step, hole) in enumerate(RINGS):
        if i in SEL: ring_mesh(half, step, hole, i)

# village lights (Chamonix valley), emissive octahedra, no clip trouble: same wrapper as terrain
lights_mat = bpy.data.materials.new("lights"); lights_mat.use_nodes = True
lnt = lights_mat.node_tree; lnt.nodes.clear()
if MODE == "beauty":
    VILL = [(45.9237, 6.8694, 520, 90), (45.9400, 6.8830, 160, 25), (45.9800, 6.9270, 160, 25), (45.8900, 6.7990, 110, 20), (45.8960, 6.8460, 70, 12), (45.9570, 6.8990, 30, 8)]
    lr = np.random.default_rng(3); pts = []
    for (la, lo_, cnt, sig) in VILL:
        for _ in range(cnt):
            # scatter along the valley axis, a bit stretched
            px = (lo_ - LON) * MLAT * math.cos(math.radians(la)) + lr.normal(0, sig * 2.2); py = (la - LAT) * MLAT + lr.normal(0, sig * 1.2)
            pts.append((px, py))
    pts = np.array(pts); hz_ = dem(pts[:, 0], pts[:, 1]) + 4.0
    oct_v = np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], np.float32)
    oct_f = np.array([[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]], np.int32)
    sizes = lr.uniform(1.6, 3.2, len(pts)).astype(np.float32)
    V = (oct_v[None] * sizes[:, None, None]) + np.stack([pts[:, 0], pts[:, 1], hz_], 1)[:, None, :]
    F = oct_f[None] + (np.arange(len(pts)) * 6)[:, None, None]
    me = bpy.data.meshes.new("lights"); me.vertices.add(V.shape[0] * 6); me.vertices.foreach_set("co", V.reshape(-1).astype(np.float32))
    Ff = F.reshape(-1, 3); me.loops.add(len(Ff) * 3); me.loops.foreach_set("vertex_index", Ff.ravel())
    me.polygons.add(len(Ff)); me.polygons.foreach_set("loop_start", np.arange(len(Ff), dtype=np.int32) * 3); me.polygons.foreach_set("loop_total", np.full(len(Ff), 3, np.int32))
    me.update(calc_edges=True)
    lo_ob = bpy.data.objects.new("lights", me); scene.collection.objects.link(lo_ob); lo_ob.data.materials.append(lights_mat)
    # emission with the same haze + clip logic
    c = lnt.nodes
    pg = c.new("ShaderNodeNewGeometry"); cd = c.new("ShaderNodeCameraData"); lpn = c.new("ShaderNodeLightPath")
    emn = c.new("ShaderNodeEmission"); emn.inputs["Color"].default_value = (1.0, 0.55, 0.20, 1); emn.inputs["Strength"].default_value = 6.0
    # haze transmittance from distance only (valley air): reuse a simple exp
    def lm(op, a, b):
        n = c.new("ShaderNodeMath"); n.operation = op
        for i, v in enumerate((a, b)):
            if isinstance(v, (int, float)): n.inputs[i].default_value = v
            else: lnt.links.new(v, n.inputs[i])
        return n.outputs[0]
    dd = cd.outputs["View Distance"]
    Tl = lm("POWER", 2.718281828, lm("MULTIPLY", dd, -1 / 14000.0))
    mx = c.new("ShaderNodeMixShader"); lnt.links.new(lm("SUBTRACT", 1.0, Tl), mx.inputs[0]); lnt.links.new(emn.outputs[0], mx.inputs[1])
    e2 = c.new("ShaderNodeEmission"); e2.inputs["Color"].default_value = (*HAZE_COLOR, 1); lnt.links.new(e2.outputs[0], mx.inputs[2])
    kl = lm("MULTIPLY", lm("ADD", lm("LESS_THAN", dd, lo), lm("GREATER_THAN", dd, hi)), lpn.outputs["Is Camera Ray"])
    tr2 = c.new("ShaderNodeBsdfTransparent"); f2 = c.new("ShaderNodeMixShader")
    lnt.links.new(lm("MINIMUM", kl, 1.0), f2.inputs[0]); lnt.links.new(mx.outputs[0], f2.inputs[1]); lnt.links.new(tr2.outputs[0], f2.inputs[2])
    o2 = c.new("ShaderNodeOutputMaterial"); lnt.links.new(f2.outputs[0], o2.inputs["Surface"])
if MODE == "marker":
    # markers at known directions: (az rel MAIN, el) -> check the equirect mapping
    for (az, el, rgb) in [(0, 0, (1, 0, 0)), (90, 20, (0, 1, 0)), (-90, -20, (0, 0, 1)), (180, 10, (1, 1, 0))]:
        a = math.radians(HEADING + az); e = math.radians(el); d = Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e))) * 100
        bpy.ops.mesh.primitive_uv_sphere_add(radius=1.0, location=Vector((0, 0, EYE)) + d)
        ob = bpy.context.object; mm = bpy.data.materials.new("mk"); mm.use_nodes = True
        mm.node_tree.nodes.clear(); e_ = mm.node_tree.nodes.new("ShaderNodeEmission"); e_.inputs["Color"].default_value = (*rgb, 1)
        o_ = mm.node_tree.nodes.new("ShaderNodeOutputMaterial"); mm.node_tree.links.new(e_.outputs[0], o_.inputs[0]); ob.data.materials.append(mm)

# camera
cam = bpy.data.cameras.new("cam"); cam.type = "PANO"
try: cam.panorama_type = "EQUIRECTANGULAR"
except Exception: cam.cycles.panorama_type = "EQUIRECTANGULAR"
for obj_, nm, val in ((cam, "latitude_min", math.radians(EL_MIN)), (cam, "latitude_max", math.radians(EL_MAX)), (cam, "longitude_min", -math.pi), (cam, "longitude_max", math.pi)):
    try: setattr(cam, nm, val)
    except Exception: setattr(cam.cycles, nm, val)
cam.clip_start = 0.05; cam.clip_end = 1e6
co = bpy.data.objects.new("cam", cam); scene.collection.objects.link(co); scene.camera = co
co.location = (0, 0, EYE)
co.rotation_euler = (math.pi / 2, 0, -math.radians(HEADING))   # looks along +Y rotated clockwise to HEADING

# lights / world
sun = bpy.data.lights.new("moon", "SUN"); sun.energy = MOON_STRENGTH; sun.color = MOON_COLOR; sun.angle = math.radians(0.55)
so = bpy.data.objects.new("moon", sun); scene.collection.objects.link(so)
az = math.radians(HEADING + MOON_AZ); el = math.radians(MOON_EL)
toward = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))
so.rotation_euler = (-toward).to_track_quat("-Z", "Y").to_euler()
world = bpy.data.worlds.new("w"); world.use_nodes = True; scene.world = world
wn = world.node_tree.nodes; wn.clear()
bg = wn.new("ShaderNodeBackground"); bg.inputs["Color"].default_value = (*AMBIENT, 1); bg.inputs["Strength"].default_value = AMBIENT_STRENGTH
wo = wn.new("ShaderNodeOutputWorld"); world.node_tree.links.new(bg.outputs[0], wo.inputs[0])

# render settings
r = scene.render; r.engine = "CYCLES"; r.resolution_x = W; r.resolution_y = H; r.resolution_percentage = 100
r.film_transparent = True; r.image_settings.file_format = "OPEN_EXR"; r.image_settings.color_depth = "16"; r.image_settings.color_mode = "RGBA"
r.threads_mode = "FIXED"; r.threads = 5
cy = scene.cycles; cy.device = "CPU"
if MODE == "cover": cy.samples = 8; cy.use_denoising = False; cy.use_adaptive_sampling = False; cy.max_bounces = 0
elif MODE == "marker": cy.samples = 1; cy.use_denoising = False; cy.max_bounces = 0
else:
    cy.samples = SAMPLES; cy.use_adaptive_sampling = True; cy.adaptive_threshold = 0.02; cy.adaptive_min_samples = 16
    cy.use_denoising = "--nodenoise" not in argv; cy.denoiser = "OPENIMAGEDENOISE"; cy.max_bounces = 3; cy.diffuse_bounces = 2; cy.glossy_bounces = 2
    cy.transparent_max_bounces = 64; cy.transmission_bounces = 0
cy.transparent_max_bounces = 64
cy.filter_width = 1.2
scene.view_settings.view_transform = "Standard"
r.filepath = outpath
print("scene built", f"{time.time()-t0:.0f}s", flush=True)
bpy.ops.render.render(write_still=True)
print("DONE", layer, W, H, f"{time.time()-t0:.0f}s", flush=True)
