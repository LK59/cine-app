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
SHELL_INSET_X = 0.047        # same for the long back: leaves room for the plaid hanging behind it
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
MID_STEP = 0.062             # mesh spacing on flat zones
LIGHTMAP_MARGIN = 8 / 1024   # island margin: 8 px at 1024x1024
LIGHTMAP_SHRINK = 0.985      # whole atlas scaled about its centre so every UV stays inside 0.005..0.995
PLAID_LEN, PLAID_W, PLAID_ZC = 1.70, 1.30, -2.75   # throw blanket: length (drape direction), width, centre Z
PLAID_HANG = 0.12            # how far the blanket hangs down behind the backrest
PLAID_CLEAR = 0.0075         # clearance of the blanket's mid-surface above the cushions
PILLOW_GRID = 25
PILLOW_SIZES = (0.44, 0.52)
PILLOW_THICK = 0.078         # half thickness at the centre
BUDGET = {"sofa_cushions": 85000, "sofa_frame": 18000, "pillows_a": 18000, "pillows_b": 18000, "plaid": 14000}
TOTAL_BUDGET = 130000

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
        self.seams = []      # vertex-id pairs marked as UV1 seams
        self.lm = None       # optional explicit UV1 per face corner (parametric meshes: the plaid)

    def add(self, V, F, UV, seams=None):
        off = len(self.V)
        if seams:
            self.seams += [(int(a) + off, int(b) + off) for a, b in seams]
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
    neg = []
    fixed_n = 0 if cs_ > 0 else n[ca] - 1
    for (qb, qc) in ring:
        ij = [0, 0, 0]
        ij[ca], ij[b], ij[cc] = fixed_n, qb, qc
        neg.append(idx[tuple(ij)])
    cut = []
    for k in range(n[ca]):
        ij = [0, 0, 0]
        ij[ca], ij[b], ij[cc] = k if cs_ < 0 else n[ca] - 1 - k, 0, 0
        cut.append(idx[tuple(ij)])
    return P, N, F, UVq, crest, dict(neg=neg, cut=cut)


def ring_edges(ids):
    return [(ids[i], ids[(i + 1) % len(ids)]) for i in range(len(ids))]


def chain_edges(ids):
    return [(ids[i], ids[i + 1]) for i in range(len(ids) - 1)]


QUARTERS = 1


def tube_seams(m, sides):
    """Cut a closed tube along its length and into four strips (so its UV1 islands pack well)."""
    e = [(i * sides, ((i + 1) % m) * sides) for i in range(m)]
    for q in range(QUARTERS):
        i = (m * q) // 4
        e += [(i * sides + k, i * sides + (k + 1) % sides) for k in range(sides)]
    return e


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


def corner_creases(P, N, H, rng, amp, rad, axes=(0, 1), mask=None, nmax=4):
    """Soft creases (valleys with a small ridge beside them) fanning out of each corner of the
    visible face, like upholstery pulled over a corner."""
    a0, a1 = axes
    out = np.zeros(len(P))
    for sa in (-1, 1):
        for sb in (-1, 1):
            qa = sa * H[a0] - P[:, a0]
            qb = sb * H[a1] - P[:, a1]
            qa, qb = np.abs(qa), np.abs(qb)
            dist = np.hypot(qa, qb)
            ang = np.arctan2(qb, qa)
            for _ in range(int(rng.integers(2, nmax + 1))):
                a_c = rng.uniform(0.18, math.pi / 2 - 0.18)
                w = rng.uniform(0.11, 0.2)
                depth = amp * rng.uniform(0.45, 1.25)
                ln = rad * rng.uniform(0.7, 1.5)
                fall = np.exp(-dist / ln) * smoothstep(dist / 0.045)
                out += -depth * np.exp(-((ang - a_c) / w) ** 2) * fall
                out += 0.4 * depth * np.exp(-((ang - a_c - 1.9 * w) / w) ** 2) * fall
    if mask is not None:
        out = out * mask
    return P + N * out[:, None]


