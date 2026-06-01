# ── Stage 1: build ViSQOL from source (Bazel) ───────────────────────────────────────────────
# ViSQOL has no official prebuilt binary, so we build it once here and copy the artifact into
# the slim runtime stage. Pinned to a known-good tag; bazelisk honors the repo's .bazelversion.
# (This stage is the heavy/fragile part — see AUDIO-QUALITY-CHECK-PLAN.md Gap G4.)
FROM ubuntu:22.04 AS visqol-build

ARG VISQOL_REF=v3.3.3
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        git curl ca-certificates build-essential python3 python3-dev python3-numpy \
    && rm -rf /var/lib/apt/lists/*

# bazelisk → picks the Bazel version ViSQOL pins in .bazelversion. TARGETARCH (amd64|arm64) is
# set by buildx so the same Dockerfile builds for Batch (amd64) and a local Mac (arm64).
RUN curl -fsSL -o /usr/local/bin/bazel \
        https://github.com/bazelbuild/bazelisk/releases/download/v1.19.0/bazelisk-linux-${TARGETARCH} \
    && chmod +x /usr/local/bin/bazel

RUN git clone --depth 1 --branch ${VISQOL_REF} https://github.com/google/visqol.git /visqol
WORKDIR /visqol
# Dependency-rot fix: ViSQOL's WORKSPACE fetches armadillo-9.860.2 from a SourceForge URL that
# now 404s (old versions get purged from SF). Repoint it at the MacPorts distfiles mirror, which
# serves the byte-identical tarball (sha256 d856ea58… — unchanged, so the pinned hash still
# verifies). armadillo is the only dead URL in the WORKSPACE; the rest resolve fine.
RUN sed -i \
    's#http://sourceforge.net/projects/arma/files/armadillo-9.860.2.tar.xz#https://distfiles.macports.org/armadillo/armadillo-9.860.2.tar.xz#' \
    WORKSPACE
# ViSQOL v3.3.3 is a WORKSPACE-era project (README: "tested with Bazel 3.4.1"). Modern Bazel
# (7+) enables bzlmod and drops the implicit proto_library/cc_proto_library rules its BUILD
# uses, so bazelisk must be pinned to an old, WORKSPACE-default Bazel that still has arm64
# binaries. 5.3.2 satisfies both.
ENV USE_BAZEL_VERSION=5.3.2
RUN bazel build -c opt //:visqol

# ── Stage 2: runtime (python + static ffmpeg + ViSQOL) ───────────────────────────────────────
FROM python:3.11-slim

ARG TARGETARCH

# curl + xz to fetch ffmpeg; libgomp1/libstdc++ for the ViSQOL C++ binary built above.
# (python:3.11-slim ships neither curl nor xz, so install them before the ffmpeg download.)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Static ffmpeg + ffprobe (johnvansickle; arch-matched via TARGETARCH: amd64|arm64)
RUN curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${TARGETARCH}-static.tar.xz \
        -o /tmp/ffmpeg.tar.xz \
    && tar xf /tmp/ffmpeg.tar.xz -C /tmp \
    && cp /tmp/ffmpeg-*-${TARGETARCH}-static/ffmpeg /usr/local/bin/ffmpeg \
    && cp /tmp/ffmpeg-*-${TARGETARCH}-static/ffprobe /usr/local/bin/ffprobe \
    && chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe \
    && rm -rf /tmp/ffmpeg*

# ViSQOL binary + its runfiles (kept adjacent so default model lookup works) + an explicit
# model path we pass via VISQOL_MODEL (belt and suspenders against runfiles resolution).
COPY --from=visqol-build /visqol/bazel-bin/visqol            /opt/visqol/visqol
COPY --from=visqol-build /visqol/bazel-bin/visqol.runfiles   /opt/visqol/visqol.runfiles
COPY --from=visqol-build /visqol/model                       /opt/visqol/model
ENV VISQOL_BIN=/opt/visqol/visqol \
    VISQOL_MODEL=/opt/visqol/model/libsvm_nu_svr_model.txt

WORKDIR /var/task
COPY audio-visqol-worker/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY audio-visqol-worker/worker.py .

# AWS Batch runs the container; env (EPISODE_ID, MASTER_URL, SOURCE_URL, MONGO_URI, ...) is
# supplied via containerOverrides. ENTRYPOINT mirrors research-worker for Batch compatibility.
ENTRYPOINT ["python", "worker.py"]
