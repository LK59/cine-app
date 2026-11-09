"""INT8 post-entraînement (NNCF) de det_10g et w600k_r50, calibrés sur des images de la médiathèque.
usage : python quant.py MODELS_DIR CALIB_DIR [preset]"""
import sys, numpy as np, openvino as ov, nncf
md, cd = sys.argv[1], sys.argv[2]
preset = sys.argv[3] if len(sys.argv) > 3 else "mixed"
P = {"mixed": nncf.QuantizationPreset.MIXED, "performance": nncf.QuantizationPreset.PERFORMANCE}[preset]
core = ov.Core()
det = np.load(f"{cd}/det.npy"); emb = np.load(f"{cd}/emb.npy")
print("calibrage", det.shape, emb.shape, flush=True)
m = core.read_model(f"{md}/det_10g.onnx")
m.reshape({m.inputs[0]: [1, 3, -1, -1]})
q = nncf.quantize(m, nncf.Dataset([det[i:i + 1] for i in range(len(det))]), preset=P, subset_size=len(det))
ov.save_model(q, f"{md}/det_10g_int8_{preset}.xml", compress_to_fp16=False)
m = core.read_model(f"{md}/w600k_r50.onnx")
m.reshape({m.inputs[0]: [-1, 3, 112, 112]})
q = nncf.quantize(m, nncf.Dataset([emb[i:i + 8] for i in range(0, len(emb), 8)]), preset=P, subset_size=len(emb) // 8 + 1)
ov.save_model(q, f"{md}/w600k_r50_int8_{preset}.xml", compress_to_fp16=False)
print("ok")