def make_cushion(kind, Ha, Hb, Hc, rng, rt=SEAT_TOP_R, rbot=SEAT_BOTTOM_R, rside=0.07):
    """Canonical frame (a width, b depth-or-height, c thickness-or-facing); c+ is the visible face."""
    H = np.array([Ha, Hb, Hc])
    radii = [(rside, rside), (rside, rside), (rbot, rt)]
    P, N, F, UV, crest, info = build_block(H, radii, uvax={0: (1, 2), 1: (0, 2), 2: (0, 1)},
                                           drop=((2, -1),) if kind == 'seat' else ())
    # one island for the visible face + the belt (a cup cut at one corner): the piping crest stays inside it,
    # so the crease between piping and cushion shares texels with its neighbours; the hidden rear is its own island
    seams = chain_edges(info['cut'])
    if kind == 'back':
        seams += ring_edges(info['neg'])
    if kind == "seat":
        P = inflate(P, N, H, Bc=SEAT_CROWN * rng.uniform(0.85, 1.15), Ba=0.016, Bb=0.016)
        P = wobble(P, H, rng, 0.009)
        ta, tb = P[:, 0] / Ha, P[:, 1] / Hb
        top = np.maximum(N[:, 2], 0) ** 2
        # slouch: front edge drops, the crown drifts off-centre
        P[:, 2] -= rng.uniform(0.010, 0.020) * np.maximum(tb, 0) ** 2 * top
        P[:, 2] += 0.006 * rng.uniform(-1, 1) * ta * top
        P[:, 1] += rng.uniform(-0.007, 0.007) * np.sin(ta * 2.5 + rng.uniform(0, 6)) * np.maximum(N[:, 1], 0)
        # the sag where one sits: a broad, off-centre dish
        ox, oy = rng.uniform(-0.15, 0.15), rng.uniform(-0.1, 0.2)
        sag = rng.uniform(0.010, 0.019)
        P[:, 2] -= sag * np.exp(-(((ta - ox) / 0.55) ** 2 + ((tb - oy) / 0.5) ** 2)) * top
        P = corner_creases(P, N, H, rng, 0.0075, rad=0.19, mask=top)
        # pull wrinkles along the front edge
        dfront = np.maximum(Hb - P[:, 1], 0)
        kf = 2 * math.pi / rng.uniform(0.2, 0.34)
        P[:, 2] += 0.0055 * rng.uniform(0.6, 1.1) * np.exp(-dfront / 0.10) * np.sin(ta * Ha * kf + rng.uniform(0, 6.28)) * smoothstep(dfront / 0.035) * top
        # the same on the two side edges, much shorter
        dside = np.maximum(Ha - np.abs(P[:, 0]), 0)
        P[:, 2] += 0.0035 * np.exp(-dside / 0.08) * np.sin(P[:, 1] * 2 * math.pi / rng.uniform(0.2, 0.3) + rng.uniform(0, 6.28)) * smoothstep(dside / 0.03) * top
        P = corner_folds(P, N, H, rng, 0.0030, rad=0.15, mask=top)
        P = undulation(P, N, rng, 0.0035, mask=np.maximum(N[:, 2], 0))
        P = undulation(P, N, rng, 0.0022, lam=(0.10, 0.2), waves=3, mask=np.maximum(N[:, 2], 0))
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
        P = corner_creases(P, N, H, rng, 0.0085, rad=0.2, mask=top)
        # where the cushion bends over the seat and the frame: horizontal wrinkles low down, a few at the top
        kb = 2 * math.pi / rng.uniform(0.17, 0.26)
        low = np.exp(-np.maximum(P[:, 1] + Hb, 0) / 0.13) * smoothstep((P[:, 1] + Hb) / 0.04)
        P[:, 2] += 0.0070 * rng.uniform(0.7, 1.2) * low * np.sin(P[:, 1] * kb + rng.uniform(0, 6.28)) * top
        # diagonal pull wrinkles from the lower corners toward the dimple
        P[:, 2] += 0.0045 * low * np.sin((P[:, 0] * 0.8 + P[:, 1]) * kb * 0.9 + rng.uniform(0, 6.28)) * top
        high = smoothstep((P[:, 1] / Hb - 0.35) / 0.4)
        P[:, 2] += 0.0040 * high * np.sin(P[:, 0] * 2 * math.pi / rng.uniform(0.24, 0.4) + rng.uniform(0, 6.28)) * top
        P = corner_folds(P, N, H, rng, 0.0035, rad=0.17, mask=top)
        P = undulation(P, N, rng, 0.0040, mask=np.maximum(N[:, 2], 0))
        P = undulation(P, N, rng, 0.0022, lam=(0.10, 0.2), waves=3, mask=np.maximum(N[:, 2], 0))
    # piping along the crest loop of the visible face
    Pn = unit(inflate_normals(N))
    pv, pf, puv = piping_tube(P[crest], Pn[crest], PIPING_R)
    return P, F, UV, pv, pf, puv, seams, tube_seams(len(crest), 5)


def inflate_normals(N):
    return N


