# syntax=docker/dockerfile:1
#
# laterna-xray. Aucun poids de modèle dans l'image : ils sont téléchargés au premier démarrage
# dans le volume de données (voir README, « Modèles et licences »).

ARG PYTHON_IMAGE=python:3.12-slim-bookworm

# --- dépendances Python, installées à part pour ne pas emporter pip et ses caches -----------
FROM ${PYTHON_IMAGE} AS deps
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --prefix=/install -r /tmp/requirements.txt
# OpenVINO (inférence sur le processeur, plus rapide qu'ONNX Runtime ici — voir README,
# « Performances ») sans ses dépendances : numpy et packaging sont déjà là, et son paquet de
# télémétrie (`openvino-telemetry`) ne sert qu'aux outils de conversion — rien ne sort de la machine.
ARG OPENVINO=openvino==2026.4.1
RUN pip install --no-cache-dir --no-deps --prefix=/install "${OPENVINO}"
# NNCF, pour quantifier le détecteur en INT8 sur place au premier démarrage (`app/quantize.py`),
# avec les seules dépendances que sa quantification post-entraînement d'OpenVINO importe : ni
# scikit-learn, ni pydot, ni ninja, ni `openvino-telemetry` (sans lui, la télémétrie de NNCF ne
# fait rien — rien ne sort de la machine). ~35 Mo.
ARG NNCF="nncf==3.4.0 networkx==3.6.1 psutil==7.2.2 rich==15.0.0 markdown-it-py==4.2.0 mdurl==0.1.2 pygments==2.21.0 safetensors==0.8.0 tabulate==0.10.0"
RUN pip install --no-cache-dir --no-deps --prefix=/install ${NNCF}

# --- pilote de calcul Intel (OpenCL) pour l'inférence sur l'iGPU, en option -------------------
# Branche « legacy1 » 24.35 du compute-runtime et son compilateur IGC : la dernière qui prend en
# charge les iGPU Gen9 à Gen11 (Skylake à Ice Lake, dont l'UHD 630). Paquets pris aux
# publications GitHub d'Intel, vérifiés par leur SHA-256. `GPU_RUNTIME=0` les laisse dehors.
FROM ${PYTHON_IMAGE} AS gpu-debs
ARG GPU_RUNTIME=1
RUN set -eux; mkdir /debs; \
    if [ "${GPU_RUNTIME}" = "1" ]; then \
      apt-get update; apt-get install -y --no-install-recommends ca-certificates curl; cd /debs; \
      IGC=https://github.com/intel/intel-graphics-compiler/releases/download/igc-1.0.17537.24; \
      NEO=https://github.com/intel/compute-runtime/releases/download/24.35.30872.36; \
      curl -fsSLO "$IGC/intel-igc-core_1.0.17537.24_amd64.deb"; \
      curl -fsSLO "$IGC/intel-igc-opencl_1.0.17537.24_amd64.deb"; \
      curl -fsSLO "$NEO/intel-opencl-icd-legacy1_24.35.30872.36_amd64.deb"; \
      curl -fsSLO "$NEO/libigdgmm12_22.5.0_amd64.deb"; \
      printf '%s\n' \
        "c1e1ecdfe2064c047c552651cfdcdafc504f2033afafba65654338b880048b67  intel-igc-core_1.0.17537.24_amd64.deb" \
        "dd016400f87fa2b6a9fa9fbcca7eb4a2629174a29de679709f9bec5cede88b0e  intel-igc-opencl_1.0.17537.24_amd64.deb" \
        "bbe71e4f414259e06a10cde72c29a2bd78d41b2bb2f6f8463b1806797fe66e85  intel-opencl-icd-legacy1_24.35.30872.36_amd64.deb" \
        "cc29d14df83cff1b3c6a66baa39257f0211b168ab43a99c2dc62a3734431bc23  libigdgmm12_22.5.0_amd64.deb" \
        | sha256sum -c -; \
    fi

