"""laterna-xray : qui est à l'écran, scène par scène."""

import os

# Les bibliothèques de calcul (OpenBLAS de NumPy/SciPy, OpenMP) lisent ces variables à leur
# chargement : elles doivent être posées avant le premier `import numpy`, sinon chacune prend
# tous les cœurs de la machine en plus des fils d'ONNX Runtime.
_threads = os.environ.get("XRAY_THREADS", "4")
for _var in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, _threads)
