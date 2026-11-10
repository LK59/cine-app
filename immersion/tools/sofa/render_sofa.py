"""
Cycles previews of the exported glTF (re-imported, so UVs/normals are checked too).
  blender -b --python tools/sofa/render_sofa.py -- <gltf> <out_dir> [views,comma] [samples]
"""
import sys, os, math
import bpy
from mathutils import Vector

args = sys.argv[sys.argv.index("--") + 1:]
GLTF, OUT = args[0], args[1]
VIEWS = args[2].split(",") if len(args) > 2 else ["front", "three_quarter", "close_cushions", "top"]
SAMPLES = int(args[3]) if len(args) > 3 else 96
RAKING = (args[4] != "flat") if len(args) > 4 else True
os.makedirs(OUT, exist_ok=True)

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=GLTF)
sc = bpy.context.scene
sc.render.engine = "CYCLES"
sc.cycles.device = "CPU"
sc.cycles.samples = SAMPLES
sc.cycles.use_denoising = True
sc.cycles.max_bounces = 6
sc.render.resolution_x = 1600
sc.render.resolution_y = 1000
sc.render.image_settings.file_format = "JPEG"
sc.render.image_settings.quality = 92
sc.view_settings.view_transform = "Filmic" if False else "AgX"
sc.view_settings.look = "AgX - Base Contrast"

