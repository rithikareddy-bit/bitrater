import json, base64, subprocess
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

def norm(b64):
    b64 = (b64 or "").strip()
    pad = "=" * (-len(b64) % 4)
    try:
        return base64.urlsafe_b64decode(b64 + pad)
    except Exception:
        return base64.b64decode(b64 + pad)

# 1) private key + key_name from AWS Secrets Manager
sec = json.loads(subprocess.check_output([
    "aws",
    "secretsmanager",
    "get-secret-value",
    "--secret-id",
    "chai-q/media-cdn-signing-key",
    "--query",
    "SecretString",
    "--output",
    "text"
]))

key_name = sec["key_name"]
priv = Ed25519PrivateKey.from_private_bytes(norm(sec["private_key_b64url"]))
pub_raw = priv.public_key().public_bytes(
    serialization.Encoding.Raw,
    serialization.PublicFormat.Raw,
)

# 2) public keys registered in the GCP keyset
ks = json.loads(subprocess.check_output([
    "gcloud",
    "edge-cache",
    "keysets",
    "describe",
    "chaishots-playback-keyset",
    "--project=media-cdn-poc-466009",
    "--format=json"
]))

keys = [(p.get("id"), p.get("value")) for p in ks.get("publicKeys", [])]

# 3) compare raw bytes
match = any(pub_raw == norm(v) for _, v in keys if v)

print("key_name in secret        :", key_name)
print("key_name == expected short:", key_name == "chaishots-playback-keyset")
print("keyset public key ids     :", [i for i, _ in keys])
print("PRIVATE KEY ↔ KEYSET      :", "MATCH ✅" if match else "MISMATCH ❌  (would 403 everything)")
