FROM public.ecr.aws/lambda/python:3.11

RUN yum install -y wget tar xz aws-cli

# Install static ffmpeg + ffprobe (amd64)
RUN wget -q https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz -O /tmp/ffmpeg.tar.xz && \
    tar xf /tmp/ffmpeg.tar.xz -C /tmp && \
    cp /tmp/ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ffmpeg && \
    cp /tmp/ffmpeg-*-amd64-static/ffprobe /usr/local/bin/ffprobe && \
    chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe && \
    rm -rf /tmp/ffmpeg*

WORKDIR /var/task
COPY research-worker/requirements.txt .
RUN pip install -r requirements.txt
COPY research-worker/worker.py .
COPY configs/ ./configs/

# Use Entrypoint for AWS Batch compatibility
ENTRYPOINT ["python", "worker.py"]