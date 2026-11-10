# Post-processing (run inside the Blender image): tone mapping, procedural sky + stars behind the far layer,
# alpha clean-up, 8-bit PNGs for KTX2 encoding, composite check, perspective previews.
# usage: compose.py <dir with far.exr mid.exr near.exr far_cover.exr> <outdir> [--quick]
import sys, os, json, math
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from params import *
from imgio import *
ARGS = sys.argv[sys.argv.index("--") + 1:]
src, out = ARGS[0], ARGS[1]; os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(11)

def tonemap(x):   # linear scene -> linear display (soft shoulder above 0.55), keeps low values untouched
    x = np.maximum(x * EXPOSURE, 0); k = 0.55
    return np.where(x < k, x, k + (1 - k) * (1 - np.exp(-(x - k) / (1 - k))))
def oetf(x):
    x = np.clip(x, 0, 1); return np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)
def eotf(x):
    return np.where(x <= 0.04045, x / 12.92, np.power((x + 0.055) / 1.055, 2.4))
def dir_grid(w, h):
    az = (np.arange(w) + 0.5) / w * 360 - 180; el = EL_MAX - (np.arange(h) + 0.5) / h * (EL_MAX - EL_MIN)
    return np.meshgrid(az, el)
def sky_image(w, h):
    AZ, EL = dir_grid(w, h)
    t = np.clip(EL / 90.0, 0, 1)[..., None]
    hor = np.array(SKY_HORIZON, np.float32); zen = np.array(SKY_ZENITH, np.float32)
    g = (1 - np.power(t, 0.45))                      # fast fall-off from the horizon
    img = zen + (hor - zen) * g
    # moon glow (the disc itself is above the +32 deg crop; its halo reaches into the picture)
    ma, me = math.radians(MOON_AZ), math.radians(MOON_EL)
    a, e = np.radians(AZ), np.radians(EL)
    cosd = np.sin(e) * math.sin(me) + np.cos(e) * math.cos(me) * np.cos(a - ma)
    th = np.degrees(np.arccos(np.clip(cosd, -1, 1)))
    glow = 0.55 * np.exp(-(th / 3.0) ** 2) + 0.10 * np.exp(-(th / 11.0) ** 2) + 0.030 * np.exp(-th / 30.0)
    img = img + glow[..., None] * np.array(MOON_COLOR, np.float32) * np.array([0.8, 0.95, 1.25], np.float32) * 0.5
    # faint Milky Way band: a great circle tilted 62 deg, modulated by noise
    ax = np.radians(205.0); n = np.array([math.sin(math.radians(62)) * math.cos(ax), math.sin(math.radians(62)) * math.sin(ax), math.cos(math.radians(62))])
    ca, sa = np.cos(a + math.radians(HEADING)), np.sin(a + math.radians(HEADING))
    v = np.stack([np.cos(e) * sa, np.cos(e) * ca, np.sin(e)], -1)
    bdeg = np.degrees(np.arcsin(np.clip(v @ n, -1, 1)))
    lat_n = rng.random((64, 128)).astype(np.float32)
    xi = ((AZ + 180) / 360 * 128).astype(np.float32); yi = ((EL + 30) / 70 * 64).astype(np.float32)
    # smooth lumpy modulation by repeated box blur of low-res noise (upsampled)
    lump = np.kron(lat_n, np.ones((int(np.ceil(h / 64)) + 1, int(np.ceil(w / 128)) + 1), np.float32))[:h, :w]
    for _ in range(3): lump = (lump + np.roll(lump, 6, 0) + np.roll(lump, -6, 0) + np.roll(lump, 6, 1) + np.roll(lump, -6, 1)) / 5
    mw = np.exp(-(bdeg / 9.0) ** 2) * (0.5 + 1.2 * lump) * np.clip(EL / 6.0, 0, 1)
    img = img + mw[..., None] * np.array([0.0035, 0.0045, 0.0075], np.float32) * 1.6
    return img.astype(np.float32)
def add_stars(img):
    h, w, _ = img.shape; NST = 14000
    saz = rng.uniform(-180, 180, NST); sel = np.degrees(np.arcsin(rng.uniform(np.sin(math.radians(EL_MIN - 2)), np.sin(math.radians(EL_MAX + 2)), NST)))
    mag = 0.03 + 1.6 * rng.random(NST) ** 9           # a few bright stars, many faint ones
    tint = rng.choice([0, 1, 2], NST, p=[0.6, 0.2, 0.2])
    cols = np.array([[0.85, 0.92, 1.0], [1.0, 0.88, 0.72], [0.72, 0.82, 1.0]], np.float32)[tint]
    fade = np.clip((sel + 2) / 14.0, 0, 1) ** 0.8      # extinction near the horizon
    px = (saz + 180) / 360 * w - 0.5; py = (EL_MAX - sel) / (EL_MAX - EL_MIN) * h - 0.5
    sig = 0.55
    for dy in range(-2, 3):
        for dx in range(-2, 3):
            xx = np.floor(px).astype(int) + dx; yy = np.floor(py).astype(int) + dy
            wgt = np.exp(-(((xx - px) ** 2 + (yy - py) ** 2) / (2 * sig ** 2))) * (0.75 / (2 * math.pi * sig ** 2 / 1.0)) * 0.35
            ok = (yy >= 0) & (yy < h)
            np.add.at(img, (yy[ok], xx[ok] % w), (wgt * mag * fade)[ok, None] * cols[ok])
    return img