# ---- linen-like material: two weave bands + slub noise, world-scale UV
def linen(name, base, scale=240.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    uv = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (scale, scale, 1)
    w1 = nt.nodes.new("ShaderNodeTexWave")
    w1.wave_type = "BANDS"; w1.bands_direction = "X"; w1.inputs["Scale"].default_value = 1.0
    w1.inputs["Distortion"].default_value = 0.6
    w1.inputs["Detail"].default_value = 1.0
    w2 = nt.nodes.new("ShaderNodeTexWave")
    w2.wave_type = "BANDS"; w2.bands_direction = "Y"; w2.inputs["Scale"].default_value = 1.0
    w2.inputs["Distortion"].default_value = 0.6
    mix = nt.nodes.new("ShaderNodeMath"); mix.operation = "MULTIPLY_ADD"
    add = nt.nodes.new("ShaderNodeMath"); add.operation = "ADD"
    nz = nt.nodes.new("ShaderNodeTexNoise"); nz.inputs["Scale"].default_value = 9.0
    mp2 = nt.nodes.new("ShaderNodeMapping"); mp2.inputs["Scale"].default_value = (6, 6, 1)
    bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.2; bump.inputs["Distance"].default_value = 0.002
    cr = nt.nodes.new("ShaderNodeMix"); cr.data_type = "RGBA"
    nt.links.new(uv.outputs["UV"], mp.inputs["Vector"])
    nt.links.new(mp.outputs["Vector"], w1.inputs["Vector"])
    nt.links.new(mp.outputs["Vector"], w2.inputs["Vector"])
    nt.links.new(w1.outputs["Fac"], add.inputs[0]); nt.links.new(w2.outputs["Fac"], add.inputs[1])
    nt.links.new(add.outputs["Value"], bump.inputs["Height"])
    nt.links.new(uv.outputs["UV"], mp2.inputs["Vector"])
    nt.links.new(mp2.outputs["Vector"], nz.inputs["Vector"])
    cr.inputs["Factor"].default_value = 0.35
    cr.inputs["A"].default_value = base
    cr.inputs["B"].default_value = (base[0] * 0.82, base[1] * 0.80, base[2] * 0.76, 1)
    nt.links.new(nz.outputs["Fac"], cr.inputs["Factor"])
    nt.links.new(cr.outputs["Result"], bsdf.inputs["Base Color"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Roughness"].default_value = 0.85
    bsdf.inputs["Sheen Weight"].default_value = 0.35
    bsdf.inputs["Sheen Roughness"].default_value = 0.5
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return m

mats = {
    "sofa_frame": linen("lf", (0.62, 0.52, 0.40, 1)),
    "sofa_cushions": linen("lc", (0.66, 0.56, 0.43, 1)),
    "pillows_a": linen("pa", (0.42, 0.33, 0.25, 1), 300),
    "pillows_b": linen("pb", (0.50, 0.50, 0.46, 1), 300),
    "sofa_legs": linen("ll", (0.1, 0.07, 0.05, 1)),
}
for ob in bpy.data.objects:
    if ob.type == "MESH":
        key = next((k for k in mats if ob.name.startswith(k)), None)
        if key:
            ob.data.materials.clear()
            ob.data.materials.append(mats[key])

# ---- floor, lights
bpy.ops.mesh.primitive_plane_add(size=30, location=(0, 0, 0))
fl = bpy.context.active_object
fm = bpy.data.materials.new("floor"); fm.use_nodes = True
fm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.32, 0.30, 0.28, 1)
fm.node_tree.nodes["Principled BSDF"].inputs["Roughness"].default_value = 0.6
fl.data.materials.append(fm)
# blender frame: sofa centre
cx, cy = -0.55, 1.5      # glTF (x, z) -> blender (x, -z)
def area(loc, size, energy, color, rot=(0, 0, 0)):
    d = bpy.data.lights.new("a", "AREA"); d.size = size; d.energy = energy; d.color = color
    o = bpy.data.objects.new("a", d); o.location = loc; o.rotation_euler = rot
    sc.collection.objects.link(o); return o
area((cx + 1.2, cy, 3.4), 3.0, 700, (1.0, 0.82, 0.62), (0, math.radians(8), 0))
def aim(o, tgt):
    d = Vector(tgt) - o.location
    o.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
# low raking light from the open side: shows creases and folds (glTF (3.2, 0.7, -1.0) -> blender (3.2, 1.0, 0.7))
rk = area((-0.8, -4.6, 0.9), 2.2, 1500 if RAKING else 0, (1.0, 0.9, 0.78))   # from the south, grazing the east-facing surfaces
aim(rk, (-1.0, 1.5, 0.5))
rk2 = area((6.0, cy, 2.2), 4.0, 60, (0.85, 0.9, 1.0))
aim(rk2, (-1.0, cy, 0.4))
w = bpy.data.worlds.new("w"); w.use_nodes = True
w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.35, 0.33, 0.3, 1)
w.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.2
sc.world = w

def cam(loc_gltf, target_gltf, lens=35, ortho=None):
    c = bpy.data.cameras.new("c"); c.lens = lens
    if ortho:
        c.type = "ORTHO"; c.ortho_scale = ortho
    o = bpy.data.objects.new("c", c); sc.collection.objects.link(o)
    o.location = (loc_gltf[0], -loc_gltf[2], loc_gltf[1])
    t = Vector((target_gltf[0], -target_gltf[2], target_gltf[1]))
    d = t - o.location
    o.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    sc.camera = o
    return o

VIEWDEF = {
    "front": dict(loc=(6.4, 1.6, -1.5), tgt=(-1.0, 0.5, -1.5), lens=30),
    "three_quarter": dict(loc=(5.0, 3.0, 5.2), tgt=(-0.5, 0.35, -1.5), lens=32),
    "close_cushions": dict(loc=(0.15, 1.15, -1.55), tgt=(-2.05, 0.55, -1.7), lens=40),
    "close2": dict(loc=(2.6, 1.3, 1.6), tgt=(0.2, 0.45, -0.1), lens=40),
    "plaid": dict(loc=(-0.2, 1.35, -1.6), tgt=(-2.0, 0.55, -2.8), lens=45),
    "plaid2": dict(loc=(-4.2, 1.5, -2.8), tgt=(-2.4, 0.5, -2.8), lens=40),
    "pillow": dict(loc=(-0.55, 0.95, -0.3), tgt=(-2.0, 0.65, -0.55), lens=50),
    "top": dict(loc=(-0.55, 9.0, -1.5), tgt=(-0.55, 0, -1.5), lens=50, ortho=7.4),
}
grid = []
for name in VIEWS:
    for o in grid:
        bpy.data.objects.remove(o)
    grid = []
    v = VIEWDEF[name]
    cam(v["loc"], v["tgt"], v["lens"], v.get("ortho"))
    if name == "top":
        sc.render.resolution_x = 1400; sc.render.resolution_y = 1400
        gm = bpy.data.materials.new("g"); gm.use_nodes = True
        gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0, 0, 0, 1)
        gm.node_tree.nodes["Principled BSDF"].inputs["Emission Strength"].default_value = 0.0
        for gx in range(-3, 3):
            bpy.ops.mesh.primitive_cube_add(size=1, location=(gx, 1.5, 1.4), scale=(0.008, 6.0, 0.002)); grid.append(bpy.context.active_object)
        for gz in range(-4, 2):
            bpy.ops.mesh.primitive_cube_add(size=1, location=(-0.5, -gz, 1.4), scale=(6.0, 0.008, 0.002)); grid.append(bpy.context.active_object)
        for o in grid:
            o.data.materials.append(gm)
    else:
        sc.render.resolution_x = 1600; sc.render.resolution_y = 1000
    sc.render.filepath = os.path.join(OUT, name + ".jpg")
    bpy.ops.render.render(write_still=True)
    print("RENDERED", sc.render.filepath)
