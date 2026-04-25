"""Ed25519 URL-prefix signing for Google Cloud Media CDN.

Produces the query-string fragment `URLPrefix=...&Expires=...&KeyName=...&Signature=...`
that the edge validates. Policy format and signing scheme per
https://docs.cloud.google.com/media-cdn/docs/signed-requests.
"""

import base64

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("utf-8")


def _b64url_decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def sign_url_prefix(
    url_prefix: str,
    expires_unix: int,
    key_name: str,
    private_key_b64url: str,
) -> str:
    """Return the signed query-string fragment (no leading '?')."""
    priv_bytes = _b64url_decode(private_key_b64url)
    encoded_prefix = _b64url(url_prefix.encode("utf-8"))
    policy = f"URLPrefix={encoded_prefix}&Expires={expires_unix}&KeyName={key_name}"
    signature = Ed25519PrivateKey.from_private_bytes(priv_bytes).sign(policy.encode("utf-8"))
    return f"{policy}&Signature={_b64url(signature)}"


def strip_existing_signing_params(url_or_line: str) -> str:
    """Remove any `[?&]URLPrefix=...&Expires=...&KeyName=...&Signature=...` suffix.

    Handles both query-start (`?URLPrefix=`) and query-continuation (`&URLPrefix=`)
    placements so the rewrite is idempotent no matter how many times it runs.
    """
    import re

    pattern = r"[?&]URLPrefix=[^&\s\"']+&Expires=\d+&KeyName=[^&\s\"']+&Signature=[^&\s\"']+"
    return re.sub(pattern, "", url_or_line)


def append_signing_params(url: str, qs: str) -> str:
    """Attach signing params to a URL, stripping any prior signing params first."""
    clean = strip_existing_signing_params(url)
    sep = "&" if "?" in clean else "?"
    return f"{clean}{sep}{qs}"
