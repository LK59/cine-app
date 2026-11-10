# Numerical viewpoint search on the DEM mosaic. Run in the immersion-blender image.
# Looks for a spot at 1500-2100 m whose view (+-37 deg around a heading) plunges into a deep valley
# and faces a high snowy skyline 4-15 km away. Prints the best candidates.
import numpy as np, json
LAT_RANGE = (45.80, 46.10); LON_RANGE = (6.60, 7.20)
ALT_RANGE = (1500, 2100); HEAD_STEP = 10; CONE = 37; CAM_H = 4.0
m = json.load(open("assets-src/panorama/mosaic.json")); Z = np.load("assets-src/panorama/mosaic.npy")
N = m["n"]; LAT_TOP = m["lat0"] + m["nlat"]; LON_L = m["lon0"]
R = 6371000.0; MLAT = np.pi / 180 * R
def sample(lat, lon):
    r = (LAT_TOP - lat) * N - 0.5; c = (lon - LON_L) * N - 0.5
    r0 = np.floor(r).astype(int); c0 = np.floor(c).astype(int); fr = r - r0; fc = c - c0
    return (Z[r0, c0] * (1-fr)*(1-fc) + Z[r0, c0+1] * (1-fr)*fc + Z[r0+1, c0] * fr*(1-fc) + Z[r0+1, c0+1] * fr*fc)
def profile(lat, lon, az, dists):
    a = np.radians(az)
    la = lat + dists * np.cos(a) / MLAT
    lo = lon + dists * np.sin(a) / (MLAT * np.cos(np.radians(lat)))
    return sample(la, lo)
dists = np.arange(150, 20000, 60.0)
res = []
for lat in np.arange(*LAT_RANGE, 0.003):
    for lon in np.arange(*LON_RANGE, 0.004):
        z0 = float(sample(np.array([lat]), np.array([lon]))[0])
        if not (ALT_RANGE[0] <= z0 <= ALT_RANGE[1]): continue
        eye = z0 + CAM_H
        azs = np.arange(0, 360, 5)
        P = np.array([profile(lat, lon, a, dists) for a in azs])           # az x dist
        ang = np.degrees(np.arctan2(P - eye, dists[None, :]))              # elevation angle of terrain
        sky = ang.max(1); skyd = dists[ang.argmax(1)]; skyz = P[np.arange(len(azs)), ang.argmax(1)]
        near = (dists > 700) & (dists < 3500)
        plunge = ang[:, near].min(1)                                        # steepest look-down 0.7-3.5 km
        valley = (P[:, near].min(1) - eye)
        # forward cone sanity: no wall within 1.2 km hiding the view (sky ang < 6 deg at < 1.2km)
        wallnear = ang[:, dists < 1200].max(1)
        for h in range(0, 360, HEAD_STEP):
            idx = [i for i, a in enumerate(azs) if abs(((a - h + 180) % 360) - 180) <= CONE]
            s = sky[idx]; d = skyd[idx]; zz = skyz[idx]
            if wallnear[idx].max() > 7: continue
            if valley[idx].mean() > -450: continue
            far_hi = ((d > 3500) & (d < 15000) & (zz > 2800)).mean()
            if far_hi < 0.7: continue
            sc = far_hi * 40 + min(s.mean(), 14) * 3 + min(-valley[idx].mean() / 100, 12) * 2.5 + min(s.max(), 22) * 1.5 + min(np.ptp(zz) / 100, 15)
            res.append((sc, lat, lon, z0, h, s.mean(), s.max(), valley[idx].mean(), d.mean(), zz.mean()))
res.sort(reverse=True)
print("score lat lon alt head skyMean skyMax valleyDepth skyDist skyZ")
for r in res[:25]: print("%.1f %.4f %.4f %.0f %3d %.1f %.1f %.0f %.0f %.0f" % r)
