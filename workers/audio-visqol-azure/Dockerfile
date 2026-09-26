# Azure Batch image for the ViSQOL worker. Base = the exact ECR image (digest) AWS runs.
# Build from the repo root:
#   docker build -f workers/audio-visqol-azure/Dockerfile -t bitraterprodacr.azurecr.io/audio-visqol-azure:<tag> .
ARG BASE=bitraterprodacr.azurecr.io/audio-visqol-worker@sha256:0e9e1972f0bb80dca9342f0d0c99a7385177f149d7a276a8207f644c303c51d9
FROM ${BASE}
COPY audio-visqol-worker/worker.py /var/task/worker.py
COPY workers/azure_entry.py /var/task/azure_entry.py
ENTRYPOINT []
CMD ["python", "/var/task/azure_entry.py"]
