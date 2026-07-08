"""Ed25519 full-path signing for Google Cloud Media CDN.

Produces the query-string fragment `Expires=...&KeyName=...&Signature=...` that
the edge validates against the exact request URL (no `URLPrefix` — that variant
scopes the token to an entire directory, which is broader than intended here:
only the single combined-master file should be authorized). Policy format and
signing scheme per https://docs.cloud.google.com/media-cdn/docs/generate-signatures.
"""

import base64

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def _b64url(data: bytes) -> str:
    """Web-safe base64, no padding — Media CDN requires unpadded encoding
    for both URLPrefix and Signature (docs.cloud.google.com/media-cdn/docs/generate-signatures)."""
    return base64.urlsafe_b64encode(data).decode("utf-8").rstrip("=")


def _b64url_decode(text: str) -> bytes:
    padding = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + padding)


def sign_url(
    url: str,
    expires_unix: int,
    key_name: str,
    private_key_b64url: str,
) -> str:
    """Return the signed query-string fragment (no leading '?').

    Full-path signing: the string-to-sign is the request URL itself with
    `Expires`/`KeyName` appended (`{url}?Expires=..&KeyName=..`), so the token
    authorizes exactly that URL. NOTE: any query params already present on `url`
    become part of the signed value, so callers MUST pass the canonical
    (param-free) combined-master URL — which they do.
    """
    priv_bytes = _b64url_decode(private_key_b64url)
    sep = "&" if "?" in url else "?"
    policy = f"Expires={expires_unix}&KeyName={key_name}"
    to_sign = f"{url}{sep}{policy}"
    signature = Ed25519PrivateKey.from_private_bytes(priv_bytes).sign(to_sign.encode("utf-8"))
    return f"{policy}&Signature={_b64url(signature)}"


def strip_existing_signing_params(url_or_line: str) -> str:
    """Remove any signing params (`URLPrefix`, `Expires`, `KeyName`, `Signature`)
    from a URL or manifest line, in ANY order/position, preserving other query
    params and correct `?`/`&` separators.

    Order-agnostic so it stays idempotent whether the URL carries the legacy
    URLPrefix-style token, the current full-path token, or (defensively) params
    in an unexpected order.
    """
    import re

    for key in ("URLPrefix", "Expires", "KeyName", "Signature"):
        # `?key=val&` (first param, more follow) → keep the `?`
        url_or_line = re.sub(rf"\?{key}=[^&\s\"']*&", "?", url_or_line)
        # `&key=val`  (any non-first param) → drop it
        url_or_line = re.sub(rf"&{key}=[^&\s\"']*", "", url_or_line)
        # `?key=val`  (sole/last param) → drop it and the `?`
        url_or_line = re.sub(rf"\?{key}=[^&\s\"']*", "", url_or_line)
    return url_or_line


def append_signing_params(url: str, qs: str) -> str:
    """Attach signing params to a URL, stripping any prior signing params first."""
    clean = strip_existing_signing_params(url)
    sep = "&" if "?" in clean else "?"
    return f"{clean}{sep}{qs}"
