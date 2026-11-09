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
