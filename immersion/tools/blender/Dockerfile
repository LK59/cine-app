# Shared headless Blender (LTS) image: tag immersion-blender
FROM debian:bookworm-slim
ARG BLENDER_VERSION=4.5.16
ARG BLENDER_SHA256=23432b064977908beb1ab4b7f32f024e7331105c875c187dce002aff84b10c11
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils libgl1 libegl1 libxrender1 libxi6 libxkbcommon0 \
      libxxf86vm1 libxfixes3 libsm6 libice6 libx11-6 libxext6 libgomp1 libsndfile1 \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o /tmp/b.tar.xz "https://download.blender.org/release/Blender4.5/blender-${BLENDER_VERSION}-linux-x64.tar.xz" \
 && echo "${BLENDER_SHA256}  /tmp/b.tar.xz" | sha256sum -c - \
 && mkdir /opt/blender && tar -xJf /tmp/b.tar.xz -C /opt/blender --strip-components=1 \
 && rm /tmp/b.tar.xz && ln -s /opt/blender/blender /usr/local/bin/blender
# GeoTIFF reading inside Blender's own Python (numpy is bundled)
RUN /opt/blender/4.5/python/bin/python3.11 -m ensurepip \
 && /opt/blender/4.5/python/bin/python3.11 -m pip install --no-cache-dir --no-warn-script-location tifffile==2025.10.16 imagecodecs==2025.8.2
ENV HOME=/tmp
WORKDIR /work
ENTRYPOINT ["blender"]
