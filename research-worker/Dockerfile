FROM public.ecr.aws/lambda/python:3.11

# Add AWS CLI to pull S3 files
RUN yum install -y ffmpeg wget tar xz aws-cli

# Install static VMAF binary
RUN wget https://github.com/Netflix/vmaf/releases/download/v2.3.1/vmaf -O /usr/local/bin/vmaf && \
    chmod +x /usr/local/bin/vmaf

WORKDIR /var/task
COPY research-worker/requirements.txt .
RUN pip install -r requirements.txt
COPY research-worker/worker.py .
COPY configs/ ./configs/

# Use Entrypoint for AWS Batch compatibility
ENTRYPOINT ["python", "worker.py"]