# Blender (Cycles CPU) render of one panorama layer from the Copernicus DEM mosaic.
# usage: blender -b --python tools/panorama/render.py -- <far|mid|near> <out.exr> [--width W] [--samples S]
#          [--mode cover|marker] [--noclip] [--lon A,B (render only that azimuth sector, relative to MAIN)]
#          [--notrees] [--nolights] [--rings 0,1,2,3] [--nodenoise]
import bpy, sys, os, json, math, time
import numpy as np
from mathutils import Vector
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from params import *

argv = sys.argv[sys.argv.index("--") + 1:]
layer, outpath = argv[0], argv[1]
def opt(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default
lo, hi, W0, H0 = LAYERS[layer]
LON_A, LON_B = [float(v) for v in opt("--lon", "-180,180").split(",")]
W = int(opt("--width", W0)); H = H0
WF = int(opt("--width", W0))      # width the full 360 deg image would have (sets the pixel size)
W = int(round(WF * (LON_B - LON_A) / 360.0 / 4)) * 4
if "--width" in argv: H = int(round(WF * (EL_MAX - EL_MIN) / 360.0 / 4)) * 4
SAMPLES = int(opt("--samples", 96)); MODE = opt("--mode", "beauty"); NOCLIP = "--noclip" in argv
t0 = time.time()
def log(*a): print(*a, f"[{time.time()-t0:.0f}s]", flush=True)

# ---------------- DEM ----------------
m = json.load(open("assets-src/panorama/mosaic.json")); Z = np.load("assets-src/panorama/mosaic.npy")
N = m["n"]; LAT_TOP = m["lat0"] + m["nlat"]; LON_L = m["lon0"]; NR, NC = Z.shape
def cr(t):
    return (0.5 * (-t**3 + 2*t**2 - t), 0.5 * (3*t**3 - 5*t**2 + 2), 0.5 * (-3*t**3 + 4*t**2 + t), 0.5 * (t**3 - t**2))
def dem(x, y):
    """bicubic DEM height at ENU metres (x east, y north) from the viewpoint; clamps (and flattens) outside the mosaic."""
    x = np.asarray(x, np.float64); y = np.asarray(y, np.float64)
    lat = LAT + y / MLAT; lon = LON + x / (MLAT * np.cos(np.radians(lat)))
    r = (LAT_TOP - lat) * N - 0.5; c = (lon - LON_L) * N - 0.5
    out_d = np.maximum(np.maximum(-r, r - (NR - 1)), np.maximum(-c, c - (NC - 1))).clip(0) * 30.0
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
rng = np.random.default_rng(7)
LAT_N = 256; LATT = [rng.random((LAT_N, LAT_N)).astype(np.float32) for _ in range(4)]
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
def ground(x, y):   # DEM plus a broad (70 m) undulation: the snow is never perfectly planar
    return dem(x, y) + 3.0 * (fbm(x, y, 70.0, 3, 2) - 0.5)
Z0 = float(dem(np.array([0.0]), np.array([0.0]))[0]); EYE = Z0 + CAM_H
print("terrain at viewpoint", Z0, flush=True)
os.makedirs("assets-src/panorama/final/out", exist_ok=True); open("assets-src/panorama/final/out/terrain_z.txt", "w").write(str(Z0))

# ---------------- villages (real positions) ----------------
def enu(lat, lon): return ((lon - LON) * MLAT * math.cos(math.radians(lat)), (lat - LAT) * MLAT)
# name, lat, lon, lights, sigma along the valley (m), sigma across (m), clearing radius (m)
VILLAGES = [("Chamonix", 45.9237, 6.8694, 760, 650, 230, 650), ("Les Praz", 45.9400, 6.8830, 150, 280, 150, 330),
            ("Argentiere", 45.9800, 6.9270, 240, 380, 160, 420), ("Les Bossons", 45.8960, 6.8460, 150, 250, 130, 300),
            ("Les Pelerins", 45.9030, 6.8380, 90, 200, 110, 250), ("Les Houches", 45.8905, 6.7985, 280, 380, 170, 420),
            ("Le Lavancher", 45.9525, 6.9010, 70, 180, 100, 220), ("Les Tines", 45.9575, 6.9100, 60, 160, 90, 200)]
VILL_XY = np.array([enu(v[1], v[2]) for v in VILLAGES]); VILL_R = np.array([v[6] for v in VILLAGES])
VALLEY_BEARING = math.radians(45.0)     # the Chamonix valley runs SW -> NE
def village_clear(x, y):
    d = np.full(np.shape(x), 1e9)
    for (vx, vy), R in zip(VILL_XY, VILL_R):
        d = np.minimum(d, (np.hypot(x - vx, y - vy) - R))
    return smooth(0, 260, d)

# ---------------- forest and rock fields ----------------
def forest_density(x, y, z, slope, curv, nyn):
    lf = fbm(x, y, 900.0, 3, 1); mf = fbm(x, y, 140.0, 3, 2); cl = fbm(x, y, 95.0, 3, 0)
    tl = 2080.0 + (lf - 0.5) * 380.0                                    # ragged tree line
    alt = smooth(0, 1, (tl - z) / 420.0 + (mf - 0.5) * 0.55)           # thins out over the last ~400 m
    slope_f = 1 - smooth(36, 50, slope)
    base = 0.50 + 0.38 * smooth(5, 14, slope)                           # wooded slopes, patchy valley floor
    base = base + 0.24 * np.clip(curv / 0.02, -1, 1) + 0.14 * np.clip(nyn * 2.0, -1, 1)   # gullies, north faces
    clear = smooth(0.34, 0.47, cl) * np.where(slope < 7, smooth(0.42, 0.56, fbm(x, y, 260.0, 3, 3)), 1.0)
    return np.clip(alt * slope_f * base * clear * village_clear(x, y), 0, 1)
def stencil(x, y, h):
    z = ground(x, y); zx1 = ground(x + h, y); zx0 = ground(x - h, y); zy1 = ground(x, y + h); zy0 = ground(x, y - h)
    gx = (zx1 - zx0) / (2 * h); gy = (zy1 - zy0) / (2 * h)
    slope = np.degrees(np.arctan(np.hypot(gx, gy))); curv = (zx1 + zx0 + zy1 + zy0 - 4 * z) / (h * h)
    return z, slope, curv, -gy / np.sqrt(1 + gx * gx + gy * gy)

# ---------------- tree zones: real instanced conifers where the camera can see them well ----------------
# (d0, d1, max |azimuth| rel. MAIN (deg), spacing m, size multiplier, tiers, sides)
ZONES = [(100, 1200, 150, 3.3, 1.0, 3, 7), (1200, 2500, 150, 5.2, 1.5, 2, 6), (2500, 4600, 85, 9.0, 2.5, 2, 6)]
def in_zone_xy(x, y):
    d = np.hypot(x, y); az = (np.degrees(np.arctan2(x, y)) - HEADING + 180) % 360 - 180
    cov = np.zeros(np.shape(x), np.float32)
    for (d0, d1, am, *_r) in ZONES: cov = np.maximum(cov, ((d >= d0) & (d < d1) & (np.abs(az) <= am)).astype(np.float32))
    return cov
def tree_template(tiers, sides):
    # unit-height spruce: stacked drooping cones; tiers = list of (z_base, z_apex, radius)
    T = {3: [(-0.04, 0.50, 0.26), (0.26, 0.78, 0.19), (0.52, 1.0, 0.11)], 2: [(-0.04, 0.62, 0.25), (0.40, 1.0, 0.14)]}[tiers]
    V = []; F = []
    ang = np.arange(sides) * 2 * math.pi / sides
    for (zb, za, r) in T:
        b = len(V)
        for a in ang: V.append((r * math.cos(a), r * math.sin(a), zb))
        V.append((0, 0, za)); ap = b + sides
        for i in range(sides): F.append((b + i, b + (i + 1) % sides, ap))
    return np.array(V, np.float32), np.array(F, np.int32), sides
def build_trees():
    out = []
    trng = np.random.default_rng(21)
    for zi, (d0, d1, am, sp, sc, tiers, sides) in enumerate(ZONES):
        if d1 < lo - 40 or d0 > hi + 40: continue
        n = int(2 * d1 / sp) + 1
        gx = (np.arange(n) * sp - d1)
        XS = []; YS = []
        for i0 in range(0, n, 128):
            X, Y = np.meshgrid(gx, gx[i0:i0 + 128])
            X = (X + trng.uniform(-0.5, 0.5, X.shape) * sp).ravel(); Y = (Y + trng.uniform(-0.5, 0.5, Y.shape) * sp).ravel()
            d = np.hypot(X, Y); az = (np.degrees(np.arctan2(X, Y)) - HEADING + 180) % 360 - 180
            ok = (d >= max(d0, lo - 40)) & (d < min(d1, hi + 40)) & (np.abs(az) <= am); XS.append(X[ok]); YS.append(Y[ok])   # only what this layer can show
        X = np.concatenate(XS); Y = np.concatenate(YS)
        keep = []; chunks = []
        for i0 in range(0, len(X), 400000):
            x = X[i0:i0 + 400000]; y = Y[i0:i0 + 400000]
            zc, sl, cu, ny = stencil(x, y, 18.0)
            dens = forest_density(x, y, zc, sl, cu, ny)
            acc = trng.random(len(x)) < dens * 1.25
            chunks.append((x[acc], y[acc], zc[acc], dens[acc]))
        x = np.concatenate([c[0] for c in chunks]); y = np.concatenate([c[1] for c in chunks])
        z = np.concatenate([c[2] for c in chunks]); dn = np.concatenate([c[3] for c in chunks])
        T = len(x)
        Vt, Ft, ns = tree_template(tiers, sides); nv = len(Vt)
        Hh = (9.0 + trng.random(T) * 6.0) * sc * (0.55 + 0.45 * np.clip(dn * 1.5, 0, 1))
        # nothing may rise above -3 deg in the front +-62 deg within 1.2 km: the terrace view looks DOWN into the valley
        dd_ = np.hypot(x, y); az_ = (np.degrees(np.arctan2(x, y)) - HEADING + 180) % 360 - 180
        top_el = np.degrees(np.arctan2(z + Hh - EYE, dd_))
        okt = ~((np.abs(az_) <= 62) & (top_el > -3.0))
        x, y, z, dn, Hh = x[okt], y[okt], z[okt], dn[okt], Hh[okt]; T = len(x)
        yaw = trng.random(T) * 2 * math.pi; cy = np.cos(yaw).astype(np.float32); sy = np.sin(yaw).astype(np.float32)
        wid = (0.8 + 0.4 * trng.random(T)).astype(np.float32)
        jit = (1 + 0.22 * (trng.random((T, nv)) - 0.5)).astype(np.float32)
        vx = Vt[None, :, 0] * jit * wid[:, None]; vy = Vt[None, :, 1] * jit * wid[:, None]
        rx = vx * cy[:, None] - vy * sy[:, None]; ry = vx * sy[:, None] + vy * cy[:, None]
        Hf = Hh.astype(np.float32)[:, None]
        verts = np.stack([rx * Hf + x[:, None], ry * Hf + y[:, None], Vt[None, :, 2] * Hf + z[:, None] - 0.3], -1).astype(np.float32)
        faces = (Ft[None] + (np.arange(T, dtype=np.int64) * nv)[:, None, None]).reshape(-1, 3).astype(np.int32)
        tint = np.repeat(trng.random(T).astype(np.float32), nv)
        out.append((verts.reshape(-1, 3), faces, tint))
        log(f"trees zone {zi}: {T} trees, {len(faces)} tris")
    return out
def make_mesh(name, verts, faces, attrs, mat_):
    me = bpy.data.meshes.new(name); me.vertices.add(len(verts)); me.vertices.foreach_set("co", verts.ravel())
    k = faces.shape[1]
    me.loops.add(len(faces) * k); me.loops.foreach_set("vertex_index", faces.ravel())
    me.polygons.add(len(faces)); me.polygons.foreach_set("loop_start", np.arange(len(faces), dtype=np.int32) * k)
    me.polygons.foreach_set("loop_total", np.full(len(faces), k, np.int32)); me.polygons.foreach_set("use_smooth", np.ones(len(faces), bool))
    for nm, (typ, arr) in attrs.items():
        at = me.attributes.new(nm, typ, "POINT"); at.data.foreach_set("value" if typ == "FLOAT" else "color", arr.astype(np.float32).ravel())
    me.update(calc_edges=True)
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob); ob.data.materials.append(mat_)
    return ob

