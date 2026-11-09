FROM laterna-xray:local
USER root
RUN pip install --no-cache-dir torch==2.9.1 --index-url https://download.pytorch.org/whl/cpu && pip install --no-cache-dir python_speech_features==0.6
USER 10001
