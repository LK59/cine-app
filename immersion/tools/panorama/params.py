# Shared parameters of the panorama pipeline (imported by render.py and compose.py).
import math
# --- viewpoint (found by tools/panorama/viewpoint.py) ---
LAT, LON = 45.9140, 6.8200       # Flegere shelf, north side of the Chamonix valley
HEADING = 152.0                  # compass heading of the MAIN direction, towards the Mont Blanc massif
CAM_H = 4.0                      # camera height above the terrain (m)
# --- crop of the equirectangular panorama ---
EL_MIN, EL_MAX = -28.0, 32.0
# --- layers: name -> (from_m, to_m, width_px, height_px) ---
LAYERS = {"far": (2500.0, 1e9, 8192, 1366), "mid": (600.0, 2500.0, 4096, 683), "near": (120.0, 600.0, 4096, 683)}
# --- light ---
MOON_AZ, MOON_EL = -35.0, 38.0   # relative to MAIN
MOON_COLOR = (0.72, 0.84, 1.0)   # linear sRGB, cool white-blue
MOON_STRENGTH = 1.7              # Blender sun strength (tuned)
SKY_HORIZON = (0.030, 0.072, 0.170)  # linear sRGB
SKY_ZENITH = (0.0016, 0.0042, 0.0230)
HAZE_COLOR = (0.030, 0.072, 0.170)
AMBIENT = (0.010, 0.024, 0.062)  # world colour seen by the terrain (blue sky ambient)
AMBIENT_STRENGTH = 0.55
# --- exposure of the final tone mapping ---
EXPOSURE = 1.0
# --- geometry ---
TREELINE = 2000.0
MLAT = math.pi / 180 * 6371000.0