# --- base d'exécution : Python + ffmpeg de Jellyfin --------------------------------------------
FROM ${PYTHON_IMAGE} AS runtime
# jellyfin-ffmpeg : la version de ffmpeg que Jellyfin livre et éprouve sur les iGPU Intel, avec
# son propre pilote VA-API iHD (rien à installer à côté). Le dépôt est ajouté, le paquet
# installé, puis curl et gnupg repartent.
ARG JELLYFIN_FFMPEG=jellyfin-ffmpeg8
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    install -d -m 0755 /etc/apt/keyrings; \
    curl -fsSL https://repo.jellyfin.org/jellyfin_team.gpg.key | gpg --dearmor -o /etc/apt/keyrings/jellyfin.gpg; \
    echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/jellyfin.gpg] https://repo.jellyfin.org/debian bookworm main" > /etc/apt/sources.list.d/jellyfin.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends "${JELLYFIN_FFMPEG}"; \
    apt-get purge -y --auto-remove curl gnupg; \
    rm -rf /var/lib/apt/lists/*; \
    /usr/lib/jellyfin-ffmpeg/ffmpeg -hide_banner -version | head -n 1
# Le pilote de calcul, monté le temps de l'installation (les .deb ne restent dans aucune couche).
# `libopencl-clang.so` est livré en deux copies identiques de 134 Mo : l'une devient un lien.
RUN --mount=type=bind,from=gpu-debs,source=/debs,target=/tmp/debs set -eux; \
    if ls /tmp/debs/*.deb >/dev/null 2>&1; then \
      apt-get update; \
      apt-get install -y --no-install-recommends ocl-icd-libopencl1 /tmp/debs/*.deb; \
      rm -rf /var/lib/apt/lists/*; \
      if [ -f /usr/local/lib/libopencl-clang.so.14 ] && cmp -s /usr/local/lib/libopencl-clang.so /usr/local/lib/libopencl-clang.so.14; then \
        ln -sf libopencl-clang.so.14 /usr/local/lib/libopencl-clang.so; \
      fi; \
      ldconfig; \
    fi
COPY --from=deps /install /usr/local
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    XRAY_FFMPEG=/usr/lib/jellyfin-ffmpeg/ffmpeg \
    XRAY_FFPROBE=/usr/lib/jellyfin-ffmpeg/ffprobe \
    XRAY_DATA_DIR=/data \
    XRAY_MEDIA_ROOT=/media
WORKDIR /srv
# Lisible par tous : les fichiers du dépôt peuvent arriver en 0660 selon l'umask de qui construit.
COPY --chmod=0755 app ./app

# --- tests : la construction échoue si l'un d'eux échoue ---------------------------------------
FROM runtime AS test
COPY requirements-test.txt /tmp/requirements-test.txt
RUN pip install --no-cache-dir -r /tmp/requirements-test.txt
COPY tests ./tests
COPY pytest.ini ./
RUN python -m pytest -q -p no:cacheprovider && touch /tests-ok

# --- image finale ------------------------------------------------------------------------------
FROM runtime
# Rien n'est pris de l'étage de test sinon cette marque : elle force BuildKit à l'exécuter.
COPY --from=test /tests-ok /srv/.tests-ok
# Utilisateur sans privilège. L'accès à /dev/dri/renderD128 passe par le groupe « render » de
# l'hôte, ajouté au conteneur par `group_add` (son numéro varie d'une machine à l'autre).
RUN useradd --system --uid 10001 --home-dir /srv --shell /usr/sbin/nologin xray \
    && install -d -o xray -g xray /data
USER xray
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
    CMD ["python", "-c", "import os,sys,urllib.request as u; r=u.Request('http://127.0.0.1:8000/health', headers={'Authorization':'Bearer '+os.environ.get('XRAY_API_KEY','')}); sys.exit(0 if u.urlopen(r, timeout=5).status==200 else 1)"]
# Priorité basse, processeur et disque : l'analyse passe après tout le reste de la machine.
# ffmpeg, lancé par le service, en hérite.
CMD ["ionice", "-c", "2", "-n", "7", "nice", "-n", "10", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log", "--no-server-header"]
