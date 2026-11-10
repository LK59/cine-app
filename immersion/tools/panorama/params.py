# Shared parameters of the panorama pipeline (imported by render.py and compose.py).
import math
# --- viewpoint (found by tools/panorama/viewpoint.py) ---
LAT, LON = 45.9140, 6.8200       # Flegere shelf, north side of the Chamonix valley
HEADING = 152.0                  # compass heading of the MAIN direction, towards the Mont Blanc massif
CAM_H = 4.0                      # camera height above the terrain (m)
# --- crop of the equirectangular panorama ---
EL_MIN, EL_MAX = -28.0, 32.0
# --- layers: name -> (from_m, to_m, width_px, height_px) ---
LAYERS = {"far": (2500.0, 1e9, 8192, 1368), "mid": (600.0, 2500.0, 4096, 684), "near": (120.0, 600.0, 4096, 684)}
# --- light ---
MOON_AZ, MOON_EL = -35.0, 38.0   # relative to MAIN
MOON_COLOR = (0.52, 0.72, 1.0)   # linear sRGB, cool white-blue
MOON_STRENGTH = 0.23              # Blender sun strength (tuned)
SKY_HORIZON = (0.008, 0.016, 0.040)  # linear sRGB
SKY_ZENITH = (0.001, 0.002, 0.008)
HAZE_COLOR = (0.006, 0.012, 0.030)
AMBIENT = (0.004, 0.014, 0.075)  # world colour seen by the terrain (blue sky ambient)
AMBIENT_STRENGTH = 0.035
# --- exposure of the final tone mapping ---
EXPOSURE = 1.0
# --- geometry ---
TREELINE = 2000.0
MLAT = math.pi / 180 * 6371000.0
GLOW_POWER = 3.0e5                # Blender watts of the warm point lights that make the town light the snow (Chamonix total)
