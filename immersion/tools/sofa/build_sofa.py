"""
U-shaped lounge sectional + throw pillows, generated procedurally (headless Blender).

Run from immersion/ (see tools/sofa/README.md):
  blender -b --python tools/sofa/build_sofa.py -- assets-src/sofa

Everything is computed in the app's glTF frame (X east, Y up, Z south, metres) with numpy,
then converted to Blender's Z-up frame only when the meshes are created; the glTF exporter's
+Y-up conversion brings it back, so the model drops in at the origin with no transform.

Technique: every cushion is a subdivided rounded box (ellipsoidal corner projection, denser
rows in the rounded zones), then deformed deterministically: pillow inflation weighted per
face (crowned top, compressed edges), slouch, dimple + corner ears on back cushions, radial
folds from the corners, low-frequency fabric undulation. Piping is a thin tube along the
top-edge crest loop. Throw pillows are two-sheet knife-edge shells settled onto the seat
and back cushions by a small rigid contact solver against a BVH of the sofa.
No cloth simulation, so the result is fully deterministic.
"""
import sys, os, json, math
import numpy as np
import bpy
from mathutils.bvhtree import BVHTree

# --------------------------------------------------------------------------------------
# Tunable dimensions (metres, glTF frame: X east, Y up, Z south)
# --------------------------------------------------------------------------------------
SEED = 20261110
FLOOR_GAP = 0.062            # base floats this high above the floor
OUT_BACK_X = -2.55           # outer back of the long side
SEAT_FRONT_X = -1.50         # front edge of the long side seat
Z_NORTH_BACK = -3.85         # outer back of the north wing
Z_NORTH_FRONT = -2.83        # front edge of the north wing seat
Z_SOUTH_FRONT = -0.17        # front edge of the south wing seat
Z_SOUTH_BACK = 0.85          # outer back of the south wing
WING_END_X = 1.25            # seats end here, arms start
ARM_END_X = 1.47
SHELL_T = 0.14               # back shell thickness
SHELL_INSET = 0.019          # the shell swells this much outward: keeps the outer bbox on the footprint
SHELL_TOP = 0.82
ARM_TOP = 0.64
DECK_TOP = 0.225
SEAT_BASE = 0.22             # underside of seat cushions
SEAT_H = 0.225               # nominal cushion thickness (before crown)
SEAT_CROWN = 0.033           # extra height at the centre of a seat cushion
SEAT_BOTTOM_R, SEAT_TOP_R = 0.03, 0.09
BACK_H = 0.50                # back cushion height
BACK_T = 0.27                # back cushion thickness
BACK_LEAN_DEG = 12.0
BACK_TOP_R = 0.085
SEAT_GAP = 0.040             # nominal gap between neighbouring modules
PIPING_R = 0.0075
CORNER_STEPS = 4             # mesh rows inside each rounded zone
MID_STEP = 0.085             # mesh spacing on flat zones
PILLOW_GRID = 23
PILLOW_SIZES = (0.44, 0.52)
PILLOW_THICK = 0.088         # half thickness at the centre
BUDGET = {"sofa_cushions": 70000, "sofa_frame": 18000, "pillows_a": 14000, "pillows_b": 14000}

OUT = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "assets-src/sofa"
rng_master = np.random.default_rng(SEED)

# --------------------------------------------------------------------------------------
# Mesh container
# --------------------------------------------------------------------------------------
class Mesh:
    def __init__(self, name):
        self.name = name
        self.V = np.zeros((0, 3))
        self.F = []
        self.UV = []

    def add(self, V, F, UV):
        off = len(self.V)
        self.V = np.vstack([self.V, np.asarray(V, float)])
        self.F += [tuple(int(i) + off for i in f) for f in F]
        self.UV += UV

    def tris(self):
        return sum(len(f) - 2 for f in self.F)


def unit(v):
    v = np.asarray(v, float)
    return v / np.linalg.norm(v, axis=-1, keepdims=True)


def smoothstep(x):
    x = np.clip(x, 0, 1)
    return x * x * (3 - 2 * x)

# --------------------------------------------------------------------------------------
# Rounded block on a non-uniform lattice
# --------------------------------------------------------------------------------------
def axis_pts(H, rlo, rhi, kz, step):
    left = -H + rlo * np.linspace(0, 1, kz + 1)
    right = H - rhi * np.linspace(1, 0, kz + 1)
    span = (H - rhi) - (-H + rlo)
    n = max(1, int(round(span / step)))
    mid = (-H + rlo) + span * np.arange(1, n) / n
    return np.concatenate([left, mid, right])