def bleed(rgb, a, iters=10):   # fill colour under transparent pixels with the nearest opaque colours (no dark fringes)
    rgb = rgb.copy(); known = (a > 0.02).astype(np.float32)
    for _ in range(iters):
        num = np.zeros_like(rgb); den = np.zeros_like(known)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                k = np.roll(known, (dy, dx), (0, 1)); num += np.roll(rgb * known[..., None], (dy, dx), (0, 1)); den += k
        fill = num / np.maximum(den, 1e-6)[..., None]; upd = (known == 0) & (den > 0)
        rgb[upd] = fill[upd]; known = np.maximum(known, (den > 0).astype(np.float32))
    return rgb
def dither(x8f):   # x in 0..255 float, triangular dither of +-1 LSB
    n = rng.random(x8f.shape, dtype=np.float32) - rng.random(x8f.shape, dtype=np.float32)
    return np.clip(np.round(x8f + n * 0.75), 0, 255).astype(np.uint8)
def to8(rgb_lin): return dither(oetf(rgb_lin) * 255.0)

def layer(name):
    p = load_exr(f"{src}/{name}.exr"); a = np.clip(p[..., 3], 0, 1); prem = np.maximum(p[..., :3], 0)
    straight = np.where(a[..., None] > 1e-4, prem / np.maximum(a, 1e-4)[..., None], 0)
    return straight, a   # linear scene straight colour, alpha

result = {}
# ----- far: terrain + sky + haze fill -----
fs, fa = layer("far"); h, w, _ = fs.shape
sky = add_stars(sky_image(w, h))
cover = np.clip(load_exr(f"{src}/far_cover.exr")[..., 3], 0, 1) if os.path.exists(f"{src}/far_cover.exr") else fa
hazefill = np.array(HAZE_COLOR, np.float32) * 0.75
bg = sky * (1 - cover[..., None]) + hazefill * cover[..., None]
far_lin = fs * fa[..., None] + bg * (1 - fa[..., None])
far_d = tonemap(far_lin)                 # linear display-referred
save_png(f"{out}/far.png", to8(far_d)); result["far"] = (far_d, np.ones_like(fa))
for nm in [n for n in ("mid", "near") if os.path.exists(f"{src}/{n}.exr")]:
    s, a = layer(nm); d = tonemap(s); d = bleed(d, a)
    rgba = np.concatenate([oetf(d) * 255.0, a[..., None] * 255.0], -1)
    q = np.round(rgba).astype(np.uint8); q[..., :3] = to8(d)
    save_png(f"{out}/{nm}.png", q); result[nm] = (d, a)
    print(nm, "alpha mean", float(a.mean()), flush=True)
print("far mean display", float(oetf(far_d).mean()), flush=True)
if len(result) == 3: np.savez_compressed(f"{out}/layers_lin.npz", far=far_d.astype(np.float16), mid=result["mid"][0].astype(np.float16), mida=result["mid"][1].astype(np.float16),
                    near=result["near"][0].astype(np.float16), neara=result["near"][1].astype(np.float16))

# ----- composite check + previews -----
if len(result) == 3:
    def box2(x):
        x = x[:x.shape[0] // 2 * 2]
        return (x[0::2, 0::2] + x[1::2, 0::2] + x[0::2, 1::2] + x[1::2, 1::2]) / 4
    far2 = box2(far_d); mid, ma = result["mid"]; near, na = result["near"]
    if far2.shape[0] < mid.shape[0]: far2 = np.pad(far2, ((0, mid.shape[0] - far2.shape[0]), (0, 0), (0, 0)), mode='edge')
    comp = near * na[..., None] + (1 - na[..., None]) * (mid * ma[..., None] + (1 - ma[..., None]) * far2)
    os.makedirs(f"{out}/previews", exist_ok=True)
    save_png(f"{out}/previews/composite.png", to8(comp))
    def sample(img, az, el):
        hh, ww = img.shape[:2]
        px = (az + 180) / 360 * ww - 0.5; py = (EL_MAX - el) / (EL_MAX - EL_MIN) * hh - 0.5
        x0 = np.floor(px).astype(int); y0 = np.floor(py).astype(int); fx = (px - x0)[..., None]; fy = (py - y0)[..., None]
        y0c = np.clip(y0, 0, hh - 1); y1c = np.clip(y0 + 1, 0, hh - 1)
        g = lambda yy, xx: img[yy, xx % ww]
        return (g(y0c, x0) * (1 - fx) + g(y0c, x0 + 1) * fx) * (1 - fy) + (g(y1c, x0) * (1 - fx) + g(y1c, x0 + 1) * fx) * fy
    def view(yaw, w=1600, h=900, hfov=75.0):
        u = (np.arange(w) + 0.5) / w * 2 - 1; v = 1 - (np.arange(h) + 0.5) / h * 2
        tx = math.tan(math.radians(hfov / 2)); X, Y = np.meshgrid(u * tx, v * tx * h / w)
        az = yaw + np.degrees(np.arctan2(X, 1.0)); el = np.degrees(np.arctan2(Y, np.hypot(X, 1.0)))
        az = (az + 180) % 360 - 180
        c = sample(far_d, az, el)
        for img, al in ((mid, ma), (near, na)):
            a_ = sample(al[..., None], az, el); c = sample(img, az, el) * a_ + (1 - a_) * c
        return c
    for nm, yaw in (("main_view", 0), ("left_view", -90), ("right_view", 90)):
        save_png(f"{out}/previews/{nm}.png", to8(view(yaw)))
