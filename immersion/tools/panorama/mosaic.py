# Mosaic Copernicus GLO-30 tiles into one float32 array (run inside the immersion-blender image).
# Output: assets-src/panorama/mosaic.npy (rows north->south, cols west->east) + mosaic.json
import numpy as np, tifffile, json, os
DEM = "assets-src/panorama/dem"
LAT0, LON0, NLAT, NLON = 45, 6, 2, 2          # south-west tile corner, tile counts
N = 3600                                        # pixels per 1 degree tile at lat < 50
out = np.zeros((NLAT * N, NLON * N), np.float32)
for i in range(NLAT):
    for j in range(NLON):
        lat, lon = LAT0 + i, LON0 + j
        f = f"{DEM}/Copernicus_DSM_COG_10_N{lat:02d}_00_E{lon:03d}_00_DEM.tif"
        a = tifffile.imread(f).astype(np.float32)
        assert a.shape == (N, N), a.shape
        r0 = (NLAT - 1 - i) * N
        out[r0:r0 + N, j * N:(j + 1) * N] = a
        print(f, a.min(), a.max(), flush=True)
np.save("assets-src/panorama/mosaic.npy", out)
# pixel (r,c) centre: lat = LAT0+NLAT - (r+0.5)/N, lon = LON0 + (c+0.5)/N  (tile edge = pixel edge, see AWS readme)
json.dump({"lat0": LAT0, "lon0": LON0, "nlat": NLAT, "nlon": NLON, "n": N}, open("assets-src/panorama/mosaic.json", "w"))