# ---------------- terrain rings ----------------
RINGS = [(750, 3.0, 0), (3200, 10.0, 750), (25000, 30.0, 3200), (110000, 160.0, 25000)]
scene = bpy.context.scene
for o in list(bpy.data.objects): bpy.data.objects.remove(o)
mat = bpy.data.materials.new("terrain"); mat.use_nodes = True
def box3(a):
    p = np.pad(a, 1, mode="edge"); s = 0
    for dy in range(3):
        for dx in range(3): s = s + p[dy:dy + a.shape[0], dx:dx + a.shape[1]]
    return s / 9.0
def ring_mesh(half, step, hole, idx):
    n = int(round(2 * half / step)) + 1
    xs = (np.arange(n) * step - half).astype(np.float64)
    out_h = np.empty((n, n), np.float32); X = np.empty((n, n), np.float32); Y = np.empty((n, n), np.float32)
    for i0 in range(0, n, 256):
        i1 = min(n, i0 + 256); gx, gy = np.meshgrid(xs, xs[i0:i1])
        out_h[i0:i1] = ground(gx, gy); X[i0:i1] = gx; Y[i0:i1] = gy
    gy_, gx_ = np.gradient(out_h.astype(np.float64), step)
    slope = np.degrees(np.arctan(np.hypot(gx_, gy_))).astype(np.float32)
    hs = box3(out_h.astype(np.float64)); gys, gxs = np.gradient(hs, step)
    slope_s = np.degrees(np.arctan(np.hypot(gxs, gys))).astype(np.float32)          # smoothed: no pixel-scale noise in the rock mask
    curv = ((np.roll(out_h, 1, 0) + np.roll(out_h, -1, 0) + np.roll(out_h, 1, 1) + np.roll(out_h, -1, 1) - 4 * out_h) / (step * step)).astype(np.float32)
    nyn = (-gy_ / np.sqrt(1 + gx_ ** 2 + gy_ ** 2)).astype(np.float32)
    dens = forest_density(X, Y, out_h, slope, curv, nyn).astype(np.float32)
    mf = fbm(X, Y, 140.0, 3, 2)
    rock = smooth(60, 73, slope_s + (mf - 0.5) * 5).astype(np.float32)               # cliffs only
    cov = in_zone_xy(X, Y)
    cells_x = (xs[:-1] + xs[1:]) / 2
    inside = (np.abs(cells_x)[None, :] < hole) & (np.abs(cells_x)[:, None] < hole)
    kept = ~inside
    ii, jj = np.nonzero(kept)
    quads = np.stack([ii * n + jj, ii * n + jj + 1, (ii + 1) * n + jj + 1, (ii + 1) * n + jj], 1)
    P = np.pad(kept | inside, 1, constant_values=False); ks = []
    for (di, dj, a) in [(-1, 0, "bottom"), (1, 0, "top"), (0, -1, "left"), (0, 1, "right")]:
        edge = kept & ~P[1 + di:1 + di + kept.shape[0], 1 + dj:1 + dj + kept.shape[1]]
        ei, ej = np.nonzero(edge)
        if a == "bottom": s0, s1 = ei * n + ej, ei * n + ej + 1
        elif a == "top": s0, s1 = (ei + 1) * n + ej + 1, (ei + 1) * n + ej
        elif a == "left": s0, s1 = (ei + 1) * n + ej, ei * n + ej
        else: s0, s1 = ei * n + ej + 1, (ei + 1) * n + ej + 1
        ks.append((s0, s1))
    s0 = np.concatenate([k[0] for k in ks]); s1 = np.concatenate([k[1] for k in ks])
    nv = n * n; ns = len(s0); skv = np.concatenate([s0, s1])
    sq = np.stack([s0, s1, nv + ns + np.arange(ns), nv + np.arange(ns)], 1)[:, ::-1]
    allq = np.concatenate([quads, sq]).astype(np.int32)
    verts = np.empty((nv + 2 * ns, 3), np.float32)
    verts[:nv, 0] = X.ravel(); verts[:nv, 1] = Y.ravel(); verts[:nv, 2] = out_h.ravel()
    verts[nv:, :] = verts[skv, :]; verts[nv:, 2] -= 250.0
    ext = lambda a: np.concatenate([a.ravel(), a.ravel()[skv]])
    make_mesh(f"ring{idx}", verts, allq, {"forest": ("FLOAT", ext(dens)), "rock": ("FLOAT", ext(rock)), "cov": ("FLOAT", ext(cov))}, mat)
    log(f"ring {idx}: {nv} verts, {len(allq)} quads")