def rot_axis(axis, ang):
    axis = unit(axis)
    c, s = math.cos(ang), math.sin(ang)
    x, y, z = axis
    return np.array([[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
                     [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
                     [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]])


def place(mesh, P, F, UV, pv, pf, puv, M, origin, seams=None, tseams=None):
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
    mesh.add(W, Fo, UVo, seams)
    mesh.add(Wp, Fp, UVp, tseams)
    return W

# --------------------------------------------------------------------------------------
# Layout
# --------------------------------------------------------------------------------------
INNER_LONG_X = OUT_BACK_X + SHELL_INSET_X + SHELL_T   # inner face of the long back
INNER_N_Z = Z_NORTH_BACK + SHELL_INSET + SHELL_T
INNER_S_Z = Z_SOUTH_BACK - SHELL_INSET - SHELL_T
UP = np.array([0, 1.0, 0])
SEAT_TOPS = []
THIN_FACES = [0, 0]   # face-index range of the plaid in the pillow BVH (a sheet: tested by distance only)
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
        P, F, UV, pv, pf, puv, sm, tsm = make_cushion("seat", Ha, Hb, Hc, rng)
        M = np.stack([w["u"], w["f"], UP], 1)
        # small pitch/yaw so no two modules are aligned perfectly
        M = rot_axis(w["f"], math.radians(rng.uniform(-0.8, 0.8))) @ rot_axis(w["u"], math.radians(rng.uniform(-0.8, 0.8))) @ rot_axis(UP, math.radians(rng.uniform(-0.5, 0.5))) @ M
        o = wall_point(wall, s, depth / 2 - (shrink / 2 if corner else 0.0))
        o[1] = SEAT_BASE + Hc + rng.uniform(-0.002, 0.003)
        Wc = place(cush, P, F, UV, pv, pf, puv, M, o, sm, tsm)
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
        P, F, UV, pv, pf, puv, sm, tsm = make_cushion("back", Ha, Hb, Hc, rng, rt=0.075, rbot=0.06, rside=BACK_TOP_R)
        M, o = lean_frame(wall, s, rng, Hb, Hc, lean)
        # a touch of sideways roll
        M = rot_axis(M[:, 2], math.radians(rng.uniform(-1.2, 1.2))) @ M
        Wb = place(cush, P, F, UV, pv, pf, puv, M, o, sm, tsm)
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
    cxl = OUT_BACK_X + SHELL_INSET_X + SHELL_T / 2
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
    seams = [(i * npf, (i + 1) * npf) for i in range(ns - 1)]          # cut along the underside
    for i in range(1, ns - 1):                                          # and across, about every 1.6 m
        if int(ring_s[i] // 1.6) != int(ring_s[i - 1] // 1.6):
            seams += [(i * npf + j, i * npf + (j + 1) % npf) for j in range(npf)]
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
                seams.append((prev, pole))
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
                seams.append((prev, cur))
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
    fo = None
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
    fr.add(V, F, UV, seams)

    # ---- arms and plinth: rounded blocks, world-axis UVs
    def block(c, half, radii, B, name_seed, drop=(), kz=3, step=0.12):
        r2 = np.random.default_rng(name_seed)
        H = np.array(half)
        P, N, F2, UV2, crest_, info_ = build_block(H, radii, uvax={0: (2, 1), 1: (0, 2), 2: (0, 1)}, drop=drop, kz=kz, step=step, crest_axis=(1, 1))
        sm_ = ring_edges(crest_) + chain_edges(info_['cut']) + (ring_edges(info_['neg']) if (1, -1) not in drop else [])
        if B > 0:
            P = inflate(P, N, H, B, B, B) if False else P
            # uniform swelling: weight by the three face coordinates
            t = P / H
            w = np.clip((1 - t[:, 0] ** 2 * (1 - N[:, 0] ** 2)) * (1 - t[:, 1] ** 2 * (1 - N[:, 1] ** 2)) * (1 - t[:, 2] ** 2 * (1 - N[:, 2] ** 2)), 0, 1)
            P = P + N * (B * w)[:, None]
        P = undulation(P, N, r2, 0.0028)
        P = corner_folds(P, N, H, r2, 0.0025, axes=(0, 2), mask=np.maximum(N[:, 1], 0))
        fr.add(P + np.array(c), F2, UV2, sm_)

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
def make_pillow(Ha, rng, nG=PILLOW_GRID, chop=False, dimple=0.0, squash_body=False):
    """Two sheets joined by a knife edge, a seam tube round the edge, pinched corner ears, optional
    karate-chop crease (chop) or soft dimple, creases fanning out of the corners."""
    t = -np.cos(np.linspace(0, math.pi, nG))               # cosine spacing, denser at the border
    T = PILLOW_THICK * rng.uniform(0.9, 1.1) * (0.72 if squash_body else 1.0)
    Ha = Ha * (1.07 if squash_body else 1.0)
    verts = []
    top_ids = np.zeros((nG, nG), int)
    bot_ids = np.zeros((nG, nG), int)
    squash = rng.uniform(0.0, 0.1)
    chop_ang = rng.uniform(-0.25, 0.25)
    for i in range(nG):
        for j in range(nG):
            tx, ty = t[i], t[j]
            gx = max(0.0, math.cos(math.pi / 2 * tx)) ** 0.72
            gy = max(0.0, math.cos(math.pi / 2 * ty)) ** 0.72
            corner = (abs(tx) * abs(ty))
            h = T * gx * gy * (1 - 0.55 * corner ** 3)       # the corners are thin, empty ears
            # the stuffing pulls the middle of every edge in; corners stay out and pinch to a point
            pull = (1 - 0.075 * (h / T)) * (1 - 0.05 * corner ** 2.5)
            x, y = tx * Ha * pull, ty * Ha * pull
            ht = h
            if chop:                                         # karate chop: a crease across the top
                cx = tx * math.cos(chop_ang) + ty * math.sin(chop_ang)
                ht = h - 0.05 * math.exp(-(cx / 0.12) ** 2) * gy ** 0.6 * (T / PILLOW_THICK)
            elif dimple:
                ht = h - dimple * math.exp(-((tx ** 2 + ty ** 2) / 0.12))
            border = (i in (0, nG - 1)) or (j in (0, nG - 1))
            top_ids[i, j] = len(verts)
            verts.append((x, y, ht))
            if border:
                bot_ids[i, j] = top_ids[i, j]
            else:
                bot_ids[i, j] = len(verts)
                verts.append((x, y, -h * (0.93 + squash * 0.5)))
    P = np.array(verts)
    Nn = np.zeros_like(P)
    Nn[:, 2] = np.where(P[:, 2] >= 0, 1.0, -1.0)
    Hh = np.array([Ha, Ha, 1.0])
    # creases out of the corners (both sheets), stronger on the visible one
    P = corner_creases(P, Nn, Hh, rng, 0.017, rad=0.22, axes=(0, 1), nmax=4)
    P = corner_folds(P, Nn, Hh, rng, 0.0050, rad=0.13, axes=(0, 1))
    P = undulation(P, Nn, rng, 0.0075, lam=(0.15, 0.35))
    # cupping / sag
    P[:, 2] += rng.uniform(-0.03, 0.03) * (P[:, 0] / Ha) ** 2 - rng.uniform(0, 0.03) * (P[:, 1] / Ha) ** 2
    # dog-ears: the corners flick to one side
    cx_, cy_ = P[:, 0] / Ha, P[:, 1] / Ha
    P[:, 2] -= rng.uniform(0.015, 0.035) * (np.abs(cx_) * np.abs(cy_)) ** 3 * np.sign(cx_ * cy_ + 1e-6) * rng.choice([-1, 1])
    F, UV = [], []
    for i in range(nG - 1):
        for j in range(nG - 1):
            q = [top_ids[i, j], top_ids[i + 1, j], top_ids[i + 1, j + 1], top_ids[i, j + 1]]
            F.append(tuple(q))
            UV.append([(P[k, 0], P[k, 1]) for k in q])
            qb = [bot_ids[i, j], bot_ids[i, j + 1], bot_ids[i + 1, j + 1], bot_ids[i + 1, j]]
            F.append(tuple(qb))
            UV.append([(P[k, 0] + 0.37, P[k, 1] + 0.11) for k in qb])
    # seam round the knife edge: a thin tube
    ring = [top_ids[i, 0] for i in range(nG - 1)] + [top_ids[nG - 1, j] for j in range(nG - 1)] + \
           [top_ids[i, nG - 1] for i in range(nG - 1, 0, -1)] + [top_ids[0, j] for j in range(nG - 1, 0, -1)]
    Q = P[ring]
    rad = unit(np.stack([Q[:, 0], Q[:, 1], np.zeros(len(Q))], 1))
    pv, pf, puv = piping_tube(Q, rad, 0.0042, sides=4, lift=0.0)
    seams = ring_edges(ring)
    return P, F, UV, pv, pf, puv, seams, tube_seams(len(ring), 4)


def clear_of(V, bvh, margin):
    """True when no vertex is closer than `margin` to, or inside, the sofa."""
    for co in V:
        hit = bvh.find_nearest((float(co[0]), float(co[1]), float(co[2])), 0.15)
        if hit[0] is None:
            continue
        loc, nrm, fi, dist = hit
        if THIN_FACES[0] <= fi < THIN_FACES[1]:
            if dist < margin:          # a thin sheet (the plaid): no inside, just distance
                return False
            continue
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
        loc, nrm, fi, dist = hit
        if THIN_FACES[0] <= fi < THIN_FACES[1]:
            m = min(m, dist)
            continue
        sd = (co[0] - loc[0]) * nrm[0] + (co[1] - loc[1]) * nrm[1] + (co[2] - loc[2]) * nrm[2]
        m = min(m, sd)
    return m


def build_pillows(world_mesh_list, back_info):
    # (the plaid is in world_mesh_list: pillows rest on it where it covers the seat)
    bv, bf = [], []
    off = 0
    for m in world_mesh_list:
        bv.append(m.V)
        bf += [tuple(i + off for i in f) for f in m.F]
        off += len(m.V)
    nf_before = sum(len(m.F) for m in world_mesh_list[:-1])
    THIN_FACES[0], THIN_FACES[1] = nf_before, 10 ** 9   # the plaid and every pillow placed so far are thin shells
    base_v, base_f = np.vstack(bv), list(bf)
    bvh = BVHTree.FromPolygons(base_v.tolist(), base_f)
    placed_v, placed_f = [], []
    pa, pb = Mesh("pillows_a"), Mesh("pillows_b")
    gdir = np.array([0, -1.0, 0])
    specs = []
    # five on the long side, one on each of the five back cushions
    long_s = [b["s"] for b in back_info if b["wall"] == "long"]
    long_pos = [-1.88, -1.38, -0.88, -0.38, 0.10]      # the north end of the long side is under the plaid
    for k, s in enumerate(long_pos):
        specs.append(("long", s, pa, [-4, 4, -3, 5, 2][k], [4, 6, 3, 8, 5][k],
                      dict(chop=k in (1, 3), dimple=0.012 if k == 2 else 0.0, squash_body=k == 0, size=0.44)))
    n_s = sorted([b["s"] for b in back_info if b["wall"] == "north"])
    s_s = sorted([b["s"] for b in back_info if b["wall"] == "south"])
    specs.append(("north", n_s[1] + 0.05, pb, 14, 6, dict(chop=True)))
    specs.append(("north", n_s[3] - 0.10, pb, -24, 4, dict(dimple=0.014, squash_body=True)))
    specs.append(("south", s_s[1] - 0.04, pb, -9, 5, dict(dimple=0.010)))
    specs.append(("south", s_s[3] - 0.08, pb, 28, 7, dict(chop=True, squash_body=True)))
    report = []
    for (wall, s, target, roll_deg, extra_tilt, flags) in specs:
        rng = np.random.default_rng(rng_master.integers(1 << 31))
        Ha = flags.pop('size', rng.uniform(*PILLOW_SIZES)) / 2
        P, F, UV, pv, pf, puv, psm, ptsm = make_pillow(Ha, rng, **flags)
        w = WALLS[wall]
        L = math.radians(BACK_LEAN_DEG + extra_tilt + 8)
        n = w["f"] * math.cos(L) + UP * math.sin(L)
        t = -w["f"] * math.sin(L) + UP * math.cos(L)
        # local x -> along wall (rolled), local y -> up the pillow, local z -> its face
        M0 = np.stack([w["u"], t, n], 1)
        M = M0 @ rot_axis(np.array([0, 0, 1.0]), math.radians(roll_deg))
        V0 = P @ M.T
        V = settle_pillow(V0, bvh, wall, s)
        shift = V[0] - V0[0]
        Vt = pv @ M.T + shift
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
        zr = (INNER_N_Z, Z_NORTH_FRONT) if wall == 'north' else (Z_SOUTH_FRONT, INNER_S_Z) if wall == 'south' else (INNER_N_Z, INNER_S_Z)
        xr = (INNER_LONG_X, SEAT_FRONT_X + 0.5) if wall == 'long' else (SEAT_FRONT_X, WING_END_X)
        inside = bool(V[:, 2].min() > zr[0] - 0.03 and V[:, 2].max() < zr[1] + 0.03 and V[:, 0].min() > xr[0] - 0.03 and V[:, 0].max() < xr[1] + 0.03)
        print('  PILLOW-ON-SEAT', wall, inside, 'x', round(V[:, 0].min(), 2), round(V[:, 0].max(), 2), 'z', round(V[:, 2].min(), 2), round(V[:, 2].max(), 2), 'ymin', round(V[:, 1].min(), 3))
        report.append(dict(wall=wall, size=round(2 * Ha, 3), on_seat=inside, min_sd=round(sd, 4), y=[round(V[:, 1].min(), 3), round(V[:, 1].max(), 3)]))
        det = np.linalg.det(M)
        Fo = [f[::-1] for f in F] if det < 0 else F
        UVo = [u[::-1] for u in UV] if det < 0 else UV
        Fp_ = [f[::-1] for f in pf] if det < 0 else pf
        UVp_ = [u[::-1] for u in puv] if det < 0 else puv
        target.add(V, Fo, UVo, psm)
        if target.lm is None:
            target.lm = []
        target.lm += [[(x_ + (0.3 if k_ % 2 else 0.0), y_) for (x_, y_) in u] for k_, u in enumerate(UVo)]   # underside = its own island
        off_ = len(base_v) + sum(len(x) for x in placed_v)
        placed_v.append(V)
        placed_f += [tuple(i + off_ for i in f) for f in Fo]
        bvh = BVHTree.FromPolygons(np.vstack([base_v] + placed_v).tolist(), base_f + placed_f)
        target.add(Vt, Fp_, UVp_, ptsm)
        target.lm += [None] * len(Fp_)
    return pa, pb, report


# --------------------------------------------------------------------------------------
# Plaid (throw blanket) draped over the backrest and seat of the long side
# --------------------------------------------------------------------------------------
def signed_push(co, bvh, target, rounds=3):
    """Push a point out of the sofa along the nearest surface normal until it is `target` clear."""
    co = np.array(co, float)
    for _ in range(rounds):
        hit = bvh.find_nearest((float(co[0]), float(co[1]), float(co[2])), 0.2)
        if hit[0] is None:
            return co
        loc, nrm, _, dist = hit
        sd = float(np.dot(co - np.array(loc), np.array(nrm)))
        if sd >= target - 1e-4:
            return co
        co = co + np.array(nrm) * (target - sd)
    return co


def surface_height(bvh, x, z):
    hit = bvh.ray_cast((float(x), 1.8, float(z)), (0.0, -1.0, 0.0), 3.0)
    return None if hit[0] is None else hit[0][1]


def build_plaid(bvh):
    rng = np.random.default_rng(rng_master.integers(1 << 31))
    L, W = PLAID_LEN, PLAID_W
    nu, nv = 57, 39
    du = L / (nu - 1)
    zs = PLAID_ZC + np.linspace(-W / 2, W / 2, nv)
    xs = np.arange(-2.58, -0.50, 0.005)
    # --- heightfield seen from above, dilated 3 cm sideways so the blanket bridges the gaps between modules
    dz = np.arange(-0.07, 0.071, 0.014)
    cols = []
    for z in zs:
        H = np.full(len(xs), np.nan)
        for k, x in enumerate(xs):
            best = None
            for d_ in dz:
                h = surface_height(bvh, x, z + d_)
                if h is not None and (best is None or h > best):
                    best = h
            if best is not None:
                H[k] = best
        cols.append(H)
    # dilate the heights along x as well (a few cm): the cloth cannot dip between the ears of two cushions
    for H in cols:
        Hf = np.where(np.isnan(H), -9.0, H)
        D = Hf.copy()
        for sh in range(1, 7):
            D[sh:] = np.maximum(D[sh:], Hf[:-sh])
            D[:-sh] = np.maximum(D[:-sh], Hf[sh:])
        H[:] = np.where(np.isnan(H), np.nan, np.maximum(D, Hf))
    profiles = []
    for z, H in zip(zs, cols):
        ok = np.where(~np.isnan(H))[0]
        i0 = ok[0]
        # fill short gaps, stop at the first long one (the seat's front edge)
        i_end = i0
        k = i0
        while k < len(xs):
            if not np.isnan(H[k]):
                i_end = k
                k += 1
                continue
            j2 = k
            while j2 < len(xs) and np.isnan(H[j2]):
                j2 += 1
            if j2 < len(xs) and (j2 - k) * 0.005 <= 0.07:
                H[k:j2] = np.interp(np.arange(k, j2), [k - 1, j2], [H[k - 1], H[j2]])
                k = j2
            else:
                break
        pts = [(xs[i0], H[i0] - PLAID_HANG)]
        pts += [(xs[i], H[i]) for i in range(i0, i_end + 1)]
        # the free front: hangs straight down past the seat's front edge (only if the surface really ends)
        if i_end < len(xs) - 1:
            pts.append((xs[i_end], H[i_end] - 1.2))
        pts = np.array(pts)
        # resample finely by arc length, smooth (cloth cannot follow sharp creases), push out of the sofa
        seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
        sa = np.concatenate([[0], np.cumsum(seg)])
        t = np.arange(0, sa[-1], 0.006)
        Q = np.stack([np.interp(t, sa, pts[:, 0]), np.interp(t, sa, pts[:, 1])], 1)
        for _ in range(14):                                  # ~sigma 3.3 cm
            Q[1:-1] = 0.25 * Q[:-2] + 0.5 * Q[1:-1] + 0.25 * Q[2:]
        for _ in range(3):
            Q3 = np.stack([Q[:, 0], Q[:, 1], np.full(len(Q), z)], 1)
            Q3 = np.array([signed_push(q, bvh, PLAID_CLEAR, 2) for q in Q3])
            Q = Q3[:, [0, 1]]
            for _ in range(2):
                Q[1:-1] = 0.25 * Q[:-2] + 0.5 * Q[1:-1] + 0.25 * Q[2:]
        Q3 = np.stack([Q[:, 0], Q[:, 1], np.full(len(Q), z)], 1)
        Q3 = np.array([signed_push(q, bvh, PLAID_CLEAR, 3) for q in Q3])
        seg = np.linalg.norm(np.diff(Q3, axis=0), axis=1)
        sa = np.concatenate([[0], np.cumsum(seg)])
        if sa[-1] < L:
            raise RuntimeError("plaid column too short %.3f" % sa[-1])
        u = np.linspace(0, L, nu)
        profiles.append(np.stack([np.interp(u, sa, Q3[:, c]) for c in range(3)], 1))
    G = np.array(profiles).transpose(1, 0, 2)            # (nu, nv, 3) base surface
    # cloth is continuous across the width: smooth the columns against each other, then push out of the sofa again
    for _ in range(3):
        for _ in range(6):
            G[:, 1:-1] = 0.25 * G[:, :-2] + 0.5 * G[:, 1:-1] + 0.25 * G[:, 2:]
        for _ in range(2):
            G[1:-1] = 0.25 * G[:-2] + 0.5 * G[1:-1] + 0.25 * G[2:]
        for i in range(nu):
            for j in range(nv):
                G[i, j] = signed_push(G[i, j], bvh, PLAID_CLEAR, 3)
    uu = np.linspace(0, L, nu)[:, None] * np.ones((1, nv))
    vv = np.ones((nu, 1)) * np.linspace(0, W, nv)[None, :]
    Pu = np.gradient(G, axis=0)
    Pv = np.gradient(G, axis=1)
    Nn = unit(np.cross(Pv, Pu))
    # outward must point away from the sofa: seat part up, hang part toward -X
    votes = 0
    for (i, j) in [(a, b) for a in range(2, nu - 2, 3) for b in (nv // 4, nv // 2, 3 * nv // 4)]:
        sds = []
        for sg_ in (+1, -1):
            q = G[i, j] + sg_ * Nn[i, j] * 0.03
            hit = bvh.find_nearest((float(q[0]), float(q[1]), float(q[2])), 0.3)
            sds.append(-9 if hit[0] is None else float(np.dot(q - np.array(hit[0]), np.array(hit[1]))))
        votes += 1 if sds[0] > sds[1] else -1
    print('PLAID normal votes', votes)
    if votes < 0:
        Nn = -Nn
    ms = np.where((G[:, nv // 2, 1] > 0.44) & (G[:, nv // 2, 1] < 0.52))[0]
    print('PLAID seat-part normals', [np.round(Nn[i, nv // 2], 2).tolist() for i in ms[::6]][:4], 'u', [round(float(uu[i, 0]), 2) for i in ms[::6]][:4])
    # --- drape folds, always outward (never into the cushions)
    free = 0.55 * smoothstep((0.34 - uu) / 0.12) + smoothstep((uu - (L - 0.30)) / 0.12)
    ph = rng.uniform(0, 6.28, 6)
    f1 = 0.5 + 0.5 * np.sin(2 * math.pi * vv / 0.23 + ph[0] + 1.7 * np.sin(2 * math.pi * uu / 0.55 + ph[1]))
    f2 = 0.5 + 0.5 * np.sin(2 * math.pi * uu / 0.33 + ph[2] + 2.2 * np.sin(2 * math.pi * vv / 0.8 + ph[3]))
    f3 = 0.5 + 0.5 * np.sin(2 * math.pi * (vv * 0.6 + uu * 0.8) / 0.4 + ph[4])
    fold = (0.005 + 0.016 * free) * f1 + 0.0100 * f2 * (1 - 0.6 * free) + 0.0055 * f3
    G = G + Nn * fold[..., None]
    # wavy edges, sideways
    edge_w = smoothstep((0.16 - np.minimum(vv, W - vv)) / 0.16)
    G[..., 2] += 0.014 * np.sin(2 * math.pi * uu / 0.45 + ph[5] + 3 * vv) * edge_w
    # --- thickness: two sheets that meet at the rim
    rim = np.minimum(np.minimum(uu, L - uu), np.minimum(vv, W - vv))
    tw = smoothstep(rim / 0.014)
    th = 0.0035
    top = G + Nn * (th * tw)[..., None]
    bot = G - Nn * (th * tw)[..., None]
    # last guarantee: no vertex closer than 3 mm to the sofa (top sheet 5 mm)
    pushed = 0
    for arr, tgt in ((top, 0.005), (bot, 0.003)):
        for i in range(nu):
            for j in range(nv):
                q = signed_push(arr[i, j], bvh, tgt, 3)
                if np.linalg.norm(q - arr[i, j]) > 1e-6:
                    pushed += 1
                arr[i, j] = q
    print("PLAID vertices nudged out of the sofa:", pushed)
    PL = Mesh("plaid")
    V = []
    tid = -np.ones((nu, nv), int)
    bid = -np.ones((nu, nv), int)
    for i in range(nu):
        for j in range(nv):
            tid[i, j] = len(V); V.append(top[i, j])
    for i in range(nu):
        for j in range(nv):
            if i in (0, nu - 1) or j in (0, nv - 1):
                bid[i, j] = tid[i, j]
            else:
                bid[i, j] = len(V); V.append(bot[i, j])
    F, UV = [], []
    for i in range(nu - 1):
        for j in range(nv - 1):
            q = [tid[i, j], tid[i, j + 1], tid[i + 1, j + 1], tid[i + 1, j]]
            F.append(tuple(q)); UV.append([(uu[i, j], vv[i, j]), (uu[i, j + 1], vv[i, j + 1]), (uu[i + 1, j + 1], vv[i + 1, j + 1]), (uu[i + 1, j], vv[i + 1, j])])
            qb = [bid[i, j], bid[i + 1, j], bid[i + 1, j + 1], bid[i, j + 1]]
            F.append(tuple(qb)); UV.append([(uu[i, j], vv[i, j]), (uu[i + 1, j], vv[i + 1, j]), (uu[i + 1, j + 1], vv[i + 1, j + 1]), (uu[i, j + 1], vv[i, j + 1])])
    ring = [tid[i, 0] for i in range(nu - 1)] + [tid[nu - 1, j] for j in range(nv - 1)] + \
           [tid[i, nv - 1] for i in range(nu - 1, 0, -1)] + [tid[0, j] for j in range(nv - 1, 0, -1)]
    PL.add(np.array(V), F, UV, ring_edges(ring))
    # --- fringe: a comb of tapering strands at each short end (one connected island per end)
    pitch = W / 88
    ns = 88
    for end in (0, 1):
        i = 0 if end == 0 else nu - 1
        rimP = G[i]                                         # (nv, 3)
        if end == 0:
            tg = unit(G[0] - G[1])                          # points away from the blanket
        else:
            tg = unit(G[nu - 1] - G[nu - 2])
        vlin = np.linspace(0, W, nv)
        cv = (np.arange(ns) + 0.5) * pitch
        bv_ = np.arange(ns + 1) * pitch
        def at(vq, arr):
            return np.stack([np.interp(vq, vlin, arr[:, c]) for c in range(3)], 1)
        Pc, Tc = at(cv, rimP), unit(at(cv, tg))
        Pb = at(bv_, rimP)
        Fv, Fq, Fu = [], [], []
        base_ids = list(range(len(Pb)))
        Fv.extend(Pb)
        widths = [0.62, 0.5, 0.38]
        L_f = rng.uniform(0.065, 0.085, ns)
        strand_ids = []
        for sidx in range(ns):
            pos = Pc[sidx].copy()
            d = Tc[sidx].copy()
            hanging = d[1] < -0.65
            rows = []
            lat = rng.uniform(-0.012, 0.012)
            for k in range(1, 4):
                step = L_f[sidx] / 3
                if hanging:
                    d = unit(d + np.array([0, -0.5, 0]) * 0.5)
                    pos = pos + d * step + np.array([0, 0, lat * 0.3])
                else:
                    dh = np.array([d[0], 0, d[2]])
                    dh = unit(dh + 1e-9)
                    pos = pos + dh * step + np.array([0, 0, lat * 0.3])
                    h = surface_height(bvh, pos[0], pos[2])
                    pos[1] = (h + 0.004) if h is not None else pos[1]
                wk = pitch * widths[k - 1]
                rows.append((pos.copy(), wk))
            strand_ids.append(rows)
        # vertices
        ids_rows = []
        for sidx, rows in enumerate(strand_ids):
            r_ids = []
            for (pp, wk) in rows:
                a = len(Fv); Fv.append(pp - np.array([0, 0, wk / 2]))
                b = len(Fv); Fv.append(pp + np.array([0, 0, wk / 2]))
                r_ids.append((a, b))
            ids_rows.append(r_ids)
        uend = 0.0 if end == 0 else L
        sg = -1.0 if end == 0 else 1.0
        Fv = np.array(Fv)
        FF, FUV = [], []
        def quad(a, b, c, d_, uv):
            if end == 0:
                FF.append((d_, c, b, a)); FUV.append([uv[3], uv[2], uv[1], uv[0]])
            else:
                FF.append((a, b, c, d_)); FUV.append(uv)
        for sidx in range(ns):
            r = ids_rows[sidx]
            vl, vr = sidx * pitch, (sidx + 1) * pitch
            t0 = uend
            tt = [np.linalg.norm(Fv[r[0][0]] - Pc[sidx]) ]
            # row0 trapezoid: base ids sidx, sidx+1  -> row1 (left, right)
            def uvv(t, v):
                return (uend + sg * t, v)
            len1 = float(np.linalg.norm(Fv[r[0][0]] - Pc[sidx]))
            lens = [len1]
            for k in range(1, 3):
                lens.append(lens[-1] + float(np.linalg.norm(Fv[r[k][0]] - Fv[r[k - 1][0]])))
            vcen = (sidx + 0.5) * pitch
            quad(sidx, sidx + 1, r[0][1], r[0][0], [uvv(0, vl), uvv(0, vr), uvv(lens[0], vcen + pitch * widths[0] / 2), uvv(lens[0], vcen - pitch * widths[0] / 2)])
            for k in range(2):
                wa, wb = pitch * widths[k] / 2, pitch * widths[k + 1] / 2
                quad(r[k][0], r[k][1], r[k + 1][1], r[k + 1][0], [uvv(lens[k], vcen - wa), uvv(lens[k], vcen + wa), uvv(lens[k + 1], vcen + wb), uvv(lens[k + 1], vcen - wb)])
        PL.add(Fv, FF, FUV, None)
    # UV1 for the plaid is its own parametrisation (no unwrap needed, no folds-induced overlaps): the top sheet
    # and the fringe use (u, v); the underside is a second island, shifted. The atlas packer scales and places them.
    nsheet = 2 * (nu - 1) * (nv - 1)
    PL.lm = [[(a, b) for (a, b) in f] if (k >= nsheet or k % 2 == 0) else [(a, b + W + 0.25) for (a, b) in f] for k, f in enumerate(PL.UV)]
    return PL

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


def make_lightmap_uvs(objs, meshes):
    """UV1 'lightmap': islands are cut along the marked seams (piping crests, tube strips, cushion corners, ...),
    unwrapped, scaled so texel density follows 3D area, and packed (concave shapes, 8 px margin) in ONE
    0..1 atlas shared by every object, then shrunk by LIGHTMAP_SHRINK about the centre."""
    import bmesh
    for o, m in zip(objs, meshes):
        me = o.data
        me.uv_layers.active = me.uv_layers["lightmap"]
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.verts.ensure_lookup_table()
        bm.edges.ensure_lookup_table()
        miss = 0
        for a, b in m.seams:
            e = bm.edges.get((bm.verts[a], bm.verts[b]))
            if e is None:
                miss += 1
            else:
                e.seam = True
        if miss:
            print("SEAM EDGES NOT FOUND", m.name, miss)
        bm.to_mesh(me)
        bm.free()
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    ts = bpy.context.scene.tool_settings
    ts.use_uv_select_sync = True
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.unwrap(method="ANGLE_BASED", fill_holes=True, correct_aspect=True, use_subsurf_data=False, margin=0.0)
    bpy.ops.object.mode_set(mode="OBJECT")
    for o, m in zip(objs, meshes):
        if m.lm is not None:       # parametric faces keep their own layout; None = keep the unwrap
            me = o.data
            layer = me.uv_layers["lightmap"]
            cur = np.array([l.uv[:] for l in layer.data])
            for fi, poly in enumerate(me.polygons):
                if m.lm[fi] is not None:
                    cur[poly.loop_start:poly.loop_start + poly.loop_total] = m.lm[fi]
            layer.data.foreach_set("uv", cur.ravel())
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.average_islands_scale()
    bpy.ops.uv.pack_islands(udim_source="CLOSEST_UDIM", rotate=True, rotate_method="ANY", scale=True, merge_overlap=False,
                            margin_method="ADD", margin=LIGHTMAP_MARGIN, pin=False, shape_method="CONCAVE")
    bpy.ops.object.mode_set(mode="OBJECT")
    lo, hi = 1e9, -1e9
    for o in objs:
        me = o.data
        layer = me.uv_layers["lightmap"]
        uv = np.array([l.uv[:] for l in layer.data])
        uv = 0.5 + (uv - 0.5) * LIGHTMAP_SHRINK
        layer.data.foreach_set("uv", uv.ravel())
        lo, hi = min(lo, uv.min()), max(hi, uv.max())
        me.uv_layers.active = me.uv_layers["UVMap"]   # UV0 stays the active/render map
    print("LIGHTMAP UV bounds", round(lo, 4), round(hi, 4))


def main():
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    cush, seats, back_info = build_cushions()
    frame = build_frame()
    sofa_bvh = BVHTree.FromPolygons(np.vstack([cush.V, frame.V]).tolist(),
                                    [tuple(f) for f in cush.F] + [tuple(i + len(cush.V) for i in f) for f in frame.F])
    plaid = build_plaid(sofa_bvh)
    pa, pb, rep = build_pillows([cush, frame, plaid], back_info)
    meshes = [frame, cush, pa, pb, plaid]
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
    if sum(tri.values()) > TOTAL_BUDGET:
        print("OVER TOTAL BUDGET", sum(tri.values()))
    objs = []
    # The glTF exporter only writes TEXCOORD_0 when the material samples a texture, so each placeholder
    # material carries a 1x1 image node on its base colour. tools/sofa/optimize.mjs strips the texture again.
    colours = {"sofa_frame": (0.70, 0.62, 0.50), "sofa_cushions": (0.74, 0.66, 0.54),
               "pillows_a": (0.50, 0.40, 0.32), "pillows_b": (0.60, 0.60, 0.55), "plaid": (0.45, 0.20, 0.18)}
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
        # second texture on the 'lightmap' UV map, so that TEXCOORD_1 is exported (stripped by optimize.mjs)
        uvn = nt.nodes.new("ShaderNodeUVMap")
        uvn.uv_map = "lightmap"
        tex2 = nt.nodes.new("ShaderNodeTexImage")
        tex2.image = img
        nt.links.new(uvn.outputs["UV"], tex2.inputs["Vector"])
        nt.links.new(tex2.outputs["Color"], bsdf.inputs["Emission Color"])
        bsdf.inputs["Emission Strength"].default_value = 1.0
        ob = to_object(m, mat)
        ob.data.uv_layers.new(name="lightmap")
        objs.append(ob)
    make_lightmap_uvs(objs, meshes)
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