def build_block(H, radii, uvax, drop=((2, -1),), kz=CORNER_STEPS, step=MID_STEP, crest_axis=(2, 1)):
    """Rounded box centred at the origin. radii[axis] = (r_low, r_high).
    Returns pre-deformation points P, normals N, quads F, per-corner UV, crest loop (ids)."""
    H = np.asarray(H, float)
    axes = [axis_pts(H[i], radii[i][0], radii[i][1], kz, step) for i in range(3)]
    n = [len(a) for a in axes]
    idx, pts = {}, []

    def vid(i, j, k):
        key = (i, j, k)
        if key not in idx:
            idx[key] = len(pts)
            pts.append((axes[0][i], axes[1][j], axes[2][k]))
        return idx[key]

    F, UVq = [], []
    # face grids: normal axis a, tangent axes (b, c) cyclic so (b, c, a) is right-handed
    for a in range(3):
        b, c = (a + 1) % 3, (a + 2) % 3
        for sgn in (+1, -1):
            if (a, sgn) in drop:
                continue
            fixed = n[a] - 1 if sgn > 0 else 0
            for ib in range(n[b] - 1):
                for ic in range(n[c] - 1):
                    cs = [(ib, ic), (ib + 1, ic), (ib + 1, ic + 1), (ib, ic + 1)]
                    if sgn < 0:
                        cs = cs[::-1]
                    quad, uv = [], []
                    for (qb, qc) in cs:
                        ij = [0, 0, 0]
                        ij[a], ij[b], ij[c] = fixed, qb, qc
                        quad.append(vid(*ij))
                        loc = (axes[0][ij[0]], axes[1][ij[1]], axes[2][ij[2]])
                        uvq = uvax[a]
                        uv.append((loc[uvq[0]], loc[uvq[1]]))
                    F.append(tuple(quad))
                    UVq.append(uv)
    V = np.array(pts)
    # ellipsoidal rounding
    r = np.array(radii, float)
    c = V.copy()
    for ax in range(3):
        c[:, ax] = np.clip(V[:, ax], -(H[ax] - r[ax][0]), H[ax] - r[ax][1])
    d = V - c
    rr = np.where(d >= 0, r[:, 1][None, :], r[:, 0][None, :])
    dn = d / rr
    ln = np.linalg.norm(dn, axis=1, keepdims=True)
    ln[ln == 0] = 1
    dn = dn / ln
    P = c + dn * rr
    N = unit(dn / rr)
    # crest loop around the (axis, sign) face: boundary of that face's grid, in order
    ca, cs_ = crest_axis
    b, cc = (ca + 1) % 3, (ca + 2) % 3
    fixed = n[ca] - 1 if cs_ > 0 else 0
    ring = []
    for ib in range(n[b] - 1):
        ring.append((ib, 0))
    for ic in range(n[cc] - 1):
        ring.append((n[b] - 1, ic))
    for ib in range(n[b] - 1, 0, -1):
        ring.append((ib, n[cc] - 1))
    for ic in range(n[cc] - 1, 0, -1):
        ring.append((0, ic))
    crest = []
    for (qb, qc) in ring:
        ij = [0, 0, 0]
        ij[ca], ij[b], ij[cc] = fixed, qb, qc
        crest.append(idx[tuple(ij)])
    return P, N, F, UVq, crest