# ---------------- materials ----------------
def new_mat_nodes(m_):
    nt_ = m_.node_tree; nt_.nodes.clear(); return nt_
class B:    # tiny node-building helper bound to a node tree
    def __init__(s, nt): s.nt = nt
    def nd(s, t, **kw):
        n = s.nt.nodes.new(t)
        for k, v in kw.items(): setattr(n, k, v)
        return n
    def mth(s, op, a=None, b=None):
        n = s.nd("ShaderNodeMath"); n.operation = op
        for i, v in enumerate((a, b)):
            if v is None: continue
            if isinstance(v, (int, float)): n.inputs[i].default_value = v
            else: s.nt.links.new(v, n.inputs[i])
        return n.outputs[0]
    def ramp(s, v, e0, e1):
        n = s.nd("ShaderNodeMapRange"); n.interpolation_type = "SMOOTHSTEP"; n.clamp = True
        n.inputs[1].default_value = e0; n.inputs[2].default_value = e1; s.nt.links.new(v, n.inputs[0]); return n.outputs[0]
    def mix(s, fac, a, b):
        n = s.nd("ShaderNodeMix"); n.data_type = "RGBA"; s.nt.links.new(fac, n.inputs["Factor"])
        for nm, v in (("A", a), ("B", b)):
            if isinstance(v, tuple): n.inputs[nm].default_value = v
            else: s.nt.links.new(v, n.inputs[nm])
        return n.outputs["Result"]
    def noise(s, vec, scale, detail, rough=0.55):
        n = s.nd("ShaderNodeTexNoise"); n.noise_dimensions = "3D"; n.inputs["Scale"].default_value = scale
        n.inputs["Detail"].default_value = detail; n.inputs["Roughness"].default_value = rough
        s.nt.links.new(vec, n.inputs["Vector"]); return n.outputs["Fac"]
    def finish(s, surf, pos_z, lo_, hi_):
        """haze (distance- and height-dependent extinction + in-scatter) and the distance clip for camera rays"""
        camd = s.nd("ShaderNodeCameraData"); dist = camd.outputs["View Distance"]
        zmid = s.mth("MULTIPLY", s.mth("ADD", pos_z, EYE), 0.5)
        dens = s.mth("MULTIPLY", s.mth("POWER", 2.718281828, s.mth("MULTIPLY", s.mth("MAXIMUM", s.mth("SUBTRACT", zmid, 900.0), 0.0), -1 / 1100.0)), 1 / 22000.0)
        T = s.mth("POWER", 2.718281828, s.mth("MULTIPLY", s.mth("MULTIPLY", dist, dens), -1.0))
        em = s.nd("ShaderNodeEmission"); em.inputs["Color"].default_value = (*HAZE_COLOR, 1)
        hz = s.nd("ShaderNodeMixShader"); s.nt.links.new(s.mth("SUBTRACT", 1.0, T), hz.inputs[0]); s.nt.links.new(surf, hz.inputs[1]); s.nt.links.new(em.outputs[0], hz.inputs[2])
        lp = s.nd("ShaderNodeLightPath"); back = s.nd("ShaderNodeNewGeometry").outputs["Backfacing"]
        out_range = s.mth("ADD", s.mth("LESS_THAN", dist, lo_), s.mth("GREATER_THAN", dist, hi_)) if not NOCLIP else 0.0
        kill = s.mth("MINIMUM", s.mth("MULTIPLY", s.mth("ADD", out_range, back), lp.outputs["Is Camera Ray"]), 1.0)
        tr = s.nd("ShaderNodeBsdfTransparent"); fin = s.nd("ShaderNodeMixShader")
        s.nt.links.new(kill, fin.inputs[0]); s.nt.links.new(hz.outputs[0], fin.inputs[1]); s.nt.links.new(tr.outputs[0], fin.inputs[2])
        o = s.nd("ShaderNodeOutputMaterial"); s.nt.links.new(fin.outputs[0], o.inputs["Surface"])

