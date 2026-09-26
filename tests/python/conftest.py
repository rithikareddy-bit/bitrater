import os

# Some handlers read required env at import time (e.g. gcp_finalize_hls: CDN_BASE).
# Placeholders so tests can import them; never real endpoints.
os.environ.setdefault("CDN_BASE", "https://cdn.test.invalid")
os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")
