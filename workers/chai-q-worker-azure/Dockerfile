# Azure Batch image for the research lab worker.
# Base = the exact image AWS Batch runs today (imported from ECR into ACR by digest
# in Phase A4), so ffmpeg/libvmaf/x264/x265 are byte-identical -> same VMAF.
# Only worker.py (DB_LAB line, see AZURE-MIGRATION-PLAN.md P2) and the entrypoint change.
# Build from the repo root:
#   docker build -f workers/chai-q-worker-azure/Dockerfile -t bitraterprodacr.azurecr.io/chai-q-worker-azure:<tag> .
ARG BASE=bitraterprodacr.azurecr.io/chai-q-worker@sha256:398058677769f1815668b36b0056642bf40355c0421c34fb4bdec9363238a430
FROM ${BASE}
COPY research-worker/worker.py /var/task/worker.py
COPY workers/azure_entry.py /var/task/azure_entry.py
ENTRYPOINT []
CMD ["python", "/var/task/azure_entry.py"]
