FROM node:26-bookworm-slim
ARG KTX_VERSION=4.4.2
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libgl1 libvulkan1 libopengl0 \
 && curl -fsSL -o /tmp/ktx.deb "https://github.com/KhronosGroup/KTX-Software/releases/download/v${KTX_VERSION}/KTX-Software-${KTX_VERSION}-Linux-x86_64.deb" \
 && dpkg -i /tmp/ktx.deb || apt-get install -y -f --no-install-recommends \
 && rm -f /tmp/ktx.deb && rm -rf /var/lib/apt/lists/*
ENV LD_LIBRARY_PATH=/usr/local/lib:/usr/lib
RUN mkdir -p /opt/tools && cd /opt/tools && npm init -y >/dev/null \
 && npm install --no-audit --no-fund @gltf-transform/cli@4.5.1 sharp \
 && ln -s /opt/tools/node_modules/.bin/gltf-transform /usr/local/bin/gltf-transform
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core fontconfig && rm -rf /var/lib/apt/lists/*
ENV NODE_PATH=/opt/tools/node_modules
WORKDIR /work