def piping_tube(Q, Nrm, radius, sides=5, lift=0.002):
    """Closed tube along loop Q (points) with surface normals Nrm. Returns V, F, UV."""
    m = len(Q)
    T = np.roll(Q, -1, 0) - np.roll(Q, 1, 0)
    T = unit(T)
    Bn = unit(np.cross(T, Nrm))
    Nn = unit(np.cross(Bn, T))
    seg = np.linalg.norm(np.roll(Q, -1, 0) - Q, axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    V, F, UV = [], [], []
    for i in range(m):
        for k in range(sides):
            th = 2 * math.pi * k / sides
            V.append(Q[i] + Nrm[i] * lift + radius * (math.cos(th) * Nn[i] + math.sin(th) * Bn[i]))
    for i in range(m):
        i2 = (i + 1) % m
        for k in range(sides):
            k2 = (k + 1) % sides
            F.append((i * sides + k, i2 * sides + k, i2 * sides + k2, i * sides + k2))
            u0, u1 = s[i], s[i + 1]
            v0, v1 = k * 2 * math.pi * radius / sides, (k + 1) * 2 * math.pi * radius / sides
            UV.append([(u0, v0), (u1, v0), (u1, v1), (u0, v1)])
    V = np.array(V)
    # make the tube face outward whatever the loop's direction
    f0 = F[0]
    nrm0 = np.cross(V[f0[1]] - V[f0[0]], V[f0[2]] - V[f0[0]])
    cen = V[:sides].mean(0)
    if np.dot(nrm0, V[list(f0)].mean(0) - cen) < 0:
        F = [f[::-1] for f in F]
        UV = [u[::-1] for u in UV]
    return V, F, UV

# --------------------------------------------------------------------------------------
# Deformations
# --------------------------------------------------------------------------------------
def inflate(P, N, H, Bc, Ba, Bb):
    ta, tb, tc = P[:, 0] / H[0], P[:, 1] / H[1], P[:, 2] / H[2]
    na, nb, nc = N[:, 0], N[:, 1], N[:, 2]
    B = Bc * np.maximum(nc, 0) ** 2 + Ba * na ** 2 + Bb * nb ** 2
    w = (1 - ta ** 2 * (1 - na ** 2)) * (1 - tb ** 2 * (1 - nb ** 2)) * (1 - tc ** 2 * (1 - nc ** 2))
    return P + N * (B * np.clip(w, 0, 1))[:, None]


def undulation(P, N, rng, amp, lam=(0.22, 0.55), waves=3, mask=None):
    out = np.zeros(len(P))
    for _ in range(waves):
        d = unit(rng.normal(size=3))
        k = 2 * math.pi / rng.uniform(*lam)
        out += amp * rng.uniform(0.5, 1) * np.sin(P @ d * k + rng.uniform(0, 6.28))
    if mask is not None:
        out = out * mask
    return P + N * out[:, None]


def corner_folds(P, N, H, rng, amp, rad=0.16, axes=(0, 1), cycles=2.0, mask=None):
    """Radial tension folds fanning out of the four corners of the (axes) plane."""
    a0, a1 = axes
    out = np.zeros(len(P))
    for sa in (-1, 1):
        for sb in (-1, 1):
            qa = sa * H[a0] - P[:, a0]
            qb = sb * H[a1] - P[:, a1]
            dist = np.hypot(qa, qb)
            ang = np.arctan2(qb, qa)
            ph = rng.uniform(0, 6.28)
            a_ = amp * rng.uniform(0.6, 1.1)
            out += a_ * np.exp(-dist / rad) * np.sin(ang * (cycles * 2 / math.pi * 2) + ph) * smoothstep(dist / 0.03)
    if mask is not None:
        out = out * mask
    return P + N * out[:, None]


def wobble(P, H, rng, amp):
    """Low-frequency in-plane warp: cushion outlines (and so the piping) are never ruler-straight."""
    P = P.copy()
    for ax_from, ax_to in ((1, 0), (0, 1), (0, 2), (1, 2)):
        k = rng.uniform(1.2, 2.4)
        P[:, ax_to] += amp * (0.4 if ax_to == 2 else 1.0) * np.sin(P[:, ax_from] / H[ax_from] * k * math.pi / 2 + rng.uniform(0, 6.28))
    return P


def make_cushion(kind, Ha, Hb, Hc, rng, rt=SEAT_TOP_R, rbot=SEAT_BOTTOM_R, rside=0.07):
    """Canonical frame (a width, b depth-or-height, c thickness-or-facing); c+ is the visible face."""
    H = np.array([Ha, Hb, Hc])
    radii = [(rside, rside), (rside, rside), (rbot, rt)]
    P, N, F, UV, crest = build_block(H, radii, uvax={0: (1, 2), 1: (0, 2), 2: (0, 1)},
                                     drop=((2, -1),) if kind == 'seat' else ())
    if kind == "seat":
        P = inflate(P, N, H, Bc=SEAT_CROWN * rng.uniform(0.85, 1.15), Ba=0.016, Bb=0.016)
        P = wobble(P, H, rng, 0.009)
        ta, tb = P[:, 0] / Ha, P[:, 1] / Hb
        top = np.maximum(N[:, 2], 0) ** 2
        # slouch: front edge drops, the crown drifts off-centre
        P[:, 2] -= rng.uniform(0.010, 0.020) * np.maximum(tb, 0) ** 2 * top
        P[:, 2] += 0.006 * rng.uniform(-1, 1) * ta * top
        P[:, 1] += rng.uniform(-0.007, 0.007) * np.sin(ta * 2.5 + rng.uniform(0, 6)) * np.maximum(N[:, 1], 0)
        P = corner_folds(P, N, H, rng, 0.0045, rad=0.15, mask=top)
        P = undulation(P, N, rng, 0.0028, mask=np.maximum(N[:, 2], 0))
        P = undulation(P, N, rng, 0.0015, lam=(0.12, 0.25), waves=2)
    else:
        P = inflate(P, N, H, Bc=0.060 * rng.uniform(0.85, 1.15), Ba=0.016, Bb=0.020)
        P = wobble(P, H, rng, 0.007)
        # the top of a loose back cushion folds backward under its own weight
        P[:, 2] -= rng.uniform(0.010, 0.026) * np.maximum(P[:, 1] / Hb, 0) ** 2
        ta, tb = P[:, 0] / Ha, P[:, 1] / Hb
        top = np.maximum(N[:, 2], 0) ** 2
        # gentle central dimple, corner "ears", slump of the top edge
        P[:, 2] -= 0.018 * rng.uniform(0.7, 1.2) * np.exp(-(ta ** 2 * 3.0 + (tb - 0.08) ** 2 * 3.5)) * top
        ear = (np.abs(ta) ** 3) * (np.maximum(tb, 0) ** 3)
        P[:, 1] += 0.022 * rng.uniform(0.7, 1.2) * ear
        P[:, 2] += 0.012 * ear * np.maximum(N[:, 2], 0)
        P[:, 0] += 0.012 * np.sign(ta) * ear
        P[:, 2] -= 0.010 * rng.uniform(0, 1) * np.maximum(tb, 0) ** 3 * top * np.sin(ta * 2 + rng.uniform(0, 6))
        P = corner_folds(P, N, H, rng, 0.0050, rad=0.17, mask=top)
        P = undulation(P, N, rng, 0.0032, mask=np.maximum(N[:, 2], 0))
        P = undulation(P, N, rng, 0.0015, lam=(0.12, 0.25), waves=2)
    # piping along the crest loop of the visible face
    Pn = unit(inflate_normals(N))
    pv, pf, puv = piping_tube(P[crest], Pn[crest], PIPING_R)
    return P, F, UV, pv, pf, puv


def inflate_normals(N):
    return N


def rot_axis(axis, ang):
    axis = unit(axis)
    c, s = math.cos(ang), math.sin(ang)
    x, y, z = axis
    return np.array([[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
                     [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
                     [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]])


def place(mesh, P, F, UV, pv, pf, puv, M, origin):
    """Transform canonical points by M (columns = canonical axes in world) and add to the mesh."""
    det = np.linalg.det(M)
    flip = det < 0
    W = P @ M.T + origin
    Wp = pv @ M.T + origin
    Fo = [f[::-1] for f in F] if flip else F
    UVo = [u[::-1] for u in UV] if flip else UV
    Fp = [f[::-1] for f in pf] if flip else pf
    UVp = [u[::-1] for u in puv] if flip else puv
    # sanity: faces must point away from the cushion's centre
    cen = W.mean(0)
    good = 0
    for f in Fo:
        a, b, c = W[f[0]], W[f[1]], W[f[2]]
        good += np.dot(np.cross(b - a, c - a), W[list(f)].mean(0) - cen) > 0
    if good < 0.85 * len(Fo):
        print("WARNING inverted cushion", good, len(Fo))
    mesh.add(W, Fo, UVo)
    mesh.add(Wp, Fp, UVp)
    return W

# --------------------------------------------------------------------------------------
# Layout
# --------------------------------------------------------------------------------------
INNER_LONG_X = OUT_BACK_X + SHELL_INSET + SHELL_T   # inner face of the long back
INNER_N_Z = Z_NORTH_BACK + SHELL_INSET + SHELL_T
INNER_S_Z = Z_SOUTH_BACK - SHELL_INSET - SHELL_T
UP = np.array([0, 1.0, 0])
SEAT_TOPS = []
PARTS = []   # (kind, vertices, faces) of every cushion, for the overlap check

# wall descriptors: front direction f, along-wall u, point on the inner face used as origin
WALLS = {
    "long": dict(f=np.array([1.0, 0, 0]), u=np.array([0, 0, 1.0])),
    "north": dict(f=np.array([0, 0, 1.0]), u=np.array([-1.0, 0, 0])),
    "south": dict(f=np.array([0, 0, -1.0]), u=np.array([1.0, 0, 0])),
}


def wall_point(wall, s, depth):
    """World xz position: s along the wall (world coordinate on the wall axis), depth from inner face."""
    if wall == "long":
        return np.array([INNER_LONG_X + depth, 0, s])
    if wall == "north":
        return np.array([s, 0, INNER_N_Z + depth])
    return np.array([s, 0, INNER_S_Z - depth])


def build_cushions():
    cush = Mesh("sofa_cushions")
    seats = []   # (wall, s_center, width, depth)
    backs = []
    # seat modules: (wall, along-wall centre, width, depth from inner face, depth centre)
    # corner (north/south) seats belong to the long wall frame
    pitch_mid = (Z_SOUTH_FRONT - Z_NORTH_FRONT) / 3
    long_depth = SEAT_FRONT_X - INNER_LONG_X
    n_depth = Z_NORTH_FRONT - INNER_N_Z
    s_depth = INNER_S_Z - Z_SOUTH_FRONT
    modules = []
    modules.append(("long", INNER_N_Z + n_depth / 2, n_depth, long_depth))          # north corner
    for i in range(3):
        modules.append(("long", Z_NORTH_FRONT + pitch_mid * (i + 0.5), pitch_mid, long_depth))
    modules.append(("long", Z_SOUTH_FRONT + s_depth / 2, s_depth, long_depth))      # south corner
    wing_pitch = (WING_END_X - SEAT_FRONT_X) / 3
    for i in range(3):
        modules.append(("north", SEAT_FRONT_X + wing_pitch * (i + 0.5), wing_pitch, n_depth))
        modules.append(("south", SEAT_FRONT_X + wing_pitch * (i + 0.5), wing_pitch, s_depth))
    for (wall, s, width, depth) in modules:
        rng = np.random.default_rng(rng_master.integers(1 << 31))
        w = WALLS[wall]
        Ha = (width - SEAT_GAP) / 2 * rng.uniform(0.985, 1.005)
        corner = wall == "long" and (s - INNER_N_Z < 0.5 * depth + 0.1 or INNER_S_Z - s < 0.5 * depth + 0.1)
        shrink = 0.9 * SEAT_GAP if corner else 0.004
        Hb = (depth - shrink) / 2
        Hc = SEAT_H / 2 * rng.uniform(0.97, 1.03)
        P, F, UV, pv, pf, puv = make_cushion("seat", Ha, Hb, Hc, rng)
        M = np.stack([w["u"], w["f"], UP], 1)
        # small pitch/yaw so no two modules are aligned perfectly
        M = rot_axis(w["f"], math.radians(rng.uniform(-0.8, 0.8))) @ rot_axis(w["u"], math.radians(rng.uniform(-0.8, 0.8))) @ rot_axis(UP, math.radians(rng.uniform(-0.5, 0.5))) @ M
        o = wall_point(wall, s, depth / 2 - (shrink / 2 if corner else 0.0))
        o[1] = SEAT_BASE + Hc + rng.uniform(-0.002, 0.003)
        Wc = place(cush, P, F, UV, pv, pf, puv, M, o)
        PARTS.append(("seat", Wc, F))
        SEAT_TOPS.append(Wc[:, 1].max())
        seats.append((wall, s, width, depth))

    # back cushions
    def lean_frame(wall, s, rng, Hb, Hc, lean_deg):
        L = math.radians(lean_deg)
        w = WALLS[wall]
        f, u = w["f"], w["u"]
        n = f * math.cos(L) + UP * math.sin(L)            # facing direction of the cushion
        t = -f * math.sin(L) + UP * math.cos(L)           # "up" along the cushion
        # back-face plane passes 8 mm in front of the shell's inner face at the shell top
        y_touch, gap = SHELL_TOP, 0.008
        # distance from the inner face (along f) at height y on the back plane: d = gap - (y - y_touch) * tan(L)
        # centre height target
        y_c = 0.447 - 0.012 + Hb * math.cos(L)
        # back face point at centre height: d0 + (y-yt)*..., plane: (x - P0).n = 0 -> d = gap - (y - y_touch)*sin/cos
        d_back = gap - (y_c - y_touch) * math.tan(L)
        # centre is Hc along n from the back plane (in the f direction: Hc / cos(L))
        d_c = d_back + Hc / math.cos(L)
        o = wall_point(wall, s, d_c)
        o[1] = y_c
        M = np.stack([u, t, n], 1)
        return M, o

    back_mods = []
    n_back_long = 5
    pitch = (INNER_S_Z - INNER_N_Z) / n_back_long
    for i in range(n_back_long):
        back_mods.append(("long", INNER_N_Z + pitch * (i + 0.5), pitch))
    x0 = -1.97
    pw = (WING_END_X - x0) / 4
    for i in range(4):
        back_mods.append(("north", x0 + pw * (i + 0.5), pw))
        back_mods.append(("south", x0 + pw * (i + 0.5), pw))
    back_info = []
    for (wall, s, width) in back_mods:
        rng = np.random.default_rng(rng_master.integers(1 << 31))
        Ha = (width - SEAT_GAP) / 2 * rng.uniform(0.985, 1.005)
        Hb = BACK_H / 2 * rng.uniform(0.985, 1.03)
        Hc = BACK_T / 2 * rng.uniform(0.95, 1.05)
        lean = BACK_LEAN_DEG + rng.uniform(-1.8, 1.8)
        P, F, UV, pv, pf, puv = make_cushion("back", Ha, Hb, Hc, rng, rt=0.075, rbot=0.06, rside=BACK_TOP_R)
        M, o = lean_frame(wall, s, rng, Hb, Hc, lean)
        # a touch of sideways roll
        M = rot_axis(M[:, 2], math.radians(rng.uniform(-1.2, 1.2))) @ M
        Wb = place(cush, P, F, UV, pv, pf, puv, M, o)
        PARTS.append(("back", Wb, F))
        back_info.append(dict(wall=wall, s=s, width=width, lean=lean))
    return cush, seats, back_info

# --------------------------------------------------------------------------------------
# Frame: swept back shell + arms + plinth
# --------------------------------------------------------------------------------------
def rounded_profile(hw, y0, y1, rtop, rbot, ks=5, nv=7, nh=3):
    """Closed profile in (w, y) -> points, outward normals, perimeter coordinate. Starts at the bottom centre."""
    pts, nrm = [], []
    # build by hand: bottom centre -> bottom-right corner -> right side -> top-right -> top -> top-left -> left -> bottom-left -> back
    out = []
    # bottom edge right half
    for i in range(nh + 1):
        out.append((hw * 0 + (hw - rbot) * i / nh, y0, 0, -1))
    # bottom-right corner
    for i in range(1, ks + 1):
        a = -math.pi / 2 + (math.pi / 2) * i / ks
        out.append((hw - rbot + rbot * math.cos(a), y0 + rbot + rbot * math.sin(a), math.cos(a), math.sin(a)))
    # right side
    for i in range(1, nv):
        out.append((hw, y0 + rbot + (y1 - rtop - y0 - rbot) * i / nv, 1, 0))
    # top-right corner
    for i in range(0, ks + 1):
        a = (math.pi / 2) * i / ks
        out.append((hw - rtop + rtop * math.cos(a), y1 - rtop + rtop * math.sin(a), math.cos(a), math.sin(a)))
    # top edge
    for i in range(1, 2 * nh):
        out.append(((hw - rtop) - 2 * (hw - rtop) * i / (2 * nh), y1, 0, 1))
    # top-left corner
    for i in range(0, ks + 1):
        a = math.pi / 2 + (math.pi / 2) * i / ks
        out.append((-(hw - rtop) + rtop * math.cos(a), y1 - rtop + rtop * math.sin(a), math.cos(a), math.sin(a)))
    for i in range(1, nv):
        out.append((-hw, y1 - rtop - (y1 - rtop - y0 - rbot) * i / nv, -1, 0))
    for i in range(0, ks + 1):
        a = math.pi + (math.pi / 2) * i / ks
        out.append((-(hw - rbot) + rbot * math.cos(a), y0 + rbot + rbot * math.sin(a), math.cos(a), math.sin(a)))
    for i in range(1, nh):
        out.append((-(hw - rbot) + (hw - rbot) * i / nh, y0, 0, -1))
    out = np.array(out)
    return out[:, :2], out[:, 2:]


def build_frame():
    fr = Mesh("sofa_frame")
    rng = np.random.default_rng(rng_master.integers(1 << 31))
    # ---- swept shell along the U path (centre line)
    cxl = OUT_BACK_X + SHELL_INSET + SHELL_T / 2
    czn = Z_NORTH_BACK + SHELL_INSET + SHELL_T / 2
    czs = Z_SOUTH_BACK - SHELL_INSET - SHELL_T / 2
    xe = WING_END_X + 0.06
    R = 0.15
    path = []   # (x, z)
    def line(p, q, step=0.15):
        p, q = np.array(p), np.array(q)
        L = np.linalg.norm(q - p)
        n = max(1, int(round(L / step)))
        return [tuple(p + (q - p) * i / n) for i in range(n + 1)]
    segs = line((xe, czn), (cxl + R, czn))
    for i in range(1, 9):
        a = (math.pi / 2) * i / 8
        segs.append((cxl + R - R * math.sin(a), czn + R - R * math.cos(a)))
    segs += line((cxl, czn + R), (cxl, czs - R))[1:]
    for i in range(1, 9):
        a = (math.pi / 2) * i / 8
        segs.append((cxl + R - R * math.cos(a), czs - R + R * math.sin(a)))
    segs += line((cxl + R, czs), (xe, czs))[1:]
    path = np.array(segs)
    tang = np.zeros_like(path)
    tang[1:-1] = path[2:] - path[:-2]
    tang[0] = path[1] - path[0]
    tang[-1] = path[-1] - path[-2]
    tang /= np.linalg.norm(tang, axis=1, keepdims=True)
    inside = np.stack([tang[:, 1], -tang[:, 0]], 1)          # (x, z) toward the seat
    s_arc = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(path, axis=0), axis=1))])
    prof, pn = rounded_profile(SHELL_T / 2, FLOOR_GAP, SHELL_TOP, 0.062, 0.03, ks=4, nv=4, nh=2)
    npf = len(prof)
    per = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(np.vstack([prof, prof[:1]]), axis=0), axis=1))])
    ytop_c = (FLOOR_GAP + SHELL_TOP) / 2
    rings = []
    ring_s = []
    for i, (p, ins) in enumerate(zip(path, inside)):
        ring = []
        for (w, y), (nw, ny) in zip(prof, pn):
            # pillowed upholstery: the outer face and top swell, slow undulation along the run
            hy = (SHELL_TOP - FLOOR_GAP) / 2
            wgt = (1 - ((y - ytop_c) / hy) ** 2 * (1 - ny ** 2)) * (1 - (w / (SHELL_T / 2)) ** 2 * (1 - nw ** 2))
            wgt = max(0.0, wgt)
            bulge = 0.014 * wgt * (1 + 0.35 * math.sin(s_arc[i] * 2 * math.pi / 0.9 + 1.3))
            if ny < -0.3:
                bulge = 0.0
            if nw > 0.2:
                bulge *= 0.3          # inner face is hidden behind the cushions
            wv = w + nw * bulge
            yv = y + ny * bulge
            ring.append(np.array([p[0] + ins[0] * wv, yv, p[1] + ins[1] * wv]))
        rings.append(np.array(ring))
        ring_s.append(s_arc[i])
    rings = np.array(rings)                       # (stations, profile, 3)
    # end caps: shrink the profile to a pole over a few rings
    def cap(ring, tangent_xz, direction, ks=5, depth=0.07):
        out = []
        cen = ring.mean(0)
        t3 = np.array([tangent_xz[0], 0, tangent_xz[1]]) * direction
        for k in range(1, ks + 1):
            a = (math.pi / 2) * k / ks
            sc = math.cos(a)
            out.append(cen + (ring - cen) * sc + t3 * depth * math.sin(a))
        return np.array(out)
    cap0 = cap(rings[0], tang[0], -1)
    cap1 = cap(rings[-1], tang[-1], +1)
    # assemble quads
    V = []
    UV = []
    F = []
    # main grid
    ns = len(rings)
    base = 0
    for i in range(ns):
        V.extend(rings[i])
    for i in range(ns - 1):
        for j in range(npf):
            j2 = (j + 1) % npf
            F.append((i * npf + j, (i + 1) * npf + j, (i + 1) * npf + j2, i * npf + j2))
            u0, u1 = ring_s[i], ring_s[i + 1]
            v0, v1 = per[j], per[j + 1]
            UV.append([(u0, v0), (u1, v0), (u1, v1), (u0, v1)])
    # caps
    for (rg, first_idx, sgn, s_ref) in ((cap0, 0, -1, ring_s[0]), (cap1, (ns - 1) * npf, +1, ring_s[-1])):
        prev = first_idx
        prev_s = s_ref
        for k in range(len(rg)):
            last = k == len(rg) - 1
            if last:
                # pole: collapse the ring to its centre
                pole = len(V)
                V.append(rg[k].mean(0))
                for j in range(npf):
                    j2 = (j + 1) % npf
                    a, b = prev + j, prev + j2
                    tri = (a, b, pole) if sgn > 0 else (b, a, pole)
                    F.append(tri)
                    ss = prev_s + sgn * 0.02
                    uvs = [(prev_s, per[j]), (prev_s, per[j + 1]), (ss, (per[j] + per[j + 1]) / 2)]
                    UV.append(uvs if sgn > 0 else [uvs[1], uvs[0], uvs[2]])
            else:
                cur = len(V)
                V.extend(rg[k])
                cs = s_ref + sgn * (0.07 * (k + 1) / len(rg))
                for j in range(npf):
                    j2 = (j + 1) % npf
                    q = (prev + j, cur + j, cur + j2, prev + j2) if sgn > 0 else (prev + j2, cur + j2, cur + j, prev + j)
                    F.append(q)
                    uvq = [(prev_s, per[j]), (cs, per[j]), (cs, per[j + 1]), (prev_s, per[j + 1])]
                    UV.append(uvq if sgn > 0 else uvq[::-1])
                prev, prev_s = cur, cs
    V = np.array(V)
    # orientation check on the main grid: outward normal of the top should face +Y
    fo = F[len(rings[0]) // 2 + 0]
    # find a face on top-centre of the first run
    def face_normal(f):
        a, b, c = V[f[0]], V[f[1]], V[f[2]]
        return np.cross(b - a, c - a)
    top_j = int(np.argmax(prof[:, 1] + 1e-6 * (-np.abs(prof[:, 0]))))
    n_chk = face_normal(F[(ns // 2) * npf + top_j])
    if n_chk[1] < 0:
        F = [f[::-1] for f in F]
        UV = [u[::-1] for u in UV]
    # small free-form tension noise on the shell
    Nsh = np.zeros_like(V)
    fr.add(V, F, UV)

    # ---- arms and plinth: rounded blocks, world-axis UVs
    def block(c, half, radii, B, name_seed, drop=(), kz=3, step=0.12):
        r2 = np.random.default_rng(name_seed)
        H = np.array(half)
        P, N, F2, UV2, _ = build_block(H, radii, uvax={0: (2, 1), 1: (0, 2), 2: (0, 1)}, drop=drop, kz=kz, step=step, crest_axis=(1, 1))
        if B > 0:
            P = inflate(P, N, H, B, B, B) if False else P
            # uniform swelling: weight by the three face coordinates
            t = P / H
            w = np.clip((1 - t[:, 0] ** 2 * (1 - N[:, 0] ** 2)) * (1 - t[:, 1] ** 2 * (1 - N[:, 1] ** 2)) * (1 - t[:, 2] ** 2 * (1 - N[:, 2] ** 2)), 0, 1)
            P = P + N * (B * w)[:, None]
        P = undulation(P, N, r2, 0.0028)
        P = corner_folds(P, N, H, r2, 0.0025, axes=(0, 2), mask=np.maximum(N[:, 1], 0))
        fr.add(P + np.array(c), F2, UV2)

    zn0, zn1 = Z_NORTH_BACK, Z_NORTH_FRONT
    zs0, zs1 = Z_SOUTH_FRONT, Z_SOUTH_BACK
    ay0, ay1 = FLOOR_GAP, ARM_TOP
    ARM_SW = 0.012   # the arm swells by this much
    for (z0, z1, sd) in ((zn0 + ARM_SW, zn1, 11), (zs0, zs1 - ARM_SW, 12)):
        half = [(ARM_END_X - ARM_SW - WING_END_X) / 2, (ay1 - ARM_SW - ay0) / 2, (z1 - z0) / 2]
        c = [(ARM_END_X - ARM_SW + WING_END_X) / 2, (ay1 - ARM_SW + ay0) / 2, (z0 + z1) / 2]
        radii = [(0.085, 0.095), (0.04, 0.10), (0.085, 0.085)]
        block(c, half, radii, 0.012, sd, drop=())
    # plinth: three recessed slabs under the cushions
    d0, d1 = FLOOR_GAP, DECK_TOP
    slabs = [
        ((OUT_BACK_X + 0.10, -1.54), (Z_NORTH_BACK + 0.10, Z_SOUTH_BACK - 0.10)),
        ((-1.60, WING_END_X + 0.02), (Z_NORTH_BACK + 0.10, Z_NORTH_FRONT - 0.04)),
        ((-1.60, WING_END_X + 0.02), (Z_SOUTH_FRONT + 0.04, Z_SOUTH_BACK - 0.10)),
    ]
    for k, ((x0, x1), (z0, z1)) in enumerate(slabs):
        half = [(x1 - x0) / 2, (d1 - d0) / 2, (z1 - z0) / 2]
        c = [(x0 + x1) / 2, (d0 + d1) / 2, (z0 + z1) / 2]
        radii = [(0.02, 0.02), (0.015, 0.02), (0.02, 0.02)]
        block(c, half, radii, 0.0, 20 + k, drop=((1, -1),), kz=2, step=0.6)
    return fr

# --------------------------------------------------------------------------------------
# Pillows
# --------------------------------------------------------------------------------------
def make_pillow(Ha, rng, nG=PILLOW_GRID):
    t = -np.cos(np.linspace(0, math.pi, nG))               # cosine spacing, denser at the border
    T = PILLOW_THICK * rng.uniform(0.9, 1.1)
    verts, idx = [], {}
    top_ids = np.zeros((nG, nG), int)
    bot_ids = np.zeros((nG, nG), int)
    squash = rng.uniform(0.0, 0.1)
    for i in range(nG):
        for j in range(nG):
            tx, ty = t[i], t[j]
            gx = max(0.0, 1 - abs(tx) ** 1.7) ** 0.75
            gy = max(0.0, 1 - abs(ty) ** 1.7) ** 0.75
            h = T * gx * gy
            # the stuffing pulls the middle of every edge in; corners stay out
            pull = (1 - 0.07 * (h / T)) * (1 - 0.14 * (abs(tx) * abs(ty)) ** 2.5)
            x, y = tx * Ha * pull, ty * Ha * pull
            border = (i in (0, nG - 1)) or (j in (0, nG - 1))
            top_ids[i, j] = len(verts)
            verts.append((x, y, h))
            if border:
                bot_ids[i, j] = top_ids[i, j]
            else:
                bot_ids[i, j] = len(verts)
                verts.append((x, y, -h * (0.93 + squash * 0.5)))
    P = np.array(verts)
    # normals approx for wrinkle displacement
    Nn = np.zeros_like(P)
    Nn[:, 2] = np.where(P[:, 2] >= 0, 1.0, -1.0)
    mask = np.ones(len(P))
    Hh = np.array([Ha, Ha, 1.0])
    P = corner_folds(P, Nn, Hh, rng, 0.0070, rad=0.13, axes=(0, 1))
    P = undulation(P, Nn, rng, 0.0035, lam=(0.18, 0.4))
    # cupping / sag
    P[:, 2] += rng.uniform(-0.03, 0.03) * (P[:, 0] / Ha) ** 2 - rng.uniform(0, 0.03) * (P[:, 1] / Ha) ** 2
    # dog-ears: the corners droop to one side
    cx_, cy_ = P[:, 0] / Ha, P[:, 1] / Ha
    P[:, 2] -= rng.uniform(0.012, 0.03) * (np.abs(cx_) * np.abs(cy_)) ** 3 * np.sign(cx_ * cy_ + 1e-6) * rng.choice([-1, 1])
    F, UV = [], []
    for i in range(nG - 1):
        for j in range(nG - 1):
            q = [top_ids[i, j], top_ids[i + 1, j], top_ids[i + 1, j + 1], top_ids[i, j + 1]]
            F.append(tuple(q))
            UV.append([(P[k, 0], P[k, 1]) for k in q])
            qb = [bot_ids[i, j], bot_ids[i, j + 1], bot_ids[i + 1, j + 1], bot_ids[i + 1, j]]
            F.append(tuple(qb))
            UV.append([(P[k, 0] + 0.37, P[k, 1] + 0.11) for k in qb])
    return P, F, UV


def clear_of(V, bvh, margin):
    """True when no vertex is closer than `margin` to, or inside, the sofa."""
    for co in V:
        hit = bvh.find_nearest((float(co[0]), float(co[1]), float(co[2])), 0.15)
        if hit[0] is None:
            continue
        loc, nrm, _, dist = hit
        sd = (co[0] - loc[0]) * nrm[0] + (co[1] - loc[1]) * nrm[1] + (co[2] - loc[2]) * nrm[2]
        if sd < margin:
            return False
    return True


def lowest_rest(V0, bvh, margin, y_hi=1.45, y_lo=0.30):
    """Drop the pillow straight down from y_hi until it touches: bisect on a vertical shift."""
    lo, hi = y_lo, y_hi
    sub = V0
    for _ in range(14):
        mid = (lo + hi) / 2
        if clear_of(sub + np.array([0, mid, 0]), bvh, margin):
            hi = mid
        else:
            lo = mid
    return hi


def settle_pillow(V0, bvh, wall, s, margin=0.004):
    """V0: pillow points with its centre at the origin, already oriented. Slide toward the back
    cushion in small steps; at each distance drop it; the resting place is the closest one to
    the wall at which the pillow still touches the seat (otherwise it would perch on the back)."""
    w = WALLS[wall]
    f = w["f"]
    best = None
    y_flat = None
    d = 0.60
    while d > 0.02:
        o = wall_point(wall, s, d)
        base = V0 + np.array([o[0], 0, o[2]])
        y = lowest_rest(base, bvh, margin)
        if y_flat is None:
            y_flat = y
        if y > y_flat + 0.012:
            break
        best = (d, y)
        d -= 0.01
    d, y = best
    print('  SETTLE', wall, round(s, 2), 'd', round(d, 2), 'y', round(y, 3), 'y_flat', round(y_flat, 3))
    o = wall_point(wall, s, d)
    V = V0 + np.array([o[0], y, o[2]])
    return V


def min_signed_distance(V, bvh):
    m = 1e9
    for co in V:
        hit = bvh.find_nearest(tuple(co), 0.2)
        if hit[0] is None:
            continue
        loc, nrm, _, dist = hit
        sd = (co[0] - loc[0]) * nrm[0] + (co[1] - loc[1]) * nrm[1] + (co[2] - loc[2]) * nrm[2]
        m = min(m, sd)
    return m


def build_pillows(world_mesh_list, back_info):
    bv, bf = [], []
    off = 0
    for m in world_mesh_list:
        bv.append(m.V)
        bf += [tuple(i + off for i in f) for f in m.F]
        off += len(m.V)
    bvh = BVHTree.FromPolygons(np.vstack(bv).tolist(), bf)
    pa, pb = Mesh("pillows_a"), Mesh("pillows_b")
    gdir = np.array([0, -1.0, 0])
    specs = []
    # five on the long side, one on each of the five back cushions
    long_s = [b["s"] for b in back_info if b["wall"] == "long"]
    for k, s in enumerate(long_s):
        specs.append(("long", s + [0.30, -0.10, 0.04, 0.10, -0.29][k], pa, [-12, 22, -6, 31, 8][k], [4, 6, 3, 8, 5][k]))
    n_s = sorted([b["s"] for b in back_info if b["wall"] == "north"])
    s_s = sorted([b["s"] for b in back_info if b["wall"] == "south"])
    specs.append(("north", n_s[1] + 0.05, pb, 14, 6))
    specs.append(("north", n_s[3] - 0.10, pb, -24, 4))
    specs.append(("south", s_s[1] - 0.04, pb, -9, 5))
    specs.append(("south", s_s[3] - 0.08, pb, 28, 7))
    report = []
    for (wall, s, target, roll_deg, extra_tilt) in specs:
        rng = np.random.default_rng(rng_master.integers(1 << 31))
        Ha = rng.uniform(*PILLOW_SIZES) / 2
        P, F, UV = make_pillow(Ha, rng)
        w = WALLS[wall]
        L = math.radians(BACK_LEAN_DEG + extra_tilt + 8)
        n = w["f"] * math.cos(L) + UP * math.sin(L)
        t = -w["f"] * math.sin(L) + UP * math.cos(L)
        # local x -> along wall (rolled), local y -> up the pillow, local z -> its face
        M0 = np.stack([w["u"], t, n], 1)
        M = M0 @ rot_axis(np.array([0, 0, 1.0]), math.radians(roll_deg))
        V = settle_pillow(P @ M.T, bvh, wall, s)
        sd = min_signed_distance(V, bvh)
        print('PILLOW pos', wall, round(s,2), 'minsd', round(sd,3))
        if sd < -0.01:
            for co in V:
                hit = bvh.find_nearest(tuple(co), 0.3)
                if hit[0] is not None:
                    l, nr, ix, dd = hit
                    sdv = np.dot(co - np.array(l), np.array(nr))
                    if sdv < -0.05:
                        print('  BAD', np.round(co, 3), 'near', np.round(np.array(l), 3), 'n', np.round(np.array(nr), 2), 'poly', ix, 'dd', round(dd, 3)); break
        report.append(dict(wall=wall, size=round(2 * Ha, 3), min_sd=round(sd, 4), y=[round(V[:, 1].min(), 3), round(V[:, 1].max(), 3)]))
        det = np.linalg.det(M)
        Fo = [f[::-1] for f in F] if det < 0 else F
        UVo = [u[::-1] for u in UV] if det < 0 else UV
        target.add(V, Fo, UVo)
    return pa, pb, report

# --------------------------------------------------------------------------------------
# Blender objects + export
# --------------------------------------------------------------------------------------
def to_object(mesh, mat):
    V = mesh.V
    Vb = np.stack([V[:, 0], -V[:, 2], V[:, 1]], 1)
    me = bpy.data.meshes.new(mesh.name)
    me.from_pydata(Vb.tolist(), [], [list(f) for f in mesh.F])
    me.update()
    uvl = me.uv_layers.new(name="UVMap")
    flat = np.array([c for f in mesh.UV for c in f], float)
    assert len(flat) == len(me.loops), (mesh.name, len(flat), len(me.loops))
    uvl.data.foreach_set("uv", flat.ravel())
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.materials.append(mat)
    ob = bpy.data.objects.new(mesh.name, me)
    bpy.context.scene.collection.objects.link(ob)
    return ob


def main():
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    cush, seats, back_info = build_cushions()
    frame = build_frame()
    pa, pb, rep = build_pillows([cush, frame], back_info)
    meshes = [frame, cush, pa, pb]
    tri = {m.name: m.tris() for m in meshes}
    bbox = {m.name: [m.V.min(0).round(4).tolist(), m.V.max(0).round(4).tolist()] for m in meshes}
    allV = np.vstack([m.V for m in meshes])
    # neighbours of the same kind must not poke through each other
    bvhs = [BVHTree.FromPolygons(W.tolist(), [list(f) for f in F]) for (_, W, F) in PARTS]
    hits = 0
    for i in range(len(PARTS)):
        for j in range(i + 1, len(PARTS)):
            if PARTS[i][0] == PARTS[j][0]:
                h_ = len(bvhs[i].overlap(bvhs[j]))
                hits += h_
                if h_:
                    print('  overlap', PARTS[i][0], i, PARTS[j][0], j, h_, np.round(PARTS[i][1].mean(0), 2), np.round(PARTS[j][1].mean(0), 2))
    print("SAME-KIND CUSHION OVERLAPS (triangle pairs)", hits)
    print("SEATTOP", round(min(SEAT_TOPS), 3), round(float(np.mean(SEAT_TOPS)), 3), round(max(SEAT_TOPS), 3))
    print("TRIANGLES", tri, "total", sum(tri.values()))
    print("BBOX", bbox)
    print("ALL", allV.min(0).round(3), allV.max(0).round(3))
    for r in rep:
        print("PILLOW", r)
    for k, v in BUDGET.items():
        if tri[k] > v:
            print("OVER BUDGET", k, tri[k], v)
    objs = []
    # The glTF exporter only writes TEXCOORD_0 when the material samples a texture, so each placeholder
    # material carries a 1x1 image node on its base colour. tools/sofa/optimize.mjs strips the texture again.
    colours = {"sofa_frame": (0.70, 0.62, 0.50), "sofa_cushions": (0.74, 0.66, 0.54),
               "pillows_a": (0.50, 0.40, 0.32), "pillows_b": (0.60, 0.60, 0.55)}
    for m in meshes:
        mat = bpy.data.materials.new(m.name + "_mat")
        mat.use_nodes = True
        mat.use_backface_culling = True
        nt = mat.node_tree
        bsdf = nt.nodes["Principled BSDF"]
        img = bpy.data.images.new(m.name + "_px", 1, 1)
        img.pixels = [*colours[m.name], 1.0]
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        objs.append(to_object(m, mat))
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "sofa.blend"))
    raw = os.path.join(OUT, "sofa_raw.gltf")
    bpy.ops.export_scene.gltf(filepath=raw, export_format="GLTF_SEPARATE", use_selection=True, export_yup=True,
                              export_apply=False, export_texcoords=True, export_normals=True, export_tangents=False,
                              export_materials="EXPORT", export_image_format="AUTO", export_cameras=False,
                              export_lights=False, export_extras=False)
    json.dump({"tri": tri, "bbox": bbox, "pillows": rep, "seatTop": float(np.mean(SEAT_TOPS))}, open(os.path.join(OUT, "stats.json"), "w"), indent=1)


main()