SNOW_A, SNOW_B = (0.74, 0.79, 0.88, 1), (0.88, 0.91, 0.97, 1)
def terrain_shader():
    b = B(new_mat_nodes(mat)); nt = b.nt
    geo = b.nd("ShaderNodeNewGeometry"); P = geo.outputs["Position"]
    fa = b.nd("ShaderNodeAttribute", attribute_name="forest"); ra = b.nd("ShaderNodeAttribute", attribute_name="rock"); ca = b.nd("ShaderNodeAttribute", attribute_name="cov")
    sep = b.nd("ShaderNodeSeparateXYZ"); nt.links.new(P, sep.inputs[0])
    n1 = b.noise(P, 0.12, 5); n2 = b.noise(P, 0.5, 3); nlow = b.noise(P, 0.02, 3)
    vor = b.nd("ShaderNodeTexVoronoi"); vor.feature = "F1"; vor.inputs["Scale"].default_value = 0.11; nt.links.new(P, vor.inputs["Vector"])
    # forest mask: ragged edge from fine noise
    Fm = b.ramp(b.mth("ADD", fa.outputs["Fac"], b.mth("MULTIPLY", b.mth("SUBTRACT", n1, 0.5), 0.6)), 0.38, 0.55)
    Rm = b.ramp(b.mth("ADD", ra.outputs["Fac"], b.mth("MULTIPLY", b.mth("SUBTRACT", n1, 0.5), 0.12)), 0.45, 0.55)
    snow = b.mix(b.ramp(nlow, 0.35, 0.7), SNOW_A, SNOW_B)
    # where no tree geometry exists: crowns as a texture (Voronoi cells = crowns, bright snow-dusted tops)
    crown = b.ramp(b.mth("SUBTRACT", 1.0, vor.outputs["Distance"]), 0.35, 0.95)
    crownc = b.mix(b.mth("MULTIPLY", crown, b.ramp(n2, 0.3, 0.8)), (0.004, 0.014, 0.020, 1), (0.16, 0.22, 0.32, 1))
    floor_ = b.mix(b.ramp(n2, 0.62, 0.8), (0.006, 0.014, 0.020, 1), (0.20, 0.25, 0.34, 1))   # forest floor under real trees: dark, flecks of snow
    forest = b.mix(b.mth("SUBTRACT", 1.0, ca.outputs["Fac"]), floor_, crownc)
    rockc = b.mix(n1, (0.030, 0.034, 0.050, 1), (0.062, 0.070, 0.092, 1))
    col = b.mix(Rm, b.mix(Fm, snow, forest), rockc)
    bsdf = b.nd("ShaderNodeBsdfPrincipled"); nt.links.new(col, bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.65; bsdf.inputs["Specular IOR Level"].default_value = 0.25
    bump = b.nd("ShaderNodeBump"); bump.inputs["Distance"].default_value = 1.0; bump.inputs["Strength"].default_value = 0.12
    nt.links.new(b.mth("ADD", b.mth("MULTIPLY", nlow, 0.7), b.mth("MULTIPLY", n1, 0.3)), bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    b.finish(bsdf.outputs["BSDF"], sep.outputs["Z"], lo, hi)
    if MODE == "cover":
        nt.nodes.clear(); e = nt.nodes.new("ShaderNodeEmission"); o = nt.nodes.new("ShaderNodeOutputMaterial"); nt.links.new(e.outputs[0], o.inputs["Surface"])
tree_mat = bpy.data.materials.new("trees"); tree_mat.use_nodes = True
def tree_shader():
    b = B(new_mat_nodes(tree_mat)); nt = b.nt
    geo = b.nd("ShaderNodeNewGeometry"); P = geo.outputs["Position"]; Nn = geo.outputs["Normal"]
    ta = b.nd("ShaderNodeAttribute", attribute_name="tint")
    sepn = b.nd("ShaderNodeSeparateXYZ"); nt.links.new(Nn, sepn.inputs[0]); sepp = b.nd("ShaderNodeSeparateXYZ"); nt.links.new(P, sepp.inputs[0])
    nz = sepn.outputs["Z"]; n2 = b.noise(P, 0.9, 3)
    sf = b.ramp(b.mth("ADD", b.mth("ADD", nz, b.mth("MULTIPLY", b.mth("SUBTRACT", n2, 0.5), 0.9)), b.mth("MULTIPLY", b.mth("SUBTRACT", ta.outputs["Fac"], 0.5), 0.7)), 0.48, 0.80)
    canopy = b.mix(n2, (0.003, 0.012, 0.015, 1), (0.009, 0.026, 0.028, 1))
    col = b.mix(sf, canopy, (0.55, 0.64, 0.80, 1))
    bsdf = b.nd("ShaderNodeBsdfPrincipled"); nt.links.new(col, bsdf.inputs["Base Color"]); bsdf.inputs["Roughness"].default_value = 0.8
    bsdf.inputs["Specular IOR Level"].default_value = 0.2
    b.finish(bsdf.outputs["BSDF"], sepp.outputs["Z"], lo, hi)
    if MODE == "cover":
        nt.nodes.clear(); e = nt.nodes.new("ShaderNodeEmission"); o = nt.nodes.new("ShaderNodeOutputMaterial"); nt.links.new(e.outputs[0], o.inputs["Surface"])
terrain_shader(); tree_shader()

# ---------------- build ----------------
if MODE != "marker":
    SEL = [int(v) for v in opt("--rings", "0,1,2,3").split(",")]
    for i, (half, step, hole) in enumerate(RINGS):
        if i in SEL: ring_mesh(half, step, hole, i)
    if "--notrees" not in argv and MODE != "cover":
        for zi, (v, f, tint) in enumerate(build_trees()):
            make_mesh(f"trees{zi}", v, f, {"tint": ("FLOAT", tint)}, tree_mat)
        log("trees built")


# ---------------- the villages light the snow: warm point lights above each cluster ----------------
def build_village_glow():
    lr = np.random.default_rng(5); cs, sn = math.sin(VALLEY_BEARING), math.cos(VALLEY_BEARING); tot = 0
    for (name, la, lo_, cnt, sa, sc_, R) in VILLAGES:
        cx, cy = enu(la, lo_); nl = max(2, cnt // 55); P = GLOW_POWER * (cnt / 760.0) ** 0.9 / nl
        for k in range(nl):
            u = lr.normal(0, sa * 0.7); v = lr.normal(0, sc_ * 0.7)
            x = cx + u * cs + v * sn; y = cy + u * sn - v * cs; z = float(ground(np.array([x]), np.array([y]))[0]) + 38.0
            L = bpy.data.lights.new(f"glow_{name}_{k}", "POINT"); L.energy = P; L.color = (1.0, 0.50, 0.20); L.shadow_soft_size = 30.0
            ob = bpy.data.objects.new(L.name, L); scene.collection.objects.link(ob); ob.location = (x, y, z); tot += 1
    log(f"village glow lights: {tot}")
def build_river():
    """the river as a dark ribbon: the lowest point across the valley, searched along the chain of villages"""
    order = sorted(range(len(VILLAGES)), key=lambda i: (VILLAGES[i][2], VILLAGES[i][1]))
    P0 = [VILL_XY[i] for i in order]; pts = []
    for a, b_ in zip(P0[:-1], P0[1:]):
        L = float(np.hypot(*(b_ - a))); n = max(2, int(L / 40)); t = np.linspace(0, 1, n, endpoint=False)
        pts.append(a[None] + (b_ - a)[None] * t[:, None])
    pts = np.concatenate(pts + [P0[-1][None]]); d = np.gradient(pts, axis=0); d /= np.maximum(np.hypot(d[:, 0], d[:, 1]), 1e-6)[:, None]
    nrm = np.stack([-d[:, 1], d[:, 0]], 1); offs = np.arange(-450, 451, 15.0)
    C = pts[:, None, :] + nrm[:, None, :] * offs[None, :, None]
    Hh = ground(C[..., 0], C[..., 1]) + 0.03 * np.abs(offs)[None, :]      # lowest point, a little biased towards the line
    best = offs[Hh.argmin(1)]; k = 9; best = np.convolve(np.pad(best, k, mode="edge"), np.ones(2 * k + 1) / (2 * k + 1), mode="valid")
    cen = pts + nrm * best[:, None]; dd = np.gradient(cen, axis=0); dd /= np.maximum(np.hypot(dd[:, 0], dd[:, 1]), 1e-6)[:, None]
    nn = np.stack([-dd[:, 1], dd[:, 0]], 1); wdt = 9.0
    A = cen + nn * wdt; Bq = cen - nn * wdt
    zA = ground(A[:, 0], A[:, 1]) + 0.35; zB = ground(Bq[:, 0], Bq[:, 1]) + 0.35
    V = np.concatenate([np.c_[A, zA], np.c_[Bq, zB]]).astype(np.float32); n = len(cen)
    F = np.array([(i, i + 1, n + i + 1, n + i) for i in range(n - 1)], np.int32)
    rm = bpy.data.materials.new("river"); rm.use_nodes = True; b = B(new_mat_nodes(rm)); nt = b.nt
    bs = b.nd("ShaderNodeBsdfPrincipled"); bs.inputs["Base Color"].default_value = (0.006, 0.012, 0.022, 1); bs.inputs["Roughness"].default_value = 0.12
    sp = b.nd("ShaderNodeSeparateXYZ"); nt.links.new(b.nd("ShaderNodeNewGeometry").outputs["Position"], sp.inputs[0])
    b.finish(bs.outputs["BSDF"], sp.outputs["Z"], lo, hi)
    make_mesh("river", V, F, {}, rm); log("river ribbon", n)

# ---------------- village lights ----------------
def build_lights():
    lr = np.random.default_rng(3); pts = []; cols = []; strs = []
    def add(x, y, s, c): pts.append((x, y)); strs.append(s); cols.append(c)
    def warm():
        t = lr.random()
        if lr.random() < 0.12: return (0.78 + 0.1 * t, 0.9, 1.0)           # a few cool-white LEDs
        return (1.0, 0.45 + 0.35 * t, 0.12 + 0.28 * t)                       # tungsten / halogen
    cs, sn = math.sin(VALLEY_BEARING), math.cos(VALLEY_BEARING)
    for (name, la, lo_, cnt, sa, sc_, R) in VILLAGES:
        cx, cy = enu(la, lo_); k = 0; tries = 0
        while k < cnt and tries < cnt * 20:
            tries += 1
            u = lr.normal(0, sa); v = lr.normal(0, sc_)
            x = cx + u * cs + v * sn; y = cy + u * sn - v * cs      # u along the valley (NE), v across
            zc, sl, _c, _n = stencil(np.array([x]), np.array([y]), 15.0)
            if sl[0] > 22: continue
            add(x, y, math.exp(lr.normal(0.0, 0.55)) * 1.0, warm()); k += 1
    # road with sparse street lights joining the clusters in order along the valley
    chain = [5, 3, 4, 0, 1, 6, 7, 2]       # Les Houches, Bossons, Pelerins, Chamonix, Praz, Lavancher, Tines, Argentiere
    order = [VILLAGES.index(v) for v in sorted(VILLAGES, key=lambda v: (v[2], v[1]))]
    P0 = [tuple(VILL_XY[i]) for i in order]
    for a, b_ in zip(P0[:-1], P0[1:]):
        L = math.hypot(b_[0] - a[0], b_[1] - a[1]); n = int(L / 70)
        for k in range(n):
            t = k / max(n, 1); x = a[0] + (b_[0] - a[0]) * t + lr.normal(0, 12); y = a[1] + (b_[1] - a[1]) * t + lr.normal(0, 12)
            add(x, y, 0.55 + 0.3 * lr.random(), (1.0, 0.72, 0.36))
    # isolated chalets on the lower slopes
    for (name, la, lo_, cnt, sa, sc_, R) in VILLAGES:
        cx, cy = enu(la, lo_)
        for _ in range(int(cnt * 0.22)):
            a = lr.random() * 2 * math.pi; r = R + lr.uniform(150, 1500)
            x = cx + r * math.cos(a); y = cy + r * math.sin(a)
            zc, sl, _c, _n = stencil(np.array([x]), np.array([y]), 15.0)
            if sl[0] > 30 or zc[0] > 1750: continue
            for j in range(lr.integers(1, 3)):
                add(x + lr.normal(0, 8), y + lr.normal(0, 8), 0.8 + lr.random() * 1.4, warm())
    pts = np.array(pts); z = ground(pts[:, 0], pts[:, 1]) + 4.0
    keep = np.hypot(pts[:, 0], pts[:, 1]) > 130
    pts, z = pts[keep], z[keep]; strs = np.array(strs, np.float32)[keep]; cols = np.array(cols, np.float32)[keep]
    dist = np.sqrt(pts[:, 0] ** 2 + pts[:, 1] ** 2 + (z - EYE) ** 2)
    rad = np.maximum(0.7, dist * 0.00032).astype(np.float32)         # at least ~0.45 px across, so they stay crisp
    ov = np.array([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], np.float32)
    of = np.array([[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]], np.int32)
    V = (ov[None] * rad[:, None, None]) + np.stack([pts[:, 0], pts[:, 1], z], 1)[:, None, :]
    F = (of[None] + (np.arange(len(pts)) * 6)[:, None, None]).reshape(-1, 3).astype(np.int32)
    area = (rad / np.maximum(0.7, 0.00032 * dist)) ** 0   # radius already scales with distance
    emis = np.repeat(strs * (30.0 + 0.0 * dist), 6)                   # relative brightness x base strength
    colv = np.repeat(cols, 6, axis=0)
    lm = bpy.data.materials.new("lights"); lm.use_nodes = True; b = B(new_mat_nodes(lm)); nt = b.nt
    ca = b.nd("ShaderNodeAttribute", attribute_name="lcol"); sa_ = b.nd("ShaderNodeAttribute", attribute_name="lstr")
    em = b.nd("ShaderNodeEmission"); nt.links.new(ca.outputs["Color"], em.inputs["Color"]); nt.links.new(sa_.outputs["Fac"], em.inputs["Strength"])
    pg = b.nd("ShaderNodeNewGeometry"); sepp = b.nd("ShaderNodeSeparateXYZ"); nt.links.new(pg.outputs["Position"], sepp.inputs[0])
    b.finish(em.outputs[0], sepp.outputs["Z"], lo, hi)
    make_mesh("lights", V.reshape(-1, 3).astype(np.float32), F, {"lcol": ("FLOAT_COLOR", np.concatenate([colv, np.ones((len(colv), 1), np.float32)], 1)), "lstr": ("FLOAT", emis.astype(np.float32))}, lm)
    log(f"lights: {len(pts)}")
if MODE == "beauty" and "--nolights" not in argv: build_lights()
if MODE == "beauty" and "--nolights" not in argv:
    build_village_glow(); build_river()
if MODE == "marker":
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
for nm, val in (("latitude_min", math.radians(EL_MIN)), ("latitude_max", math.radians(EL_MAX)), ("longitude_min", math.radians(LON_A)), ("longitude_max", math.radians(LON_B))):
    try: setattr(cam, nm, val)
    except Exception: setattr(cam.cycles, nm, val)
cam.clip_start = 0.05; cam.clip_end = 1e6
co = bpy.data.objects.new("cam", cam); scene.collection.objects.link(co); scene.camera = co
co.location = (0, 0, EYE); co.rotation_euler = (math.pi / 2, 0, -math.radians(HEADING))

sun = bpy.data.lights.new("moon", "SUN"); sun.energy = MOON_STRENGTH; sun.color = MOON_COLOR; sun.angle = math.radians(0.55)
so = bpy.data.objects.new("moon", sun); scene.collection.objects.link(so)
az = math.radians(HEADING + MOON_AZ); el = math.radians(MOON_EL)
toward = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))
so.rotation_euler = (-toward).to_track_quat("-Z", "Y").to_euler()
world = bpy.data.worlds.new("w"); world.use_nodes = True; scene.world = world
wn = world.node_tree.nodes; wn.clear()
bg = wn.new("ShaderNodeBackground"); bg.inputs["Color"].default_value = (*AMBIENT, 1); bg.inputs["Strength"].default_value = AMBIENT_STRENGTH
wo = wn.new("ShaderNodeOutputWorld"); world.node_tree.links.new(bg.outputs[0], wo.inputs[0])

r = scene.render; r.engine = "CYCLES"; r.resolution_x = W; r.resolution_y = H; r.resolution_percentage = 100
r.film_transparent = True; r.image_settings.file_format = "OPEN_EXR"; r.image_settings.color_depth = "16"; r.image_settings.color_mode = "RGBA"
r.threads_mode = "FIXED"; r.threads = 5
cy = scene.cycles; cy.device = "CPU"
if MODE == "cover": cy.samples = 8; cy.use_denoising = False; cy.use_adaptive_sampling = False; cy.max_bounces = 0
elif MODE == "marker": cy.samples = 1; cy.use_denoising = False; cy.max_bounces = 0
else:
    cy.samples = SAMPLES; cy.use_adaptive_sampling = True; cy.adaptive_threshold = 0.02; cy.adaptive_min_samples = 16
    cy.use_denoising = "--nodenoise" not in argv; cy.denoiser = "OPENIMAGEDENOISE"; cy.max_bounces = 3; cy.diffuse_bounces = 2; cy.glossy_bounces = 2
    cy.transmission_bounces = 0
cy.transparent_max_bounces = 64; cy.filter_width = 1.2
scene.view_settings.view_transform = "Standard"
r.filepath = outpath
log("scene built", W, H)
bpy.ops.render.render(write_still=True)
log("DONE", layer, W, H)
