# Image IO helpers (run inside Blender's Python): EXR -> numpy, numpy -> PNG (stdlib zlib).
import bpy, numpy as np, zlib, struct
def load_exr(path):
    im = bpy.data.images.load(path); im.colorspace_settings.name = "Non-Color"
    w, h = im.size; a = np.empty(w * h * 4, np.float32); im.pixels.foreach_get(a)
    bpy.data.images.remove(im)
    return a.reshape(h, w, 4)[::-1].copy()          # top row first
def save_png(path, a8):
    h, w, c = a8.shape; ct = {3: 2, 4: 6}[c]
    raw = b"".join(b"\x00" + a8[y].tobytes() for y in range(h))
    def ch(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    open(path, "wb").write(b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, ct, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw, 6)) + ch(b"IEND", b""))
