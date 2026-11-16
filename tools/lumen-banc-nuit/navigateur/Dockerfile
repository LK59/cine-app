# Le navigateur du banc de nuit : le WebKit (WPE) de Playwright 1.63, plus le pilote VA-API d'Intel (iHD) pour que
# le greffon `va` de GStreamer 1.24 (déjà dans l'image) puisse décoder par l'iGPU, et les outils GStreamer/VA pour
# vérifier ce qui est réellement choisi. Rien d'autre ne change par rapport à l'image de Playwright.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
RUN sed -i 's/^Components: main restricted$/Components: main restricted multiverse/; s/^Components: main restricted universe$/Components: main restricted universe multiverse/' /etc/apt/sources.list.d/ubuntu.sources \
 && apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends intel-media-va-driver-non-free vainfo gstreamer1.0-tools procps intel-gpu-tools iproute2 ethtool gstreamer1.0-vaapi \
 && rm -rf /var/lib/apt/lists/*
