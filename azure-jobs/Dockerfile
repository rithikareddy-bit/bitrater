# Scheduled jobs: resigner, url-health, Durable watchdog and Batch task cleanup.
# Build from the repo root:  docker build -f azure-jobs/Dockerfile -t bitrater-jobs .
FROM python:3.11-slim

WORKDIR /app
COPY requirements-lambda.txt /tmp/requirements-lambda.txt
RUN pip install --no-cache-dir -r /tmp/requirements-lambda.txt \
      azure-identity==1.25.3 azure-keyvault-secrets==4.11.2 azure-batch==15.1.0

COPY orchestrator/*.py /app/
COPY azure-jobs/run_job.py /app/run_job.py

ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "/app/run_job.py"]
